"use strict";

const {
  ApiError,
  readBody,
  readId,
} = require("./auth");

function invalid(message) {
  throw new ApiError("validation", message, 400);
}

function readDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    invalid("올바른 날짜를 입력해 주세요.");
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    invalid("올바른 날짜를 입력해 주세요.");
  }

  return value;
}

function readText(value, max, required = false) {
  if (typeof value !== "string") {
    invalid("내용은 문자열로 입력해 주세요.");
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

function planPayload(req, method, existing = null) {
  const body = readBody(req, [
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

  const payload = {};
  const creating = method === "POST";
  const has = (key) => Object.hasOwn(body, key);

  for (const key of ["start_date", "end_date"]) {
    if (creating || has(key)) {
      payload[key] = readDate(body[key]);
    }
  }

  if (creating || has("title")) {
    payload.title = readText(body.title, 100, true);
  }

  if (has("goal")) {
    payload.goal = readText(body.goal, 2000);
  } else if (creating) {
    payload.goal = "";
  }

  if (creating || has("success_criteria")) {
    payload.success_criteria = readText(
      body.success_criteria,
      2000,
      true
    );
  }

  if (creating || has("priority")) {
    if (!["high", "medium", "low"].includes(body.priority)) {
      invalid("우선순위가 올바르지 않습니다.");
    }

    payload.priority = body.priority;
  }

  if (creating || has("estimated_minutes")) {
    const minutes = body.estimated_minutes;

    if (
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 525600
    ) {
      invalid("예상 시간은 1~525600분 사이 정수로 입력해 주세요.");
    }

    payload.estimated_minutes = minutes;
  }

  if (has("previous_plan_id")) {
    payload.previous_plan_id = body.previous_plan_id === null
      ? null
      : readId(body.previous_plan_id);
  }

  const hasReflection = has("reflection");
  const hasNextAction = has("next_action");

  if (hasReflection !== hasNextAction) {
    invalid("돌아보기와 다음 개선점은 함께 저장해 주세요.");
  }

  if (hasReflection) {
    payload.reflection = readText(body.reflection, 4000, true);
    payload.next_action = readText(body.next_action, 2000, true);

    if (/[\r\n]/.test(payload.next_action)) {
      invalid("다음 개선점은 한 줄로 입력해 주세요.");
    }

    payload.reviewed_at = new Date().toISOString();
  }

  if (!creating && !Object.keys(payload).length) {
    invalid("수정할 내용이 없습니다.");
  }

  const start = readDate(
    payload.start_date ?? existing?.start_date
  );

  const end = readDate(
    payload.end_date ?? existing?.end_date
  );

  if (end < start) {
    invalid("종료일은 시작일과 같거나 이후여야 합니다.");
  }

  if (
    !creating &&
    has("previous_plan_id") &&
    payload.previous_plan_id !== existing.previous_plan_id
  ) {
    invalid("이전 계획 연결은 생성 후 변경할 수 없습니다.");
  }

  return payload;
}

module.exports = { planPayload };