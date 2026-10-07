"use strict";

(() => {
  // ============================================================
  // 설정
  // ============================================================
  const API_BASE = "https://api.frankfurter.dev/v2";
  const SOURCE_URL = "https://frankfurter.dev/";
  const TIMEOUT_MS = 10000;
  const SERVER_TIMEOUT_MS = 25000;

  const CURRENCIES = ["USD", "EUR", "JPY", "CNY", "GBP"];

  const UNITS = {
    USD: 1,
    EUR: 1,
    JPY: 100,
    CNY: 1,
    GBP: 1,
  };

  const $ = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const refreshButton = $("refresh-button");
  const testButton = $("run-test-button");
  const resetTestButton = $("reset-test-button");
  const scenarioSelect = $("test-scenario");

  // ============================================================
  // 실제 상태와 시험 상태
  // ============================================================
  function createState() {
    return {
      lastNormal: null,
      records: [],
      dataStatus: "none",
      requestStatus: "idle",
      error: "none",
      message: "아직 정상 응답이 없습니다.",
      nextAction: "조회 또는 정상 시험을 실행하세요.",
      attemptAt: null,
      storageMessage: "",
    };
  }

  const realState = createState();
  let testState = createState();

  let realBusy = false;
  let testBusy = false;
  let testSequence = 0;

  // ============================================================
  // 날짜·표시
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

  function previousDate(dateString) {
    const date = new Date(`${dateString}T00:00:00+09:00`);
    date.setUTCDate(date.getUTCDate() - 1);
    return kstDate(date);
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

  function validTime(value) {
    return (
      typeof value === "string" &&
      Number.isFinite(Date.parse(value))
    );
  }

  function formatTime(iso) {
    if (!iso) {
      return "—";
    }

    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(iso)) + " KST";
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ko-KR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  function setLabel(id, text, state) {
    $(id).textContent = text;
    $(id).dataset.state = state;
  }

  // ============================================================
  // 화면 전환
  // ============================================================
  function showScreen(screen) {
    const showReal = screen === "real";

    $("real-screen").hidden = !showReal;
    $("test-screen").hidden = showReal;

    $("open-real-button").setAttribute(
      "aria-pressed",
      String(showReal)
    );

    $("open-test-button").setAttribute(
      "aria-pressed",
      String(!showReal)
    );

    const heading = showReal
      ? $("real-screen-title")
      : $("test-screen-title");

    heading.focus({ preventScroll: true });
    heading.scrollIntoView({
      behavior: "auto",
      block: "start",
    });
  }

  // ============================================================
  // 오류 정의
  // ============================================================
  const ERROR_INFO = {
    slow: {
      message: "제한 시간 안에 응답이 도착하지 않았습니다.",
      action: "잠시 후 다시 조회해 주세요.",
    },
    unauthorized: {
      message: "외부 원천이 접근을 거부했습니다.",
      action: "원천의 접근 정책과 호출 경로를 확인해 주세요.",
    },
    "rate-limit": {
      message: "외부 원천의 호출 제한에 도달했습니다.",
      action: "요청을 반복하지 말고 잠시 기다린 뒤 재시도하세요.",
    },
    offline: {
      message: "서버 또는 외부 원천에 연결하지 못했습니다.",
      action:
        "인터넷 연결을 확인하세요. 연결이 정상이면 " +
        "서버나 외부 원천의 상태를 확인하세요.",
    },
    schema: {
      message: "응답 형식이 바뀌었거나 환율 값이 올바르지 않습니다.",
      action: "원천 응답과 데이터 처리 코드를 확인해 주세요.",
    },
    external: {
      message: "외부 원천에서 서버 오류가 발생했습니다.",
      action: "잠시 후 다시 조회해 주세요.",
    },
    storage: {
      message: "공개 기록 저장소를 조회하거나 저장하지 못했습니다.",
      action:
        "잠시 후 재시도하세요. 계속 실패하면 서버 DB 설정을 확인하세요.",
    },
    configuration: {
      message: "서버의 DB 연결 설정이 완료되지 않았습니다.",
      action: "Vercel 환경변수를 확인하고 재배포해 주세요.",
    },
    internal: {
      message: "서버 처리 중 오류가 발생했습니다.",
      action: "잠시 후 재시도하세요.",
    },
  };

  function failure(code, retrySeconds = null) {
    const error = new Error(code);
    error.code = code;
    error.retrySeconds = retrySeconds;
    return error;
  }

  function parseRetryAfter(value) {
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

  function errorAction(error) {
    const code = Object.hasOwn(ERROR_INFO, error.code)
      ? error.code
      : "internal";

    if (
      code === "rate-limit" &&
      Number.isFinite(error.retrySeconds)
    ) {
      return `${error.retrySeconds}초 뒤 다시 시도하세요.`;
    }

    return ERROR_INFO[code].action;
  }

  // ============================================================
  // 기록 검증・날짜별 병합
  // ============================================================
  function isValidRecord(record) {
    if (
      !record ||
      record.source !== SOURCE_URL ||
      !validDate(record.kstDate) ||
      !validTime(record.receivedAt) ||
      kstDate(new Date(record.receivedAt)) !== record.kstDate ||
      !record.rates ||
      !record.sourceDates ||
      !record.raw
    ) {
      return false;
    }

    return CURRENCIES.every((currency) => {
      const raw = record.raw[currency];

      return (
        raw &&
        raw.base === currency &&
        raw.quote === "KRW" &&
        validDate(raw.date) &&
        raw.date <= record.kstDate &&
        Number.isFinite(raw.rate) &&
        raw.rate > 0 &&
        record.sourceDates[currency] === raw.date &&
        record.rates[currency] === raw.rate * UNITS[currency]
      );
    });
  }

  function makeRecord(responses, receivedAt) {
    const record = {
      kstDate: kstDate(new Date(receivedAt)),
      receivedAt,
      source: SOURCE_URL,
      rates: {},
      sourceDates: {},
      raw: {},
    };

    responses.forEach(({ currency, raw }) => {
      record.rates[currency] = raw.rate * UNITS[currency];
      record.sourceDates[currency] = raw.date;
      record.raw[currency] = raw;
    });

    if (!isValidRecord(record)) {
      throw failure("schema");
    }

    return record;
  }

  function mergeRecord(records, record) {
    const next = records.filter(
      (item) => item.kstDate !== record.kstDate
    );

    next.push(record);
    next.sort((a, b) => a.kstDate.localeCompare(b.kstDate));

    return next.slice(-366);
  }

  // ============================================================
  // 공통 정상・실패 상태 처리
  // 실제 서버 결과와 합성 결과에 함께 사용
  // ============================================================
  function applySuccess(state, record) {
    state.lastNormal = record;
    state.dataStatus = "fresh";
    state.requestStatus = "success";
    state.error = "none";
    state.message =
      "정상 응답을 받았습니다. 원천 기준일을 확인하세요.";
    state.nextAction =
      "원천 기준일은 조회 날짜보다 이전일 수 있습니다.";
  }

  function applyFailure(state, error) {
    const code = Object.hasOwn(ERROR_INFO, error.code)
      ? error.code
      : "internal";

    state.dataStatus = state.lastNormal ? "stale" : "none";
    state.requestStatus = "error";
    state.error = code;

    state.message =
      ERROR_INFO[code].message +
      (state.lastNormal
        ? " 마지막 정상값과 기존 기록을 유지합니다."
        : " 표시할 정상값이 없습니다.");

    state.nextAction = errorAction(error);
  }

  // ============================================================
  // 서버 API 호출
  // 실제 환율 조회와 DB 접근은 서버가 수행
  // ============================================================
  async function callServer(path, method = "GET") {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, SERVER_TIMEOUT_MS);

    try {
      const response = await fetch(path, {
        method,
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      });

      let body;

      try {
        body = await response.json();
      } catch {
        throw failure("schema");
      }

      return {
        ok: response.ok,
        body,
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw failure("slow");
      }

      if (error.code) {
        throw error;
      }

      throw failure("offline");
    } finally {
      clearTimeout(timer);
    }
  }

  function serverError(body) {
    const suppliedCode = body?.error?.code;

    const code =
      typeof suppliedCode === "string" &&
      Object.hasOwn(ERROR_INFO, suppliedCode)
        ? suppliedCode
        : "internal";

    return failure(
      code,
      Number.isFinite(body?.error?.retrySeconds)
        ? body.error.retrySeconds
        : null
    );
  }

  function validateServerRecords(body) {
    if (
      !body ||
      body.storage !== "server" ||
      body.timeZone !== "Asia/Seoul" ||
      !Array.isArray(body.records) ||
      body.records.length > 366 ||
      !body.records.every(isValidRecord) ||
      new Set(
        body.records.map((record) => record.kstDate)
      ).size !== body.records.length
    ) {
      throw failure("schema");
    }

    return [...body.records].sort((a, b) =>
      a.kstDate.localeCompare(b.kstDate)
    );
  }

  async function loadServerRecords() {
    const response = await callServer("/api/rates");

    if (!response.ok) {
      throw serverError(response.body);
    }

    const records = validateServerRecords(response.body);

    // 全件検証後に反映
    realState.records = records;

    return records;
  }

  // ============================================================
  // 실제 화면 표시
  // ============================================================
  function renderReal() {
    const state = realState;
    const record = state.lastNormal;

    const dataLabels = {
      none: "정상 기록 없음",
      fresh: "정상 수신 · 기준일 확인",
      stale: "이전 정상값 표시",
    };

    const requestLabels = {
      idle: "조회 전",
      loading: "조회 중",
      success: "조회 성공",
      error: "조회 실패",
    };

    setLabel(
      "data-status",
      dataLabels[state.dataStatus],
      state.dataStatus
    );

    setLabel(
      "request-status",
      requestLabels[state.requestStatus],
      state.requestStatus === "error"
        ? "error"
        : state.requestStatus === "loading"
          ? "loading"
          : state.dataStatus
    );

    $("attempt-time").textContent = formatTime(state.attemptAt);
    $("request-message").textContent = state.message;
    $("next-action").textContent = state.nextAction;
    $("storage-status").textContent = state.storageMessage;

    if (record) {
      const dates = [
        ...new Set(Object.values(record.sourceDates)),
      ];

      $("source-time").textContent = dates.length === 1
        ? `${dates[0]} · 시각 미제공`
        : CURRENCIES.map((currency) =>
            `${currency}: ${record.sourceDates[currency]}`
          ).join(" / ") + " · 시각 미제공";

      $("received-time").textContent =
        formatTime(record.receivedAt);

      CURRENCIES.forEach((currency) => {
        $(`${currency.toLowerCase()}-rate`).textContent =
          formatNumber(record.rates[currency]);
      });

      $("raw-response").textContent =
        JSON.stringify(record.raw, null, 2);

      const saved = state.records.find(
        (item) => item.kstDate === record.kstDate
      );

      $("stored-record").textContent = saved
        ? JSON.stringify(saved, null, 2)
        : "현재 정상 응답은 아직 저장되지 않았습니다.";
    } else {
      $("source-time").textContent = "—";
      $("received-time").textContent = "—";

      CURRENCIES.forEach((currency) => {
        $(`${currency.toLowerCase()}-rate`).textContent = "—";
      });

      $("raw-response").textContent = "정상 응답 없음";
      $("stored-record").textContent = "저장 기록 없음";
    }

    renderComparison();
    renderHistory();
  }

  function renderComparison() {
    const today = kstDate();
    const yesterday = previousDate(today);

    const todayRecord = realState.records.find(
      (record) => record.kstDate === today
    );

    const yesterdayRecord = realState.records.find(
      (record) => record.kstDate === yesterday
    );

    CURRENCIES.forEach((currency) => {
      const element = $(`${currency.toLowerCase()}-change`);

      element.classList.remove(
        "change-up",
        "change-down",
        "change-flat"
      );

      element.textContent = "비교 기록 없음";
    });

    if (!todayRecord || !yesterdayRecord) {
      $("comparison-info").textContent =
        `${today} 또는 ${yesterday}의 저장 기록이 없어 ` +
        "어제 대비를 계산하지 않습니다.";

      $("calculation-evidence").textContent =
        "오늘과 어제의 실제 저장 기록이 모두 필요합니다.";

      return;
    }

    const evidence = {
      today,
      yesterday,
      currencies: {},
    };

    CURRENCIES.forEach((currency) => {
      const current = todayRecord.rates[currency];
      const previous = yesterdayRecord.rates[currency];
      const difference = current - previous;
      const percent = difference / previous * 100;

      const element = $(`${currency.toLowerCase()}-change`);

      const direction = difference > 0
        ? "상승"
        : difference < 0
          ? "하락"
          : "변동 없음";

      element.textContent =
        `${direction} ${formatNumber(Math.abs(difference))}원 ` +
        `(${formatNumber(Math.abs(percent))}%)`;

      element.classList.add(
        difference > 0
          ? "change-up"
          : difference < 0
            ? "change-down"
            : "change-flat"
      );

      evidence.currencies[currency] = {
        today: current,
        yesterday: previous,
        difference,
        percent,
        formula: "(오늘값 - 어제값) / 어제값 × 100",
      };
    });

    $("comparison-info").textContent =
      `${today}와 ${yesterday}의 실제 저장값을 비교합니다. ` +
      "원천 기준일이 같으면 변동이 없을 수 있습니다.";

    $("calculation-evidence").textContent =
      JSON.stringify(evidence, null, 2);
  }

  function renderHistory() {
    const body = $("history-body");
    body.replaceChildren();

    if (realState.records.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = 8;
      cell.textContent = "아직 실제 기록이 없습니다.";

      row.append(cell);
      body.append(row);
      return;
    }

    [...realState.records].reverse().forEach((record) => {
      const row = document.createElement("tr");

      const dates = [
        ...new Set(Object.values(record.sourceDates)),
      ];

      const sourceDates = dates.length === 1
        ? dates[0]
        : CURRENCIES.map((currency) =>
            `${currency}: ${record.sourceDates[currency]}`
          ).join(" / ");

      const values = [
        record.kstDate,
        sourceDates,
        ...CURRENCIES.map((currency) =>
          formatNumber(record.rates[currency])
        ),
        formatTime(record.receivedAt),
      ];

      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });

      body.append(row);
    });
  }

  // ============================================================
  // 실제 조회・DB 저장
  // ============================================================
  async function refreshReal() {
    if (realBusy || testBusy) {
      return;
    }

    realBusy = true;
    refreshButton.disabled = true;
    testButton.disabled = true;

    realState.attemptAt = new Date().toISOString();
    realState.requestStatus = "loading";
    realState.message = "서버에서 실제 환율을 조회하고 있습니다.";
    realState.nextAction = "조회 중에는 마지막 정상값을 유지합니다.";

    renderReal();

    try {
      const response = await callServer(
        "/api/collect-rates",
        "POST"
      );

      if (!response.ok) {
        const error = serverError(response.body);
        const currentNormal = response.body?.currentNormal;

        // 조회 성공・저장 실패를 구분
        if (currentNormal && isValidRecord(currentNormal)) {
          applySuccess(realState, currentNormal);

          realState.error = error.code;
          realState.requestStatus = "error";
          realState.message =
            "환율 조회는 성공했지만 DB 저장에 실패했습니다.";
          realState.storageMessage =
            "현재 조회값은 미저장 상태입니다. 기존 일별 기록은 유지합니다.";
          realState.nextAction = errorAction(error);
        } else {
          applyFailure(realState, error);

          realState.storageMessage =
            "조회에 실패했습니다. 기존 공개 정상 기록은 유지합니다.";
        }

        return;
      }

      const body = response.body;

      if (
        body.saved !== true ||
        body.storage !== "server" ||
        body.timeZone !== "Asia/Seoul" ||
        !isValidRecord(body.record)
      ) {
        throw failure("schema");
      }

      applySuccess(realState, body.record);

      realState.records = mergeRecord(
        realState.records,
        body.record
      );

      realState.storageMessage =
        "공개 DB에 저장했습니다. 다른 브라우저에서도 조회할 수 있습니다.";

      realState.message =
        "다섯 통화의 정상 환율을 조회하고 저장했습니다.";

      realState.nextAction =
        "다른 실제 KST 날짜에 다시 조회해 두 번째 기록을 남기세요.";

      try {
        await loadServerRecords();
      } catch {
        realState.storageMessage =
          "이번 기록 저장은 성공했지만 전체 기록을 다시 불러오지 못했습니다. " +
          "잠시 후 페이지를 새로고침하세요.";
      }
    } catch (error) {
      applyFailure(realState, error);

      realState.storageMessage =
        "이번 요청의 저장 여부를 확인하지 못했습니다. " +
        "페이지를 새로고침해 서버 기록을 확인하세요.";
    } finally {
      realBusy = false;
      refreshButton.disabled = false;
      testButton.disabled = false;
      renderReal();
    }
  }

  async function initializeReal() {
    realBusy = true;
    refreshButton.disabled = true;
    testButton.disabled = true;

    realState.requestStatus = "loading";
    realState.message = "공개 DB의 기록을 불러오고 있습니다.";
    realState.storageMessage = "서버 기록 조회 중";

    renderReal();

    try {
      const records = await loadServerRecords();

      realState.lastNormal = records.at(-1) || null;
      realState.dataStatus =
        realState.lastNormal ? "stale" : "none";

      realState.requestStatus = "idle";
      realState.error = "none";

      realState.storageMessage =
        "공개 DB의 기록입니다. 다른 브라우저에서도 같은 기록을 조회합니다.";

      realState.message = realState.lastNormal
        ? "저장된 이전 정상값을 불러왔습니다. 현재 조회 결과는 아닙니다."
        : "아직 공개 DB에 저장된 기록이 없습니다.";

      realState.nextAction =
        "실제 환율 조회 버튼으로 새 정상 기록을 저장하세요.";
    } catch (error) {
      applyFailure(realState, error);

      realState.storageMessage =
        "공개 기록을 불러오지 못했습니다.";
    } finally {
      realBusy = false;
      refreshButton.disabled = false;
      testButton.disabled = false;
      renderReal();
    }
  }

  // ============================================================
  // 합성 응답의 HTTP・JSON・환율 검증
  //
  // 서버로 분리한 뒤 실제 원천 검증은 exchange.js가 담당합니다.
  // 아래 함수는 브라우저 합성 검사에서 동일한 검증 규칙을 사용합니다.
  // 서버 exchange.js 자체를 실행하는 통합 검사는 아닙니다.
  // ============================================================
  async function receiveRates(
    transport,
    {
      timeoutMs = TIMEOUT_MS,
      now = () => new Date(),
    } = {}
  ) {
    const controller = new AbortController();
    let timerId;

    const timedOut = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(failure("slow"));
        controller.abort();
      }, timeoutMs);
    });

    const work = Promise.all(
      CURRENCIES.map(async (currency) => {
        const url =
          `${API_BASE}/rate/${currency.toLowerCase()}/krw`;

        let response;

        try {
          response = await transport(url, {
            signal: controller.signal,
            cache: "no-store",
          });
        } catch (error) {
          if (error.code) {
            throw error;
          }

          throw failure("offline");
        }

        if (response.status === 401 || response.status === 403) {
          throw failure("unauthorized");
        }

        if (response.status === 429) {
          throw failure(
            "rate-limit",
            parseRetryAfter(
              response.headers.get("Retry-After")
            )
          );
        }

        if (!response.ok) {
          throw failure("external");
        }

        let raw;

        try {
          raw = await response.json();
        } catch {
          throw failure("schema");
        }

        if (
          !raw ||
          raw.base !== currency ||
          raw.quote !== "KRW" ||
          !validDate(raw.date) ||
          raw.date > kstDate(now()) ||
          !Number.isFinite(raw.rate) ||
          raw.rate <= 0
        ) {
          throw failure("schema");
        }

        return {
          currency,
          raw: {
            date: raw.date,
            base: raw.base,
            quote: raw.quote,
            rate: raw.rate,
          },
        };
      })
    );

    try {
      return await Promise.race([work, timedOut]);
    } finally {
      clearTimeout(timerId);
      controller.abort();
    }
  }

  async function processTestRequest(
    state,
    {
      transport,
      timeoutMs,
      now,
      render,
    }
  ) {
    state.attemptAt = now().toISOString();
    state.requestStatus = "loading";
    state.message = "합성 응답을 처리하고 있습니다.";
    state.nextAction = "처리 중에는 마지막 정상 시험값을 유지합니다.";

    render();

    try {
      const responses = await receiveRates(transport, {
        timeoutMs,
        now,
      });

      const record = makeRecord(
        responses,
        now().toISOString()
      );

      const nextRecords = mergeRecord(state.records, record);

      applySuccess(state, record);
      state.records = nextRecords;
      state.storageMessage = "합성 메모리 기록";
    } catch (error) {
      applyFailure(state, error);
    }

    render();
  }

  // ============================================================
  // 합성 transport: 응답 또는 통신 실패만 제공
  // 실제 API・DB는 호출하지 않음
  // ============================================================
  const TEST_D1 = "2026-01-05T10:00:00+09:00";
  const TEST_D2 = "2026-01-06T10:00:00+09:00";

  function syntheticTransport(scenario) {
    return async (url, options) => {
      const currency = url.split("/").at(-2).toUpperCase();

      if (scenario === "offline") {
        throw new TypeError("Synthetic network failure");
      }

      if (scenario === "slow") {
        return new Promise((resolve, reject) => {
          const abort = () => {
            reject(new DOMException("Aborted", "AbortError"));
          };

          if (options.signal.aborted) {
            abort();
          } else {
            options.signal.addEventListener(
              "abort",
              abort,
              { once: true }
            );
          }
        });
      }

      if (scenario === "unauthorized") {
        return new Response("", {
          status: currency === "USD" ? 401 : 403,
        });
      }

      if (scenario === "rate-limit") {
        return new Response("", {
          status: 429,
          headers: {
            "Retry-After": "60",
          },
        });
      }

      const rates = {
        USD: 1400,
        EUR: 1550,
        JPY: 9.5,
        CNY: 195,
        GBP: 1800,
      };

      const recovered = scenario === "recover";

      const raw = {
        date: recovered ? "2026-01-06" : "2026-01-05",
        base: currency,
        quote: "KRW",
        rate: recovered
          ? rates[currency] * 1.01
          : rates[currency],
      };

      if (scenario === "schema" && currency === "USD") {
        raw.rate = "not-a-number";
      }

      return new Response(JSON.stringify(raw), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    };
  }

  function renderTest() {
    setLabel(
      "test-data-status",
      testState.dataStatus,
      testState.dataStatus
    );

    $("test-error-status").textContent = testState.error;

    $("test-last-value").textContent =
      testState.lastNormal
        ? "합성 USD 1달러 = " +
          formatNumber(testState.lastNormal.rates.USD) +
          "원"
        : "—";

    $("test-record-count").textContent =
      `${testState.records.length}건`;

    $("test-message").textContent = testState.message;
    $("test-next-action").textContent = testState.nextAction;
  }

  function renderResults(checks) {
    const list = $("test-results");
    list.replaceChildren();

    checks.forEach(({ label, passed }) => {
      const item = document.createElement("li");

      item.textContent =
        `${passed ? "통과" : "실패"} · ${label}`;

      list.append(item);
    });
  }

  async function runTest() {
    if (testBusy) {
      return;
    }

    if (realBusy) {
      $("test-message").textContent =
        "실제 기록 조회가 끝난 뒤 시험을 실행해 주세요.";
      return;
    }

    const scenario = scenarioSelect.value;

    const allowedScenarios = [
      "normal",
      "slow",
      "unauthorized",
      "rate-limit",
      "offline",
      "schema",
      "recover",
    ];

    if (!allowedScenarios.includes(scenario)) {
      return;
    }

    const before = clone(testState);
    const realBefore = JSON.stringify(realState);

    testBusy = true;
    testButton.disabled = true;
    resetTestButton.disabled = true;
    scenarioSelect.disabled = true;
    refreshButton.disabled = true;

    testSequence += 1;

    const normalScenario =
      scenario === "normal" || scenario === "recover";

    const testDate = new Date(
      scenario === "recover" ? TEST_D2 : TEST_D1
    );

    testDate.setSeconds(
      testDate.getSeconds() + testSequence
    );

    const testTime = testDate.toISOString();
    const timeoutMs = scenario === "slow"
      ? 1200
      : TIMEOUT_MS;

    $("test-input").textContent = JSON.stringify({
      synthetic: true,
      scenario,
      receivedAt: testTime,
      timeoutMs,
      note:
        "합성 응답을 브라우저의 응답 검증과 공통 상태 처리에 넣습니다. " +
        "실제 서버 API와 DB는 호출하지 않습니다.",
    }, null, 2);

    $("test-before").textContent =
      JSON.stringify(before, null, 2);

    try {
      await processTestRequest(testState, {
        transport: syntheticTransport(scenario),
        timeoutMs,
        now: () => new Date(testTime),
        render: renderTest,
      });

      const after = clone(testState);
      const checks = [];

      if (normalScenario) {
        const expectedCount = new Set([
          ...before.records.map((record) => record.kstDate),
          kstDate(new Date(testTime)),
        ]).size;

        checks.push(
          {
            label: "정상 응답 반영 및 오류 해제",
            passed:
              after.dataStatus === "fresh" &&
              after.requestStatus === "success" &&
              after.error === "none",
          },
          {
            label: "정상값과 수신 시각 갱신",
            passed:
              after.lastNormal?.receivedAt === testTime &&
              Math.abs(
                after.lastNormal.rates.USD -
                (scenario === "recover" ? 1414 : 1400)
              ) < 0.000001,
          },
          {
            label: "같은 날짜 병합・다음 날짜 추가",
            passed:
              after.records.length === expectedCount &&
              after.records.some(
                (record) => record.receivedAt === testTime
              ),
          }
        );
      } else {
        const expectedAction =
          scenario === "rate-limit"
            ? "60초 뒤 다시 시도하세요."
            : ERROR_INFO[scenario].action;

        checks.push(
          {
            label: "실패 응답을 정상값으로 반영하지 않음",
            passed:
              JSON.stringify(after.lastNormal) ===
              JSON.stringify(before.lastNormal),
          },
          {
            label: "일별 정상 기록 보존",
            passed:
              JSON.stringify(after.records) ===
              JSON.stringify(before.records),
          },
          {
            label: "실패 종류와 데이터 상태 표시",
            passed:
              after.error === scenario &&
              after.requestStatus === "error" &&
              after.dataStatus ===
                (before.lastNormal ? "stale" : "none"),
          },
          {
            label: "실패 원인과 다음 행동 안내",
            passed:
              after.message.startsWith(
                ERROR_INFO[scenario].message
              ) &&
              after.nextAction === expectedAction,
          }
        );
      }

      checks.push({
        label: "실제 환율 화면 상태와 시험 상태 분리",
        passed:
          JSON.stringify(realState) === realBefore,
      });

      renderResults(checks);

      $("test-after").textContent =
        JSON.stringify(after, null, 2);
    } catch {
      renderResults([
        {
          label: "검사 실행 중 예기치 않은 오류 발생",
          passed: false,
        },
      ]);

      $("test-after").textContent =
        JSON.stringify(testState, null, 2);
    } finally {
      testBusy = false;
      testButton.disabled = false;
      resetTestButton.disabled = false;
      scenarioSelect.disabled = false;
      refreshButton.disabled = false;
    }
  }

  function resetTest() {
    if (testBusy) {
      return;
    }

    testState = createState();
    testSequence = 0;

    renderTest();

    $("test-input").textContent = "시험 입력 없음";
    $("test-before").textContent = "시험 실행 전";
    $("test-after").textContent = "시험 실행 전";

    $("test-results").replaceChildren();

    const item = document.createElement("li");
    item.textContent = "시험 상태를 초기화했습니다.";

    $("test-results").append(item);
  }

  // ============================================================
  // 최초 실행・이벤트 등록
  // ============================================================
  $("source-name").textContent =
    "Frankfurter · 공개 환율 API";

  $("rate-method").textContent =
    "서버가 각 통화 1단위의 KRW 기준 환율을 조회합니다. " +
    "JPY는 100을 곱해 100엔 기준으로 표시합니다. " +
    "은행의 실제 환전 매수·매도 가격과는 다릅니다.";

  $("source-link").href = SOURCE_URL;
  $("source-link").textContent =
    "Frankfurter 공식 설명 (새 탭)";
  $("source-link").removeAttribute("aria-disabled");

  $("open-real-button").addEventListener("click", () => {
    showScreen("real");
  });

  $("open-test-button").addEventListener("click", () => {
    showScreen("test");
  });

  refreshButton.addEventListener("click", refreshReal);
  testButton.addEventListener("click", runTest);
  resetTestButton.addEventListener("click", resetTest);

  renderTest();
  initializeReal();
})();