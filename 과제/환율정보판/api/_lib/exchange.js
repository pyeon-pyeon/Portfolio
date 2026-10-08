"use strict";

// 서버에서만 사용하는 공통 파일입니다.
// HTML의 script 태그로 연결하지 마세요.

const API_BASE = "https://api.frankfurter.dev/v2";
const SOURCE_URL = "https://frankfurter.dev/";
const TABLE = "exchange_daily_records";

const CURRENCIES = ["USD", "EUR", "JPY", "CNY", "GBP", "AUD"];

// AUD 추가 이전에 저장된 과거 행에는 이 통화의 값이 없습니다.
// 읽을 때만 "전부 없음"을 허용하고, 새로 조회·저장하는 기록은
// 반드시 모든 통화가 있어야 합니다.
const LEGACY_OPTIONAL = ["AUD"];

const UNITS = {
  USD: 1,
  EUR: 1,
  JPY: 100,
  CNY: 1,
  GBP: 1,
  AUD: 1,
};

const COLUMNS = [
  "record_date",
  "received_at",
  "source_url",
  "source_dates",
  "usd_krw",
  "eur_krw",
  "jpy_100_krw",
  "cny_krw",
  "gbp_krw",
  "aud_krw",
  "raw_response",
  "updated_at",
].join(",");

// ============================================================
// 안전한 오류
// 외부 응답 본문이나 비밀키는 오류 메시지에 포함하지 않음
// ============================================================
class ExchangeError extends Error {
  constructor(code, message, status = 502, retrySeconds = null) {
    super(message);
    this.name = "ExchangeError";
    this.code = code;
    this.status = status;
    this.retrySeconds = retrySeconds;
  }
}

// ============================================================
// 날짜·응답 검증
// ============================================================
function kstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type) =>
    parts.find((part) => part.type === type).value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validateRate(raw, currency, today) {
  if (
    !raw ||
    raw.base !== currency ||
    raw.quote !== "KRW" ||
    !validDate(raw.date) ||
    raw.date > today ||
    !Number.isFinite(raw.rate) ||
    raw.rate <= 0
  ) {
    throw new ExchangeError(
      "schema",
      "원천 응답의 형식이나 환율 값이 올바르지 않습니다."
    );
  }

  return {
    date: raw.date,
    base: raw.base,
    quote: raw.quote,
    rate: raw.rate,
  };
}

function retryAfterSeconds(value) {
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : null;
  }

  const time = Date.parse(value);

  return Number.isFinite(time)
    ? Math.max(0, Math.ceil((time - Date.now()) / 1000))
    : null;
}

// ============================================================
// 실제 환율 조회
// 여섯 통화가 모두 정상일 때만 기록 반환
// ============================================================
async function collectRates() {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10000);

  try {
    const responses = await Promise.all(
      CURRENCIES.map(async (currency) => {
        const response = await fetch(
          `${API_BASE}/rate/${currency.toLowerCase()}/krw`,
          {
            signal: controller.signal,
            cache: "no-store",
          }
        );

        if (response.status === 401 || response.status === 403) {
          throw new ExchangeError(
            "unauthorized",
            "외부 환율 원천이 접근을 거부했습니다."
          );
        }

        if (response.status === 429) {
          throw new ExchangeError(
            "rate-limit",
            "외부 환율 원천의 호출 제한에 도달했습니다.",
            429,
            retryAfterSeconds(
              response.headers.get("Retry-After")
            )
          );
        }

        if (!response.ok) {
          throw new ExchangeError(
            "external",
            "외부 환율 원천에서 오류가 발생했습니다."
          );
        }

        let raw;

        try {
          raw = await response.json();
        } catch {
          throw new ExchangeError(
            "schema",
            "외부 환율 응답을 JSON으로 읽을 수 없습니다."
          );
        }

        return { currency, raw };
      })
    );

    // 모든 응답을 받은 시점 기준으로 기록 날짜 확정
    const receivedAt = new Date().toISOString();
    const today = kstDate(new Date(receivedAt));

    const record = {
      kstDate: today,
      receivedAt,
      source: SOURCE_URL,
      rates: {},
      sourceDates: {},
      raw: {},
    };

    for (const { currency, raw } of responses) {
      const validated = validateRate(raw, currency, today);

      record.raw[currency] = validated;
      record.sourceDates[currency] = validated.date;
      record.rates[currency] =
        validated.rate * UNITS[currency];
    }

    validateRecord(record);
    return record;
  } catch (error) {
    if (timedOut) {
      throw new ExchangeError(
        "slow",
        "외부 환율 응답이 제한 시간 안에 도착하지 않았습니다.",
        504
      );
    }

    if (error instanceof ExchangeError) {
      throw error;
    }

    throw new ExchangeError(
      "offline",
      "외부 환율 원천에 연결하지 못했습니다."
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function isMissing(value) {
  return value === undefined || value === null;
}

// allowLegacy가 true이면 LEGACY_OPTIONAL 통화의 원자료·환율·기준일이
// "셋 다 없는" 경우에만 건너뜁니다. 일부만 있거나 값이 잘못된 경우는
// 누락이 아니라 손상이므로 그대로 거부합니다.
function validateRecord(record, { allowLegacy = false } = {}) {
  if (
    !record ||
    record.source !== SOURCE_URL ||
    !validDate(record.kstDate) ||
    typeof record.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(record.receivedAt)) ||
    kstDate(new Date(record.receivedAt)) !== record.kstDate ||
    !record.raw ||
    !record.rates ||
    !record.sourceDates
  ) {
    throw new ExchangeError(
      "schema",
      "환율 기록 형식이 올바르지 않습니다."
    );
  }

  for (const currency of CURRENCIES) {
    if (
      allowLegacy &&
      LEGACY_OPTIONAL.includes(currency) &&
      isMissing(record.raw[currency]) &&
      isMissing(record.rates[currency]) &&
      isMissing(record.sourceDates[currency])
    ) {
      continue;
    }

    const raw = validateRate(
      record.raw[currency],
      currency,
      record.kstDate
    );

    if (
      record.sourceDates[currency] !== raw.date ||
      record.rates[currency] !== raw.rate * UNITS[currency]
    ) {
      throw new ExchangeError(
        "schema",
        "원자료와 저장 환율이 일치하지 않습니다."
      );
    }
  }
}

// ============================================================
// Supabase REST 연결
// ============================================================
function databaseConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !key) {
    throw new ExchangeError(
      "configuration",
      "서버의 DB 환경변수가 설정되지 않았습니다.",
      500
    );
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new ExchangeError(
      "configuration",
      "서버의 DB 주소 설정이 올바르지 않습니다.",
      500
    );
  }

  if (parsed.protocol !== "https:") {
    throw new ExchangeError(
      "configuration",
      "DB 주소는 HTTPS를 사용해야 합니다.",
      500
    );
  }

  return {
    url: url.replace(/\/+$/, ""),
    key,
  };
}

async function databaseRequest(query, options = {}) {
  const { url, key } = databaseConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    ...options.headers,
  };

  // 기존 JWT 형태의 service_role 키도 사용 가능.
  // 새 sb_secret 키는 Authorization에 넣지 않음.
  if (!key.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${key}`;
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/${TABLE}?${query}`,
      {
        ...options,
        headers,
        signal: controller.signal,
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new ExchangeError(
        "storage",
        "DB 조회 또는 저장에 실패했습니다.",
        503
      );
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new ExchangeError(
        "storage",
        "DB 응답 형식이 올바르지 않습니다.",
        503
      );
    }

    return data;
  } catch (error) {
    if (error instanceof ExchangeError) {
      throw error;
    }

    throw new ExchangeError(
      "storage",
      "DB에 연결하거나 응답을 처리하지 못했습니다.",
      503
    );
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 브라우저 기록 형식 ↔ DB 컬럼 변환
// ============================================================
function toDatabaseRow(record) {
  validateRecord(record);

  return {
    record_date: record.kstDate,
    received_at: record.receivedAt,
    source_url: record.source,
    source_dates: record.sourceDates,
    usd_krw: record.rates.USD,
    eur_krw: record.rates.EUR,
    jpy_100_krw: record.rates.JPY,
    cny_krw: record.rates.CNY,
    gbp_krw: record.rates.GBP,
    aud_krw: record.rates.AUD,
    raw_response: record.raw,
    updated_at: new Date().toISOString(),
  };
}

function fromDatabaseRow(row) {
  const rates = {
    USD: Number(row.usd_krw),
    EUR: Number(row.eur_krw),
    JPY: Number(row.jpy_100_krw),
    CNY: Number(row.cny_krw),
    GBP: Number(row.gbp_krw),
  };

  // 과거 행의 aud_krw는 NULL입니다. Number(null)은 0이 되므로
  // NULL일 때는 키 자체를 만들지 않습니다(값을 만들어 채우지 않음).
  // NULL이 아닌 값은 그대로 변환해 손상값이 검증에서 걸러지게 합니다.
  if (!isMissing(row.aud_krw)) {
    rates.AUD = Number(row.aud_krw);
  }

  const record = {
    kstDate: row.record_date,
    receivedAt: row.received_at,
    source: row.source_url,
    sourceDates: row.source_dates,
    rates,
    raw: row.raw_response,
  };

  validateRecord(record, { allowLegacy: true });
  return record;
}

// ============================================================
// 날짜별 저장: 같은 날짜는 갱신
// ============================================================
async function saveDailyRecord(record) {
  const query = new URLSearchParams({
    on_conflict: "record_date",
    select: COLUMNS,
  });

  const rows = await databaseRequest(query.toString(), {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(toDatabaseRow(record)),
  });

  if (rows.length !== 1) {
    throw new ExchangeError(
      "storage",
      "저장한 환율 기록을 확인할 수 없습니다.",
      503
    );
  }

  return fromDatabaseRow(rows[0]);
}

// ============================================================
// 최근 일별 기록 조회
// ============================================================
async function getDailyRecords() {
  const query = new URLSearchParams({
    select: COLUMNS,
    order: "record_date.desc",
    limit: "366",
  });

  const rows = await databaseRequest(query.toString(), {
    method: "GET",
  });

  return rows
    .map(fromDatabaseRow)
    .sort((a, b) => a.kstDate.localeCompare(b.kstDate));
}

// ============================================================
// 서버 API에서 사용할 공개 오류 형식
// ============================================================
function publicError(error) {
  if (error instanceof ExchangeError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retrySeconds: error.retrySeconds,
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal",
        message: "서버 처리 중 오류가 발생했습니다.",
        retrySeconds: null,
      },
    },
  };
}

module.exports = {
  collectRates,
  saveDailyRecord,
  getDailyRecords,
  publicError,
  // 검사용 내부 함수 (API 파일에서는 사용하지 않음)
  _testing: {
    CURRENCIES,
    UNITS,
    validateRecord,
    toDatabaseRow,
    fromDatabaseRow,
  },
};