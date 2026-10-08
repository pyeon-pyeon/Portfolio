"use strict";

const TABLE = "diary_tasks";

const COLUMNS = [
  "id",
  "plan_id",
  "title",
  "estimated_minutes",
  "status",
  "sort_order",
  "due_date",
  "priority",
  "tags",
  "completed_at",
  "created_at",
  "updated_at",
].join(",");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUSES = new Set([
  "todo",
  "doing",
  "done",
  "cancelled",
]);

const PRIORITIES = new Set([
  "high",
  "medium",
  "low",
]);

const SORTS = {
  manual: "등록 순서",
  due_asc: "마감일 빠른 순",
  priority_desc: "우선순위 높은 순",
  estimated_asc: "예상 시간 짧은 순",
  newest: "최근 등록 순",
};

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

function readText(value, maxLength, required = false) {
  if (typeof value !== "string") {
    throw validationError("문자열 형식으로 입력해 주세요.");
  }

  const text = value.trim();

  if (
    (required && !text) ||
    text.length > maxLength ||
    text.includes("\u0000")
  ) {
    throw validationError(
      `내용은 지원되는 문자로 ${
        required ? "1~" : ""
      }${maxLength}자 이내로 입력해 주세요.`
    );
  }

  return text;
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
    throw validationError("올바른 마감일을 입력해 주세요.");
  }

  return value;
}

function readMinutes(value) {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1440
  ) {
    throw validationError(
      "예상 시간은 1~1440분 사이 정수로 입력해 주세요."
    );
  }

  return value;
}

function readStatus(value) {
  if (!STATUSES.has(value)) {
    throw validationError("진행 상태가 올바르지 않습니다.");
  }

  return value;
}

function readPriority(value) {
  if (!PRIORITIES.has(value)) {
    throw validationError("우선순위가 올바르지 않습니다.");
  }

  return value;
}

function readSortOrder(value) {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2147483647
  ) {
    throw validationError("할 일 순서가 올바르지 않습니다.");
  }

  return value;
}

function readTags(value) {
  if (!Array.isArray(value) || value.length > 10) {
    throw validationError("태그는 배열로 최대 10개까지 입력해 주세요.");
  }

  const tags = value.map((tag) =>
    readText(tag, 30, true)
  );

  return [...new Set(tags)];
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
    "plan_id",
    "title",
    "estimated_minutes",
    "status",
    "sort_order",
    "due_date",
    "priority",
    "tags",
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

  if (creating || has("plan_id")) {
    payload.plan_id = readId(body.plan_id);
  }

  if (creating || has("title")) {
    payload.title = readText(body.title, 200, true);
  }

  if (creating || has("estimated_minutes")) {
    payload.estimated_minutes = readMinutes(
      body.estimated_minutes
    );
  }

  if (creating || has("due_date")) {
    payload.due_date = readDate(body.due_date);
  }

  if (has("status")) {
    payload.status = readStatus(body.status);
  } else if (creating) {
    payload.status = "todo";
  }

  if (has("priority")) {
    payload.priority = readPriority(body.priority);
  } else if (creating) {
    payload.priority = "medium";
  }

  if (has("tags")) {
    payload.tags = readTags(body.tags);
  } else if (creating) {
    payload.tags = [];
  }

  if (has("sort_order")) {
    payload.sort_order = readSortOrder(body.sort_order);
  } else if (creating) {
    payload.sort_order = 0;
  }

  if (!creating && !Object.keys(payload).length) {
    throw validationError("수정할 내용이 없습니다.");
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
      if (
        response.status === 400 ||
        response.status === 409
      ) {
        let code = "";

        try {
          code = (await response.json())?.code;
        } catch {
          // 원본 DB 오류 본문은 노출하지 않습니다.
        }

        if (
          ["23502", "23503", "23505", "23514", "22007", "22008"]
            .includes(code)
        ) {
          throw validationError(
            "연결된 계획이나 입력 조건을 확인해 주세요."
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

async function getTask(id) {
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
      "할 일을 찾을 수 없습니다.",
      404
    );
  }

  return rows[0];
}

async function requirePlan(planId) {
  const query = new URLSearchParams({
    select: "id",
    id: `eq.${planId}`,
    limit: "1",
  });

  const rows = await databaseRequest(
    "diary_plans",
    query,
    { method: "GET" }
  );

  if (!rows.length) {
    throw new ApiError(
      "not-found",
      "연결할 계획을 찾을 수 없습니다.",
      404
    );
  }
}

// --------------------------------------------------
// 검색·필터·정렬
// 사용자 검색어를 PostgREST 필터 문법에 넣지 않고
// 가져온 목록에서 일반 문자열로 비교합니다.
// --------------------------------------------------

function readFilters(query) {
  const allowed = new Set([
    "id",
    "plan_id",
    "q",
    "status",
    "priority",
    "tag",
    "sort",
  ]);

  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      throw validationError("지원하지 않는 조회 항목입니다.");
    }

    if (typeof query[key] !== "string") {
      throw validationError("조회 값은 하나씩 지정해 주세요.");
    }
  }

  const filters = {
    planId: query.plan_id ? readId(query.plan_id) : null,
    search: query.q !== undefined
      ? readText(query.q, 200)
      : "",
    status: query.status === undefined || query.status === "all"
      ? null
      : readStatus(query.status),
    priority: query.priority === undefined || query.priority === "all"
      ? null
      : readPriority(query.priority),
    tag: query.tag !== undefined
      ? readText(query.tag, 30)
      : "",
    sort: query.sort ?? "manual",
  };

  if (!Object.hasOwn(SORTS, filters.sort)) {
    throw validationError("정렬 기준이 올바르지 않습니다.");
  }

  return filters;
}

async function listTasks(planId) {
  const tasks = [];
  const pageSize = 100;

  for (
    let offset = 0;
    offset < 10000;
    offset += pageSize
  ) {
    const query = new URLSearchParams({
      select: COLUMNS,
      order: "sort_order.asc,created_at.asc,id.asc",
      limit: String(pageSize),
      offset: String(offset),
    });

    if (planId) {
      query.set("plan_id", `eq.${planId}`);
    }

    const rows = await databaseRequest(TABLE, query, {
      method: "GET",
    });

    tasks.push(...rows);

    if (rows.length < pageSize) return tasks;
  }

  throw new ApiError(
    "limit",
    "기록이 많아 전체 조회가 어렵습니다. 조회 범위 설정이 필요합니다.",
    503
  );
}

function filterAndSort(tasks, filters) {
  const search = filters.search.toLocaleLowerCase("ko-KR");
  const tag = filters.tag.toLocaleLowerCase("ko-KR");

  const result = tasks.filter((task) => {
    const tags = Array.isArray(task.tags) ? task.tags : [];

    const searchable = [task.title, ...tags]
      .join(" ")
      .toLocaleLowerCase("ko-KR");

    return (
      (!search || searchable.includes(search)) &&
      (!filters.status || task.status === filters.status) &&
      (!filters.priority || task.priority === filters.priority) &&
      (!tag || tags.some(
        (value) => value.toLocaleLowerCase("ko-KR") === tag
      ))
    );
  });

  const priorityRank = {
    high: 0,
    medium: 1,
    low: 2,
  };

  function compare(a, b) {
    switch (filters.sort) {
      case "due_asc":
        return a.due_date.localeCompare(b.due_date);

      case "priority_desc":
        return priorityRank[a.priority] - priorityRank[b.priority];

      case "estimated_asc":
        return a.estimated_minutes - b.estimated_minutes;

      case "newest":
        return b.created_at.localeCompare(a.created_at);

      default:
        return a.sort_order - b.sort_order;
    }
  }

  // 같은 값이면 등록 시각, ID 순으로 정렬해 결과를 고정합니다.
  return result.sort(
    (a, b) =>
      compare(a, b) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id)
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
      const query = req.query ?? {};
      const filters = readFilters(query);

      // GET /api/tasks?id=UUID
      if (query.id !== undefined) {
        if (Object.keys(query).length !== 1) {
          throw validationError(
            "단일 기록 조회에는 id만 지정해 주세요."
          );
        }

        const task = await getTask(readId(query.id));

        return res.status(200).json({ task });
      }

      if (filters.planId) {
        await requirePlan(filters.planId);
      }

      const allTasks = await listTasks(filters.planId);
      const tasks = filterAndSort(allTasks, filters);

      return res.status(200).json({
        tasks,
        total: allTasks.length,
        matched: tasks.length,
        sort: filters.sort,
        sort_label: SORTS[filters.sort],
      });
    }

    if (method === "POST") {
      const payload = makePayload(parseBody(req), method);

      await requirePlan(payload.plan_id);

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

      return res.status(201).json({ task: rows[0] });
    }

    const id = readId(req.query?.id);
    const existing = await getTask(id);

    if (method === "PATCH") {
      const payload = makePayload(parseBody(req), method);

      if (
        Object.hasOwn(payload, "plan_id") &&
        payload.plan_id !== existing.plan_id
      ) {
        throw validationError(
          "할 일이 연결된 계획은 변경할 수 없습니다."
        );
      }

      const query = new URLSearchParams({
        id: `eq.${id}`,
        select: COLUMNS,
      });

      const rows = await databaseRequest(TABLE, query, {
        method: "PATCH",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
      });

      if (rows.length !== 1) {
        throw new ApiError(
          "not-found",
          "수정할 할 일을 찾을 수 없습니다.",
          404
        );
      }

      return res.status(200).json({ task: rows[0] });
    }

    // DELETE /api/tasks?id=UUID
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
        "삭제할 할 일을 찾을 수 없습니다.",
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