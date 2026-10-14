"use strict";

const {
  ApiError,
  prepareResponse,
  sendError,
  readId,
  db,
  requireUser,
  requireOwnedItem,
} = require("./_lib/passkey");

// ============================================
// 로그인 사용자 자료 목록 조회
// ============================================

async function listPrivateItems(auth, res) {
  const items = [];
  const pageSize = 100;

  // 자료가 늘어나도 한 번의 조회 제한으로 누락되지 않도록
  // 일정 개수씩 나누어 조회합니다.
  for (let offset = 0; offset < 10000; offset += pageSize) {
    const rows = await db(
      "passkey_private_items",
      {
        select:
          "id,title,content,sort_order,created_at,updated_at",
        user_id: `eq.${auth.user.id}`,
        order: "sort_order.asc,created_at.asc,id.asc",
        limit: pageSize,
        offset,
      }
    );

    items.push(...rows);

    if (rows.length < pageSize) {
      return res.status(200).json({
        items,
      });
    }
  }

  // 너무 많은 자료를 일부만 반환하고 완료했다고 표시하지 않습니다.
  throw new ApiError(
    "limit",
    "자료가 많아 전체 목록을 반환하지 못했습니다.",
    503
  );
}

// ============================================
// 개별 자료 조회
// ============================================

async function getPrivateItem(auth, itemId, res) {
  const item = await requireOwnedItem(
    auth.user.id,
    itemId
  );

  return res.status(200).json({
    item: {
      id: item.id,
      title: item.title,
      content: item.content,
      sort_order: item.sort_order,
      created_at: item.created_at,
      updated_at: item.updated_at,
    },
  });
}

// ============================================
// API 진입점
// ============================================

module.exports = async function handler(req, res) {
  prepareResponse(res);

  if (req.method?.toUpperCase() !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: {
        code: "method",
        message: "GET 요청만 지원합니다.",
      },
    });
  }

  try {
    // 입력값 처리보다 먼저 로그인 여부를 확인합니다.
    const auth = await requireUser(req);

    const query = req.query ?? {};

    const allowedKeys = [
      "id",
      "user_id",
      "account_name",
    ];

    if (
      Object.keys(query).some(
        (key) => !allowedKeys.includes(key)
      ) ||
      Object.values(query).some(
        (value) => typeof value !== "string"
      )
    ) {
      throw new ApiError(
        "validation",
        "조회 항목을 확인해 주세요."
      );
    }

    // 요청자가 다른 계정 ID를 넣더라도 자료 소유자로 사용하지 않습니다.
    // 형식만 확인하고 실제 조회는 검증된 세션 사용자로 제한합니다.
    if (query.user_id !== undefined) {
      readId(query.user_id, "계정 ID");
    }

    if (query.account_name !== undefined) {
      if (
        !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(query.account_name)
      ) {
        throw new ApiError(
          "validation",
          "계정 이름 형식이 올바르지 않습니다."
        );
      }
    }

    if (query.id !== undefined) {
      return await getPrivateItem(
        auth,
        readId(query.id, "자료 ID"),
        res
      );
    }

    return await listPrivateItems(auth, res);
  } catch (error) {
    return sendError(res, error);
  }
};