"use strict";

const {
  ApiError,
  prepareResponse,
  sendError,
  readId,
  requireSameOrigin,
  requireUser,
  requireOwnedPlan,
  db,
} = require("./_lib/auth");

const { planPayload } = require("./_lib/plan-input");

const COLUMNS = [
  "id",
  "owner_id",
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

async function listRows(table, columns, order, filters) {
  const result = [];
  const pageSize = 100;

  for (let offset = 0; offset < 10000; offset += pageSize) {
    const rows = await db(
      table,
      {
        select: columns,
        order,
        limit: String(pageSize),
        offset: String(offset),
        ...filters,
      },
      { method: "GET" }
    );

    result.push(...rows);

    if (rows.length < pageSize) return result;
  }

  throw new ApiError(
    "limit",
    "기록이 많아 조회 범위 조정이 필요합니다.",
    503
  );
}

function validateQuery(req, method) {
  const query = req.query ?? {};
  const allowed = method === "GET"
    ? new Set(["id", "history"])
    : method === "POST"
      ? new Set()
      : new Set(["id"]);

  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string") {
      throw new ApiError(
        "validation",
        "지원하지 않는 조회 항목입니다."
      );
    }
  }

  if (
    query.history !== undefined &&
    (query.history !== "true" || query.id === undefined)
  ) {
    throw new ApiError(
      "validation",
      "이력 조회에는 id와 history=true가 필요합니다."
    );
  }

  return query;
}

module.exports = async function handler(req, res) {
  prepareResponse(res);

  const method = req.method?.toUpperCase();

  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");

    return res.status(405).json({
      error: {
        code: "method",
        message: "지원하지 않는 요청 방식입니다.",
      },
    });
  }

  try {
    // 모든 자료 요청은 로그인부터 확인합니다.
    const { user } = await requireUser(req);
    const query = validateQuery(req, method);

    if (method !== "GET") {
      requireSameOrigin(req);
    }

    // ----------------------------------------------
    // 본인 계획 목록·단일 계획·이력 조회
    // ----------------------------------------------

    if (method === "GET") {
      if (query.id !== undefined) {
        const id = readId(query.id);

        // 다른 사람의 계획과 존재하지 않는 계획 모두 404
        const plan = await requireOwnedPlan(user.id, id);

        if (query.history === "true") {
          const versions = await listRows(
            "diary_plan_versions",
            HISTORY_COLUMNS,
            "version.asc",
            { plan_id: `eq.${plan.id}` }
          );

          return res.status(200).json({ plan, versions });
        }

        return res.status(200).json({ plan });
      }

      const plans = await listRows(
        "diary_plans",
        COLUMNS,
        "start_date.desc,created_at.desc,id.asc",
        { owner_id: `eq.${user.id}` }
      );

      return res.status(200).json({ plans });
    }

    // ----------------------------------------------
    // 본인 계획 생성
    // ----------------------------------------------

    if (method === "POST") {
      const payload = planPayload(req, method);

      // 요청 본문의 사용자 ID를 사용하지 않습니다.
      payload.owner_id = user.id;

      if (payload.previous_plan_id) {
        const previous = await requireOwnedPlan(
          user.id,
          payload.previous_plan_id
        );

        if (!previous.next_action?.trim()) {
          throw new ApiError(
            "validation",
            "먼저 이전 계획의 개선점을 저장해 주세요."
          );
        }
      }

      const rows = await db(
        "diary_plans",
        { select: COLUMNS },
        {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        }
      );

      if (rows.length !== 1 || rows[0].owner_id !== user.id) {
        throw new ApiError(
          "storage",
          "저장 결과를 확인하지 못했습니다.",
          503
        );
      }

      return res.status(201).json({ plan: rows[0] });
    }

    // ----------------------------------------------
    // 수정·삭제 대상의 소유자 확인
    // ----------------------------------------------

    const id = readId(query.id);
    const existing = await requireOwnedPlan(user.id, id);

    if (method === "PATCH") {
      const payload = planPayload(req, method, existing);

      const rows = await db(
        "diary_plans",
        {
          id: `eq.${id}`,
          owner_id: `eq.${user.id}`,
          version: `eq.${existing.version}`,
          select: COLUMNS,
        },
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        }
      );

      if (rows.length !== 1) {
        throw new ApiError(
          "conflict",
          "계획이 변경되었거나 삭제되었습니다. 다시 불러와 주세요.",
          409
        );
      }

      return res.status(200).json({ plan: rows[0] });
    }

    const rows = await db(
      "diary_plans",
      {
        id: `eq.${id}`,
        owner_id: `eq.${user.id}`,
        select: "id",
      },
      {
        method: "DELETE",
        headers: { Prefer: "return=representation" },
      }
    );

    if (rows.length !== 1) {
      throw new ApiError(
        "not-found",
        "삭제할 계획을 찾을 수 없습니다.",
        404
      );
    }

    return res.status(200).json({ deleted: true });
  } catch (error) {
    return sendError(res, error);
  }
};