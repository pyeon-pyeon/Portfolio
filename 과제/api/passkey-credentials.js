"use strict";

const {
  ApiError,
  prepareResponse,
  sendError,
  readId,
  readBody,
  requireSameOrigin,
  db,
  requireUser,
  clearLoginCookies,
} = require("./_lib/passkey");

// ============================================
// 등록한 패스키 목록
// ============================================

async function listCredentials(auth, res) {
  const credentials = await db(
    "passkey_credentials",
    {
      select:
        "id,name,created_at,last_used_at,device_type,backed_up",
      user_id: `eq.${auth.user.id}`,
      order: "created_at.asc,id.asc",
      limit: 101,
    }
  );

  if (credentials.length > 100) {
    throw new ApiError(
      "limit",
      "패스키가 많아 전체 목록을 반환하지 못했습니다.",
      503
    );
  }

  return res.status(200).json({
    credentials: credentials.map((credential) => ({
      id: credential.id,
      name: credential.name,
      created_at: credential.created_at,
      last_used_at: credential.last_used_at,
      device_type: credential.device_type,
      backed_up: credential.backed_up,

      // 현재 로그인에 사용한 패스키인지 표시합니다.
      current: credential.id === auth.credentialRowId,
    })),

    message:
      "패스키가 모두 삭제되면 로그인할 수 없습니다. " +
      "복구하려면 관리자가 새 최초 등록 초대를 발급해야 합니다.",
  });
}

// ============================================
// 패스키 삭제
// ============================================

async function deleteCredential(req, res, auth, credentialId) {
  const body = readBody(req, ["confirmation"]);

  if (body.confirmation !== "패스키 삭제") {
    throw new ApiError(
      "validation",
      '삭제 확인 문구로 "패스키 삭제"를 보내 주세요.'
    );
  }

  // 요청자가 보낸 계정 ID를 사용하지 않습니다.
  // 삭제 대상은 로그인 사용자 소유의 패스키로 제한합니다.
  const deleted = await db(
    "passkey_credentials",
    {
      select: "id",
      id: `eq.${credentialId}`,
      user_id: `eq.${auth.user.id}`,
    },
    {
      method: "DELETE",
    }
  );

  if (deleted.length !== 1) {
    throw new ApiError(
      "forbidden",
      "이 패스키를 삭제할 수 없습니다.",
      403
    );
  }

  // 외래키 설정에 의해 삭제한 패스키로 만든 세션들도 삭제됩니다.
  const sessionEnded = credentialId === auth.credentialRowId;

  if (sessionEnded) {
    clearLoginCookies(res);
  }

  return res.status(200).json({
    deleted: true,
    deleted_id: credentialId,
    session_ended: sessionEnded,

    message: sessionEnded
      ? (
          "현재 로그인에 사용한 패스키와 세션을 삭제했습니다. " +
          "남은 패스키로 다시 로그인해 주세요. " +
          "남은 패스키가 없다면 관리자 복구가 필요합니다."
        )
      : (
          "패스키를 삭제했습니다. " +
          "삭제한 패스키로는 더 이상 로그인할 수 없습니다."
        ),
  });
}

// ============================================
// API 진입점
// ============================================

module.exports = async function handler(req, res) {
  prepareResponse(res);

  const method = req.method?.toUpperCase();

  if (!["GET", "DELETE"].includes(method)) {
    res.setHeader("Allow", "GET, DELETE");

    return res.status(405).json({
      error: {
        code: "method",
        message: "GET과 DELETE 요청만 지원합니다.",
      },
    });
  }

  try {
    const auth = await requireUser(req);
    const query = req.query ?? {};

    if (method === "GET") {
      if (Object.keys(query).length !== 0) {
        throw new ApiError(
          "validation",
          "패스키 목록 조회에는 추가 항목을 지정하지 마세요."
        );
      }

      return await listCredentials(auth, res);
    }

    requireSameOrigin(req);

    if (
      Object.keys(query).length !== 1 ||
      typeof query.id !== "string"
    ) {
      throw new ApiError(
        "validation",
        "삭제할 패스키 ID를 하나 지정해 주세요."
      );
    }

    return await deleteCredential(
      req,
      res,
      auth,
      readId(query.id, "패스키 ID")
    );
  } catch (error) {
    return sendError(res, error);
  }
};