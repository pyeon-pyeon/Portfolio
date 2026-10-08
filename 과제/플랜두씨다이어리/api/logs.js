"use strict";

const {
  ApiError,
  prepareResponse,
  sendError,
  requireSameOrigin,
  requireUser,
  db,
} = require("./_lib/auth");

const {
  logPayload,
  logQuery,
  ensureSameRequest,
} = require("./_lib/log-input");

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

// 실행 기록 → 할 일 → 계획으로 연결해 소유자를 확인합니다.
const OWNED_COLUMNS =
  `${COLUMNS},` +
  "task:diary_tasks!inner(" +
    "id,plan_id," +
    "plan:diary_plans!inner(owner_id)" +
  ")";

function verifyOwner(row, userId) {
  if (row?.task?.plan?.owner_id !== userId) {
    throw new ApiError(
      "storage",
      "자료 소유권을 확인하지 못했습니다.",
      503
    );
  }
}

function withoutTask(row) {
  const { task, ...log } = row;
  return log;
}

// 다른 사람의 할 일은 없는 기록과 동일하게 404로 응답합니다.
async function getOwnedTask(userId, taskId) {
  const rows = await db(
    "diary_tasks",
    {
      select: "id,plan_id,plan:diary_plans!inner(owner_id)",
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

  return {
    id: rows[0].id,
    plan_id: rows[0].plan_id,
  };
}

async function findOwnedLog(userId, filters) {
  const rows = await db(
    "diary_logs",
    {
      select: OWNED_COLUMNS,
      "task.plan.owner_id": `eq.${userId}`,
      ...filters,
      limit: "1",
    },
    { method: "GET" }
  );

  if (!rows.length) return null;

  if (rows.length !== 1) {
    throw new ApiError(
      "storage",
      "실행 기록 응답이 올바르지 않습니다.",
      503
    );
  }

  verifyOwner(rows[0], userId);

  return {
    log: withoutTask(rows[0]),
    planId: rows[0].task.plan_id,
  };
}

async function getOwnedLog(userId, logId) {
  const found = await findOwnedLog(
    userId,
    { id: `eq.${logId}` }
  );

  if (!found) {
    throw new ApiError(
      "not-found",
      "접근 가능한 실행 기록을 찾을 수 없습니다.",
      404
    );
  }

  return found;
}

async function findOwnedRequest(userId, requestId) {
  return findOwnedLog(
    userId,
    { client_request_id: `eq.${requestId}` }
  );
}

async function listOwnedLogs(userId, taskId = null) {
  const logs = [];
  const pageSize = 100;

  for (let offset = 0; offset < 10000; offset += pageSize) {
    const query = {
      select: OWNED_COLUMNS,
      "task.plan.owner_id": `eq.${userId}`,
      order: "performed_on.desc,created_at.desc,id.asc",
      limit: String(pageSize),
      offset: String(offset),
    };

    if (taskId) {
      query.task_id = `eq.${taskId}`;
    }

    const rows = await db(
      "diary_logs",
      query,
      { method: "GET" }
    );

    rows.forEach((row) => verifyOwner(row, userId));
    logs.push(...rows.map(withoutTask));

    if (rows.length < pageSize) return logs;
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
    const { user } = await requireUser(req);
    const query = logQuery(req, method);

    if (method !== "GET") {
      requireSameOrigin(req);
    }

    // ----------------------------------------------
    // 본인 실행 기록 조회
    // ----------------------------------------------

    if (method === "GET") {
      if (query.id) {
        const { log } = await getOwnedLog(user.id, query.id);

        return res.status(200).json({ log });
      }

      if (query.taskId) {
        await getOwnedTask(user.id, query.taskId);
      }

      const logs = await listOwnedLogs(user.id, query.taskId);

      return res.status(200).json({ logs });
    }

    // ----------------------------------------------
    // 본인 할 일의 실행 기록 생성
    // ----------------------------------------------

    if (method === "POST") {
      const payload = logPayload(req, method);

      // 중복 요청 검사 전에 대상 할 일의 소유권부터 확인합니다.
      await getOwnedTask(user.id, payload.task_id);

      const previous = await findOwnedRequest(
        user.id,
        payload.client_request_id
      );

      if (previous) {
        ensureSameRequest(previous.log, payload);

        return res.status(200).json({
          log: previous.log,
          replayed: true,
        });
      }

      let rows;

      try {
        rows = await db(
          "diary_logs",
          { select: COLUMNS },
          {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(payload),
          }
        );
      } catch (error) {
        if (error.code !== "duplicate") throw error;

        // 동시 요청이 먼저 저장한 경우에도
        // 현재 사용자의 기록만 다시 조회합니다.
        const saved = await findOwnedRequest(
          user.id,
          payload.client_request_id
        );

        if (!saved) {
          // 다른 사용자 기록의 내용이나 존재 여부는 반환하지 않습니다.
          throw new ApiError(
            "conflict",
            "요청 키를 사용할 수 없습니다.",
            409
          );
        }

        ensureSameRequest(saved.log, payload);

        return res.status(200).json({
          log: saved.log,
          replayed: true,
        });
      }

      if (
        rows.length !== 1 ||
        rows[0].task_id !== payload.task_id
      ) {
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

    // ----------------------------------------------
    // 수정·삭제 대상 소유권 확인
    // ----------------------------------------------

    const found = await getOwnedLog(user.id, query.id);
    const existing = found.log;

    if (method === "PATCH") {
      const payload = logPayload(req, method, existing);

      if (Object.hasOwn(payload, "task_id")) {
        const target = await getOwnedTask(
          user.id,
          payload.task_id
        );

        if (target.plan_id !== found.planId) {
          throw new ApiError(
            "validation",
            "실행 기록을 다른 계획의 할 일로 옮길 수 없습니다."
          );
        }
      }

      const rows = await db(
        "diary_logs",
        {
          id: `eq.${existing.id}`,
          task_id: `eq.${existing.task_id}`,
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
          "실행 기록이 변경되었거나 삭제되었습니다. 다시 불러와 주세요.",
          409
        );
      }

      return res.status(200).json({ log: rows[0] });
    }

    const rows = await db(
      "diary_logs",
      {
        id: `eq.${existing.id}`,
        task_id: `eq.${existing.task_id}`,
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
        "삭제할 실행 기록을 찾을 수 없습니다.",
        404
      );
    }

    return res.status(200).json({ deleted: true });
  } catch (error) {
    return sendError(res, error);
  }
};