"use strict";

const TABLE = "diary_logs";

const COLUMNS = [
  "id",
  "task_id",
  "performed_on",
  "started_at",
  "ended_at",
  "actual_minutes",
  "note",
  "blocked_reason",
  "client_request_id",
  "created_at",
  "updated_at",
].join(",");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --------------------------------------------------
// 공개 오류
// --------------------------------------------------

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function validationError(message) {
  return new ApiError("validation", message, 400);
}

// --------------------------------------------------
// 입력 검사
// --------------------------------------------------

function readId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw validationError("올바른 기록 ID가 필요합니다.");
  }

  return value.toLowerCase();
}

function readText(value, maxLength) {
  if (typeof value !== "string") {
    throw validationError("메모는 문자열로 입력해 주세요.");
  }

  const text = value.trim();

  if (
    text.length > maxLength ||
    text.includes("\u0000")
  ) {
    throw validationError(
      `내용은 지원되는 문자로 ${maxLength}자 이내로 입력해 주세요.`
    );
  }

  return text;
}

// 시간대가 명시된 시각만 받습니다.
// 예: 2026-10-08T14:00:00+09:00
// 또는 2026-10-08T05:00:00.000Z
function readTimestamp(value) {
  if (typeof value !== "string") {
    throw validationError("시작·종료 시각을 입력해 주세요.");
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
  );

  if (!match) {
    throw validationError(
      "시각에는 날짜·초·시간대를 포함해 주세요."
    );
  }

  const [, year, month, day, hour, minute, second, , zone] =
    match;

  const datePart = `${year}-${month}-${day}`;
  const calendarDate = new Date(`${datePart}T00:00:00Z`);

  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== datePart ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    throw validationError("시각의 날짜나 시간이 올바르지 않습니다.");
  }

  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));

    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      throw validationError("시간대가 올바르지 않습니다.");
    }
  }

  const time = Date.parse(value);

  if (!Number.isFinite(time)) {
    throw validationError("시각을 읽을 수 없습니다.");
  }

  return new Date(time).toISOString();
}

function kstDate(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));

  const get = (type) =>
    parts.find((part) => part.type === type).value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function calculateMinutes(startedAt, endedAt) {
  const milliseconds =
    Date.parse(endedAt) - Date.parse(startedAt);

  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 24 * 60 * 60 * 1000
  ) {
    throw validationError(
      "종료 시각은 시작 이후여야 하며 한 기록은 24시간 이내여야 합니다."
    );
  }

  return Math.ceil(milliseconds / 60000);
}

function parseBody(req) {
  let body = req.body;

  try {
    if (typeof body === "string") {
      body = JSON.parse(body);
    }
  } catch {
    throw validationError("올바른 JSON 형식이 필요합니다.");
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw validationError("입력 내용이 올바르지 않습니다.");
  }

  const allowed = new Set([
    "task_id",
    "started_at",
    "ended_at",
    "note",
    "blocked_reason",
    "client_request_id",
  ]);

  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw validationError(
        "허용되지 않은 입력 항목이 있습니다."
      );
    }
  }

  return body;
}

function makePayload(body, method, existing = null) {
  const payload = {};
  const creating = method === "POST";
  const has = (key) => Object.hasOwn(body, key);

  if (creating || has("task_id")) {
    payload.task_id = readId(body.task_id);
  }

  if (creating || has("started_at")) {
    payload.started_at = readTimestamp(body.started_at);
  }

  if (creating || has("ended_at")) {
    payload.ended_at = readTimestamp(body.ended_at);
  }

  if (has("note")) {
    payload.note = readText(body.note, 2000);
  } else if (creating) {
    payload.note = "";
  }

  if (has("blocked_reason")) {
    payload.blocked_reason = readText(
      body.blocked_reason,
      2000
    );
  } else if (creating) {
    payload.blocked_reason = "";
  }

  if (creating) {
    payload.client_request_id = readId(
      body.client_request_id
    );
  } else if (has("client_request_id")) {
    throw validationError(
      "저장된 기록의 중복 방지 키는 변경할 수 없습니다."
    );
  }

  if (!creating && !Object.keys(payload).length) {
    throw validationError("수정할 내용이 없습니다.");
  }

  const changingTimes =
    creating ||
    has("started_at") ||
    has("ended_at");

  if (changingTimes) {
    const startedAt =
      payload.started_at ?? existing?.started_at;

    const endedAt =
      payload.ended_at ?? existing?.ended_at;

    if (!startedAt || !endedAt) {
      throw validationError(
        "시작·종료 시각을 모두 입력해 주세요."
      );
    }

    // 변경하지 않은 시각도 검증·정규화합니다.
    payload.started_at = readTimestamp(startedAt);
    payload.ended_at = readTimestamp(endedAt);

    payload.actual_minutes = calculateMinutes(
      payload.started_at,
      payload.ended_at
    );

    payload.performed_on = kstDate(payload.started_at);
  }

  return payload;
}

// --------------------------------------------------
// Supabase 서버 연결
// --------------------------------------------------

function databaseConfig() {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!rawUrl || !key) {
    throw new ApiError(
      "configuration",
      "서버 DB 환경변수가 설정되지 않았습니다.",
      500
    );
  }

  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(
      "configuration",
      "서버 DB 주소 설정이 올바르지 않습니다.",
      500
    );
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new ApiError(
      "configuration",
      "서버 DB 주소는 HTTPS 프로젝트 주소여야 합니다.",
      500
    );
  }

  return { url: parsed.origin, key };
}

async function databaseRequest(
  table,
  query,
  options = {}
) {
  const { url, key } = databaseConfig();

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    10000
  );

  const headers = {
    apikey: key,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (!key.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${key}`;
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/${table}?${query.toString()}`,
      {
        ...options,
        headers,
        signal: controller.signal,
        cache: "no-store",
      }
    );

    if (!response.ok) {
      let code = "";

      if (
        response.status === 400 ||
        response.status === 409
      ) {
        try {
          code = (await response.json())?.code;
        } catch {
          // 원본 오류 본문은 공개하지 않습니다.
        }
      }

      if (code === "23505") {
        throw new ApiError(
          "duplicate",
          "같은 요청의 기록이 이미 존재합니다.",
          409
        );
      }

      if (
        ["23502", "23503", "23514", "22007", "22008"]
          .includes(code)
      ) {
        throw validationError(
          "연결된 할 일이나 실행 시각을 확인해 주세요."
        );
      }

      throw new ApiError(
        "storage",
        "DB 조회 또는 저장에 실패했습니다.",
        503
      );
    }

    const rows = await response.json();

    if (!Array.isArray(rows)) {
      throw new ApiError(
        "storage",
        "DB 응답 형식이 올바르지 않습니다.",
        503
      );
    }

    return rows;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    throw new ApiError(
      "storage",
      "DB에 연결하거나 응답을 처리하지 못했습니다.",
      503
    );
  } finally {
    clearTimeout(timer);
  }
}

async function getTask(taskId) {
  const query = new URLSearchParams({
    select: "id,plan_id",
    id: `eq.${taskId}`,
    limit: "1",
  });

  const rows = await databaseRequest(
    "diary_tasks",
    query,
    { method: "GET" }
  );

  if (!rows.length) {
    throw new ApiError(
      "not-found",
      "연결할 할 일을 찾을 수 없습니다.",
      404
    );
  }

  return rows[0];
}

async function getLog(id) {
  const query = new URLSearchParams({
    select: COLUMNS,
    id: `eq.${id}`,
    limit: "1",
  });

  const rows = await databaseRequest(TABLE, query, {
    method: "GET",
  });

  if (!rows.length) {
    throw new ApiError(
      "not-found",
      "실행 기록을 찾을 수 없습니다.",
      404
    );
  }

  return rows[0];
}

async function findByRequestId(requestId) {
  const query = new URLSearchParams({
    select: COLUMNS,
    client_request_id: `eq.${requestId}`,
    limit: "1",
  });

  const rows = await databaseRequest(TABLE, query, {
    method: "GET",
  });

  return rows[0] ?? null;
}

// 같은 키를 다른 내용에 재사용하면 거부합니다
function ensureSameRequest(existing, payload) {
  const same =
    existing.task_id === payload.task_id &&
    Date.parse(existing.started_at) ===
      Date.parse(payload.started_at) &&
    Date.parse(existing.ended_at) ===
      Date.parse(payload.ended_at) &&
    existing.note === payload.note &&
    existing.blocked_reason === payload.blocked_reason;

  if (!same) {
    throw new ApiError(
      "conflict",
      "같은 요청 키에 다른 내용이 지정되었습니다.",
      409
    );
  }
}

async function listLogs(taskId = null) {
  const logs = [];
  const pageSize = 100;

  for (
    let offset = 0;
    offset < 10000;
    offset += pageSize
  ) {
    const query = new URLSearchParams({
      select: COLUMNS,
      order: "performed_on.desc,created_at.desc,id.asc",
      limit: String(pageSize),
      offset: String(offset),
    });

    if (taskId) {
      query.set("task_id", `eq.${taskId}`);
    }

    const rows = await databaseRequest(TABLE, query, {
      method: "GET",
    });

    logs.push(...rows);

    if (rows.length < pageSize) return logs;
  }

  throw new ApiError(
    "limit",
    "기록이 많아 전체 조회가 어렵습니다. 조회 범위 설정이 필요합니다.",
    503
  );
}

// --------------------------------------------------
// API handler
// --------------------------------------------------

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const method = req.method?.toUpperCase();

  if (
    !["GET", "POST", "PATCH", "DELETE"].includes(method)
  ) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");

    return res.status(405).json({
      error: {
        code: "method",
        message: "지원하지 않는 요청 방식입니다.",
      },
    });
  }

  try {
    if (method === "GET") {
      if (req.query?.id !== undefined) {
        const log = await getLog(readId(req.query.id));

        return res.status(200).json({ log });
      }

      const taskId =
        req.query?.task_id !== undefined
          ? readId(req.query.task_id)
          : null;

      if (taskId) await getTask(taskId);

      const logs = await listLogs(taskId);

      return res.status(200).json({ logs });
    }

    if (method === "POST") {
      const payload = makePayload(parseBody(req), method);

      // 이전 요청이 이미 저장됐다면 기존 행을 반환합니다.
      const previous = await findByRequestId(
        payload.client_request_id
      );

      if (previous) {
        ensureSameRequest(previous, payload);

        return res.status(200).json({
          log: previous,
          replayed: true,
        });
      }

      await getTask(payload.task_id);

      const query = new URLSearchParams({
        select: COLUMNS,
      });

      let rows;

      try {
        rows = await databaseRequest(TABLE, query, {
          method: "POST",
          headers: {
            Prefer: "return=representation",
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        // 동시 요청이 먼저 저장한 경우에도 같은 행을 반환합니다.
        if (error.code !== "duplicate") throw error;

        const saved = await findByRequestId(
          payload.client_request_id
        );

        if (!saved) throw error;

        ensureSameRequest(saved, payload);

        return res.status(200).json({
          log: saved,
          replayed: true,
        });
      }

      if (rows.length !== 1) {
        throw new ApiError(
          "storage",
          "저장 결과를 확인하지 못했습니다.",
          503
        );
      }

      return res.status(201).json({
        log: rows[0],
        replayed: false,
      });
    }

    const id = readId(req.query?.id);
    const existing = await getLog(id);

    if (method === "PATCH") {
      const payload = makePayload(
        parseBody(req),
        method,
        existing
      );

      if (Object.hasOwn(payload, "task_id")) {
        const targetTask = await getTask(payload.task_id);

        if (payload.task_id !== existing.task_id) {
          const originalTask = await getTask(existing.task_id);

          if (targetTask.plan_id !== originalTask.plan_id) {
            throw validationError(
              "실행 기록을 다른 계획의 할 일로 옮길 수 없습니다."
            );
          }
        }
      }

      const query = new URLSearchParams({
        id: `eq.${id}`,
        updated_at: `eq.${existing.updated_at}`,
        select: COLUMNS,
      });

      const rows = await databaseRequest(TABLE, query, {
        method: "PATCH",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
      });

      if (!rows.length) {
        throw new ApiError(
          "conflict",
          "실행 기록이 변경되었거나 삭제되었습니다. 다시 불러와 주세요.",
          409
        );
      }

      if (rows.length !== 1) {
        throw new ApiError(
          "storage",
          "수정 결과를 확인하지 못했습니다.",
          503
        );
      }

      return res.status(200).json({ log: rows[0] });
    }

    const query = new URLSearchParams({
      id: `eq.${id}`,
      select: "id",
    });

    const rows = await databaseRequest(TABLE, query, {
      method: "DELETE",
      headers: {
        Prefer: "return=representation",
      },
    });

    if (rows.length !== 1) {
      throw new ApiError(
        "not-found",
        "삭제할 실행 기록을 찾을 수 없습니다.",
        404
      );
    }

    return res.status(200).json({ deleted: true });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    return res.status(500).json({
      error: {
        code: "internal",
        message: "서버 처리 중 오류가 발생했습니다.",
      },
    });
  }
};