"use strict";

const TABLE = "diary_plans";
const HISTORY_TABLE = "diary_plan_versions";

const COLUMNS = [
  "id",
  "plan_date",
  "start_date",
  "end_date",
  "title",
  "goal",
  "priority",
  "success_criteria",
  "estimated_minutes",
  "reflection",
  "next_action",
  "reviewed_at",
  "previous_plan_id",
  "version",
  "created_at",
  "updated_at",
].join(",");

const HISTORY_COLUMNS = [
  "id",
  "plan_id",
  "version",
  "snapshot",
  "is_migration_baseline",
  "recorded_at",
].join(",");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRIORITIES = new Set(["high", "medium", "low"]);

// --------------------------------------------------
// 公開 가능한 오류
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
    throw validationError("올바른 계획 ID가 필요합니다.");
  }

  return value.toLowerCase();
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

function readDate(value) {
  if (!validDate(value)) {
    throw validationError("올바른 날짜를 입력해 주세요.");
  }

  return value;
}

function readText(value, maxLength, required = false) {
  if (typeof value !== "string") {
    throw validationError("문자열 형식으로 입력해 주세요.");
  }

  const text = value.trim();

  if (required && !text) {
    throw validationError("필수 내용을 입력해 주세요.");
  }

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

function readPriority(value) {
  if (!PRIORITIES.has(value)) {
    throw validationError("우선순위가 올바르지 않습니다.");
  }

  return value;
}

function readEstimatedMinutes(value) {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 525600
  ) {
    throw validationError(
      "계획 예상 시간은 1~525600분 사이 정수로 입력해 주세요."
    );
  }

  return value;
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
    "start_date",
    "end_date",
    "title",
    "goal",
    "priority",
    "success_criteria",
    "estimated_minutes",
    "previous_plan_id",
    "reflection",
    "next_action",
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

function makePayload(body, method) {
  const payload = {};
  const creating = method === "POST";
  const has = (key) => Object.hasOwn(body, key);

  if (creating || has("start_date")) {
    payload.start_date = readDate(body.start_date);
  }

  if (creating || has("end_date")) {
    payload.end_date = readDate(body.end_date);
  }

  if (creating || has("title")) {
    payload.title = readText(body.title, 100, true);
  }

  if (has("goal")) {
    payload.goal = readText(body.goal, 2000);
  } else if (creating) {
    payload.goal = "";
  }

  if (creating || has("priority")) {
    payload.priority = readPriority(body.priority);
  }

  if (creating || has("success_criteria")) {
    payload.success_criteria = readText(
      body.success_criteria,
      2000,
      true
    );
  }

  if (creating || has("estimated_minutes")) {
    payload.estimated_minutes = readEstimatedMinutes(
      body.estimated_minutes
    );
  }

  if (has("previous_plan_id")) {
    payload.previous_plan_id =
      body.previous_plan_id === null
        ? null
        : readId(body.previous_plan_id);
  }

  const hasReflection = has("reflection");
  const hasNextAction = has("next_action");

  if (hasReflection !== hasNextAction) {
    throw validationError(
      "돌아보기와 다음 개선점은 함께 저장해 주세요."
    );
  }

  if (hasReflection && hasNextAction) {
    payload.reflection = readText(
      body.reflection,
      4000,
      true
    );

    payload.next_action = readText(
      body.next_action,
      2000,
      true
    );

    // 돌아보기 저장 시각은 서버에서 기록합니다.
    payload.reviewed_at = new Date().toISOString();
  }

  if (!creating && !Object.keys(payload).length) {
    throw validationError("수정할 내용이 없습니다.");
  }

  return payload;
}

function validatePeriod(payload, existing = null) {
  const startDate = payload.start_date ?? existing?.start_date;
  const endDate = payload.end_date ?? existing?.end_date;

  if (
    !validDate(startDate) ||
    !validDate(endDate) ||
    endDate < startDate
  ) {
    throw validationError(
      "종료일은 시작일과 같거나 이후여야 합니다."
    );
  }
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
      if (
        response.status === 400 ||
        response.status === 409
      ) {
        let code = "";

        try {
          const errorBody = await response.json();
          code = errorBody?.code;
        } catch {
          // 원본 오류 본문은 노출하지 않습니다.
        }

        if (
          ["23502", "23503", "23505", "23514", "22007", "22008"]
            .includes(code)
        ) {
          throw validationError(
            "연결된 기록이나 입력 조건을 확인해 주세요."
          );
        }
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

async function getPlan(id) {
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
      "계획을 찾을 수 없습니다.",
      404
    );
  }

  return rows[0];
}

// --------------------------------------------------
// 목록 조회: 전체 계획 또는 계획별 이력
// --------------------------------------------------

async function listRows(table, columns, order, filters = {}) {
  const result = [];
  const pageSize = 100;

  for (
    let offset = 0;
    offset < 10000;
    offset += pageSize
  ) {
    const query = new URLSearchParams({
      select: columns,
      order,
      limit: String(pageSize),
      offset: String(offset),
      ...filters,
    });

    const rows = await databaseRequest(table, query, {
      method: "GET",
    });

    result.push(...rows);

    if (rows.length < pageSize) return result;
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
      // GET /api/plans?id=UUID&history=true
      if (req.query?.history !== undefined) {
        if (req.query.history !== "true") {
          throw validationError(
            "이력 조회 값은 true여야 합니다."
          );
        }

        const id = readId(req.query.id);
        const plan = await getPlan(id);

        const versions = await listRows(
          HISTORY_TABLE,
          HISTORY_COLUMNS,
          "version.asc",
          { plan_id: `eq.${id}` }
        );

        return res.status(200).json({
          plan,
          versions,
        });
      }

      // GET /api/plans?id=UUID
      if (req.query?.id !== undefined) {
        const id = readId(req.query.id);
        const plan = await getPlan(id);

        return res.status(200).json({ plan });
      }

      // GET /api/plans
      const plans = await listRows(
        TABLE,
        COLUMNS,
        "start_date.desc,created_at.desc,id.asc"
      );

      return res.status(200).json({ plans });
    }

    if (method === "POST") {
      const payload = makePayload(parseBody(req), method);

      validatePeriod(payload);

      if (payload.previous_plan_id) {
        const previous = await getPlan(
          payload.previous_plan_id
        );

        if (!previous.next_action?.trim()) {
          throw validationError(
            "먼저 이전 계획의 개선점을 저장해 주세요."
          );
        }
      }

      const query = new URLSearchParams({
        select: COLUMNS,
      });

      const rows = await databaseRequest(TABLE, query, {
        method: "POST",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
      });

      if (rows.length !== 1) {
        throw new ApiError(
          "storage",
          "저장 결과를 확인하지 못했습니다.",
          503
        );
      }

      return res.status(201).json({ plan: rows[0] });
    }

    const id = readId(req.query?.id);
    const existing = await getPlan(id);

    if (method === "PATCH") {
      const payload = makePayload(parseBody(req), method);

      validatePeriod(payload, existing);

      if (
        Object.hasOwn(payload, "previous_plan_id") &&
        payload.previous_plan_id !== existing.previous_plan_id
      ) {
        throw validationError(
          "이전 계획 연결은 생성 후 변경할 수 없습니다."
        );
      }

      const query = new URLSearchParams({
        id: `eq.${id}`,

        // 다른 요청이 먼저 수정했다면 덮어쓰지 않습니다.
        version: `eq.${existing.version}`,

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
          "계획이 변경되었거나 삭제되었습니다. 다시 불러와 주세요.",
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

      return res.status(200).json({ plan: rows[0] });
    }

    // DELETE /api/plans?id=UUID
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
        "삭제할 계획을 찾을 수 없습니다.",
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