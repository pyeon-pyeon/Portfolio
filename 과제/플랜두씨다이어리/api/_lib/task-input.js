"use strict";

const {
  ApiError,
  readBody,
  readId,
} = require("./auth");

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

function invalid(message) {
  throw new ApiError("validation", message, 400);
}

function readText(value, max, required = false) {
  if (typeof value !== "string") {
    invalid("문자열 형식으로 입력해 주세요.");
  }

  const text = value.trim();

  if (
    (required && !text) ||
    text.length > max ||
    text.includes("\u0000")
  ) {
    invalid(
      `내용은 ${required ? "1~" : ""}${max}자 이내로 입력해 주세요.`
    );
  }

  return text;
}

function readDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    invalid("올바른 마감일을 입력해 주세요.");
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    invalid("올바른 마감일을 입력해 주세요.");
  }

  return value;
}

function readInteger(value, min, max, label) {
  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    invalid(`${label}은 ${min}~${max} 사이 정수여야 합니다.`);
  }

  return value;
}

function readStatus(value) {
  if (!STATUSES.has(value)) {
    invalid("진행 상태가 올바르지 않습니다.");
  }

  return value;
}

function readPriority(value) {
  if (!PRIORITIES.has(value)) {
    invalid("우선순위가 올바르지 않습니다.");
  }

  return value;
}

function readTags(value) {
  if (!Array.isArray(value) || value.length > 10) {
    invalid("태그는 배열로 최대 10개까지 입력해 주세요.");
  }

  return [
    ...new Set(
      value.map((tag) => readText(tag, 30, true))
    ),
  ];
}

function taskPayload(req, method, existing = null) {
  const body = readBody(req, [
    "plan_id",
    "title",
    "estimated_minutes",
    "status",
    "sort_order",
    "due_date",
    "priority",
    "tags",
  ]);

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
    payload.estimated_minutes = readInteger(
      body.estimated_minutes,
      1,
      1440,
      "예상 시간"
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
    payload.sort_order = readInteger(
      body.sort_order,
      0,
      2147483647,
      "정렬 순서"
    );
  } else if (creating) {
    payload.sort_order = 0;
  }

  if (!creating && !Object.keys(payload).length) {
    invalid("수정할 내용이 없습니다.");
  }

  if (
    !creating &&
    has("plan_id") &&
    payload.plan_id !== existing.plan_id
  ) {
    invalid("할 일이 연결된 계획은 변경할 수 없습니다.");
  }

  return payload;
}

function taskQuery(req, method) {
  const query = req.query ?? {};

  const allowed = method === "GET"
    ? new Set([
        "id",
        "plan_id",
        "q",
        "status",
        "priority",
        "tag",
        "sort",
      ])
    : method === "POST"
      ? new Set()
      : new Set(["id"]);

  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string") {
      invalid("지원하지 않는 조회 항목입니다.");
    }
  }

  if (method !== "GET") {
    return method === "POST"
      ? {}
      : { id: readId(query.id) };
  }

  if (query.id !== undefined) {
    if (Object.keys(query).length !== 1) {
      invalid("단일 기록 조회에는 id만 지정해 주세요.");
    }

    return { id: readId(query.id) };
  }

  const filters = {
    planId: query.plan_id !== undefined
      ? readId(query.plan_id)
      : null,

    search: query.q !== undefined
      ? readText(query.q, 200)
      : "",

    status: query.status === undefined || query.status === "all"
      ? null
      : readStatus(query.status),

    priority:
      query.priority === undefined || query.priority === "all"
        ? null
        : readPriority(query.priority),

    tag: query.tag !== undefined
      ? readText(query.tag, 30)
      : "",

    sort: query.sort ?? "manual",
  };

  if (!Object.hasOwn(SORTS, filters.sort)) {
    invalid("정렬 기준이 올바르지 않습니다.");
  }

  return filters;
}

function filterAndSort(tasks, filters) {
  const normalize = (value) =>
    value.toLocaleLowerCase("ko-KR");

  const search = normalize(filters.search);
  const tag = normalize(filters.tag);

  const result = tasks.filter((task) => {
    const tags = Array.isArray(task.tags) ? task.tags : [];

    return (
      (!search ||
        normalize([task.title, ...tags].join(" ")).includes(search)) &&
      (!filters.status || task.status === filters.status) &&
      (!filters.priority || task.priority === filters.priority) &&
      (!tag || tags.some((value) => normalize(value) === tag))
    );
  });

  const rank = { high: 0, medium: 1, low: 2 };

  function compare(a, b) {
    switch (filters.sort) {
      case "due_asc":
        return a.due_date.localeCompare(b.due_date);
      case "priority_desc":
        return rank[a.priority] - rank[b.priority];
      case "estimated_asc":
        return a.estimated_minutes - b.estimated_minutes;
      case "newest":
        return b.created_at.localeCompare(a.created_at);
      default:
        return a.sort_order - b.sort_order;
    }
  }

  return result.sort(
    (a, b) =>
      compare(a, b) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id)
  );
}

module.exports = {
  SORTS,
  taskPayload,
  taskQuery,
  filterAndSort,
};