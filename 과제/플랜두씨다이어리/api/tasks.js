"use strict";

const {
  ApiError,
  prepareResponse,
  sendError,
  requireSameOrigin,
  requireUser,
  requireOwnedPlan,
  db,
} = require("./_lib/auth");

const {
  SORTS,
  taskPayload,
  taskQuery,
  filterAndSort,
} = require("./_lib/task-input");

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

// 계획과 내부 조인해서 소유자가 일치하는 할 일만 조회합니다.
const OWNED_COLUMNS =
  `${COLUMNS},plan:diary_plans!inner(owner_id)`;

function withoutPlan(row) {
  const { plan, ...task } = row;
  return task;
}

async function getOwnedTask(userId, taskId) {
  const rows = await db(
    "diary_tasks",
    {
      select: OWNED_COLUMNS,
      id: `eq.${taskId}`,
      "plan.owner_id": `eq.${userId}`,
      limit: "1",
    },
    { method: "GET" }
  );

  if (
    rows.length !== 1 ||
    rows[0].plan?.owner_id !== userId
  ) {
    throw new ApiError(
      "not-found",
      "접근 가능한 할 일을 찾을 수 없습니다.",
      404
    );
  }

  return withoutPlan(rows[0]);
}

async function listOwnedTasks(userId, planId = null) {
  const tasks = [];
  const pageSize = 100;

  for (let offset = 0; offset < 10000; offset += pageSize) {
    const query = {
      select: OWNED_COLUMNS,
      "plan.owner_id": `eq.${userId}`,
      order: "sort_order.asc,created_at.asc,id.asc",
      limit: String(pageSize),
      offset: String(offset),
    };

    if (planId) {
      query.plan_id = `eq.${planId}`;
    }

    const rows = await db(
      "diary_tasks",
      query,
      { method: "GET" }
    );

    if (rows.some((row) => row.plan?.owner_id !== userId)) {
      throw new ApiError(
        "storage",
        "자료 소유권을 확인하지 못했습니다.",
        503
      );
    }

    tasks.push(...rows.map(withoutPlan));

    if (rows.length < pageSize) return tasks;
  }

  throw new ApiError(
    "limit",
    "기록이 많아 조회 범위 조정이 필요합니다.",
    503
  );
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
    // 모든 요청에서 로그인 확인
    const { user } = await requireUser(req);
    const query = taskQuery(req, method);

    if (method !== "GET") {
      requireSameOrigin(req);
    }

    // ----------------------------------------------
    // 본인 할 일 조회·검색·필터·정렬
    // ----------------------------------------------

    if (method === "GET") {
      if (query.id) {
        const task = await getOwnedTask(user.id, query.id);

        return res.status(200).json({ task });
      }

      if (query.planId) {
        await requireOwnedPlan(user.id, query.planId);
      }

      const allTasks = await listOwnedTasks(
        user.id,
        query.planId
      );

      const tasks = filterAndSort(allTasks, query);

      return res.status(200).json({
        tasks,
        total: allTasks.length,
        matched: tasks.length,
        sort: query.sort,
        sort_label: SORTS[query.sort],
      });
    }

    // ----------------------------------------------
    // 본인 계획에 할 일 생성
    // ----------------------------------------------

    if (method === "POST") {
      const payload = taskPayload(req, method);

      await requireOwnedPlan(user.id, payload.plan_id);

      const rows = await db(
        "diary_tasks",
        { select: COLUMNS },
        {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        }
      );

      if (
        rows.length !== 1 ||
        rows[0].plan_id !== payload.plan_id
      ) {
        throw new ApiError(
          "storage",
          "저장 결과를 확인하지 못했습니다.",
          503
        );
      }

      return res.status(201).json({ task: rows[0] });
    }

    // ----------------------------------------------
    // 수정·삭제 대상 소유권 확인
    // ----------------------------------------------

    const existing = await getOwnedTask(user.id, query.id);

    if (method === "PATCH") {
      const payload = taskPayload(req, method, existing);

      const rows = await db(
        "diary_tasks",
        {
          id: `eq.${existing.id}`,
          plan_id: `eq.${existing.plan_id}`,
          updated_at: `eq.${existing.updated_at}`,
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
          "할 일이 변경되었거나 삭제되었습니다. 다시 불러와 주세요.",
          409
        );
      }

      return res.status(200).json({ task: rows[0] });
    }

    const rows = await db(
      "diary_tasks",
      {
        id: `eq.${existing.id}`,
        plan_id: `eq.${existing.plan_id}`,
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
        "삭제할 할 일을 찾을 수 없습니다.",
        404
      );
    }

    return res.status(200).json({ deleted: true });
  } catch (error) {
    return sendError(res, error);
  }
};