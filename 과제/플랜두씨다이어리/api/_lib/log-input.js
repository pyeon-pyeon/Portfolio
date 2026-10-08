"use strict";

const {
  ApiError,
  readBody,
  readId,
} = require("./auth");

function invalid(message) {
  throw new ApiError("validation", message, 400);
}

function readText(value, max) {
  if (typeof value !== "string") {
    invalid("메모는 문자열로 입력해 주세요.");
  }

  const text = value.trim();

  if (
    text.length > max ||
    text.includes("\u0000")
  ) {
    invalid(`내용은 ${max}자 이내로 입력해 주세요.`);
  }

  return text;
}

function readTimestamp(value) {
  if (typeof value !== "string") {
    invalid("시작·종료 시각을 입력해 주세요.");
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
  );

  if (!match) {
    invalid("시각에는 날짜·초·시간대를 포함해 주세요.");
  }

  const [, year, month, day, hour, minute, second, , zone] =
    match;

  const datePart = `${year}-${month}-${day}`;
  const calendar = new Date(`${datePart}T00:00:00Z`);

  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== datePart ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    invalid("시각의 날짜나 시간이 올바르지 않습니다.");
  }

  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));

    if (
      hours > 14 ||
      minutes > 59 ||
      (hours === 14 && minutes !== 0)
    ) {
      invalid("시간대가 올바르지 않습니다.");
    }
  }

  const time = Date.parse(value);

  if (!Number.isFinite(time)) {
    invalid("시각을 읽을 수 없습니다.");
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

function logPayload(req, method, existing = null) {
  const body = readBody(req, [
    "task_id",
    "started_at",
    "ended_at",
    "note",
    "blocked_reason",
    "client_request_id",
  ]);

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
    payload.blocked_reason = readText(body.blocked_reason, 2000);
  } else if (creating) {
    payload.blocked_reason = "";
  }

  if (creating) {
    payload.client_request_id = readId(body.client_request_id);
  } else if (has("client_request_id")) {
    invalid("저장된 기록의 중복 방지 키는 변경할 수 없습니다.");
  }

  if (!creating && !Object.keys(payload).length) {
    invalid("수정할 내용이 없습니다.");
  }

  if (creating || has("started_at") || has("ended_at")) {
    const start = payload.started_at ?? existing?.started_at;
    const end = payload.ended_at ?? existing?.ended_at;

    if (!start || !end) {
      invalid("시작·종료 시각을 모두 입력해 주세요.");
    }

    payload.started_at = readTimestamp(start);
    payload.ended_at = readTimestamp(end);

    const milliseconds =
      Date.parse(payload.ended_at) -
      Date.parse(payload.started_at);

    if (
      milliseconds <= 0 ||
      milliseconds > 86400000
    ) {
      invalid(
        "종료는 시작 이후여야 하며 한 기록은 24시간 이내여야 합니다."
      );
    }

    payload.actual_minutes = Math.ceil(milliseconds / 60000);
    payload.performed_on = kstDate(payload.started_at);
  }

  return payload;
}

function logQuery(req, method) {
  const query = req.query ?? {};

  const allowed = method === "GET"
    ? new Set(["id", "task_id"])
    : method === "POST"
      ? new Set()
      : new Set(["id"]);

  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string") {
      invalid("지원하지 않는 조회 항목입니다.");
    }
  }

  if (method === "POST") return {};

  if (method !== "GET") {
    return { id: readId(query.id) };
  }

  if (query.id !== undefined) {
    if (Object.keys(query).length !== 1) {
      invalid("단일 기록 조회에는 id만 지정해 주세요.");
    }

    return { id: readId(query.id) };
  }

  return {
    taskId: query.task_id !== undefined
      ? readId(query.task_id)
      : null,
  };
}

function ensureSameRequest(existing, payload) {
  const same =
    existing.task_id === payload.task_id &&
    Date.parse(existing.started_at) === Date.parse(payload.started_at) &&
    Date.parse(existing.ended_at) === Date.parse(payload.ended_at) &&
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

module.exports = {
  logPayload,
  logQuery,
  ensureSameRequest,
};