"use strict";

const {
  ApiError,
  getConfig,
  prepareResponse,
  sendError,
  readBody,
  requireSameOrigin,
  db,
  findUserByAccountName,
  saveChallenge,
  consumeChallenge,
  createSession,
  requireUser,
  revokeSession,
} = require("./_lib/passkey");

let libraryPromise;

function getWebAuthn() {
  libraryPromise ??= import("@simplewebauthn/server");
  return libraryPromise;
}

function publicUser(user) {
  return {
    id: user.id,
    account_name: user.account_name,
    display_name: user.display_name,
  };
}

// ============================================
// 로그인 질문 발급
// POST /api/passkey-login?action=options
// ============================================

async function loginOptions(req, res) {
  const body = readBody(req, ["account_name"]);

  const user = await findUserByAccountName(body.account_name);

  if (!user) {
    throw new ApiError(
      "authentication",
      "이 계정에서 사용할 수 있는 패스키를 확인하지 못했습니다.",
      403
    );
  }

  const credentials = await db(
    "passkey_credentials",
    {
      select: "credential_id,transports",
      user_id: `eq.${user.id}`,
      order: "created_at.asc",
      limit: 100,
    }
  );

  if (credentials.length === 0) {
    throw new ApiError(
      "authentication",
      "등록된 패스키가 없습니다. 최초 등록 또는 관리자 복구가 필요합니다.",
      403
    );
  }

  const { rpID } = getConfig();
  const { generateAuthenticationOptions } = await getWebAuthn();

  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60_000,
    userVerification: "required",

    allowCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports,
    })),
  });

  // 질문은 서버에서 매번 새로 생성하고 대상 계정에 연결합니다.
  const saved = await saveChallenge(req, res, {
    purpose: "authentication",
    challenge: options.challenge,
    userId: user.id,
  });

  return res.status(200).json({
    options,
    challenge_id: saved.challenge_id,
    expires_at: saved.expires_at,
  });
}

// ============================================
// 로그인 응답 검증
// POST /api/passkey-login?action=verify
// ============================================

async function loginVerify(req, res) {
  const body = readBody(req, [
    "challenge_id",
    "response",
  ]);

  if (
    !body.response ||
    typeof body.response !== "object" ||
    Array.isArray(body.response)
  ) {
    throw new ApiError(
      "validation",
      "패스키 로그인 응답을 확인해 주세요."
    );
  }

  // 질문은 먼저 소비하며, 검증 실패 시에도 재사용하지 않습니다.
  const challenge = await consumeChallenge(
    req,
    body.challenge_id,
    "authentication"
  );

  if (!challenge.user_id) {
    throw new ApiError(
      "authentication",
      "로그인 대상 계정을 확인하지 못했습니다.",
      403
    );
  }

  const credentialId = body.response.id;

  if (
    typeof credentialId !== "string" ||
    !/^[A-Za-z0-9_-]{1,4096}$/.test(credentialId)
  ) {
    throw new ApiError(
      "authentication",
      "패스키 식별자가 올바르지 않습니다.",
      403
    );
  }

  // 질문에 연결된 계정이 소유한 패스키만 조회합니다.
  // 다른 계정의 패스키나 삭제한 패스키는 사용할 수 없습니다.
  const credentials = await db(
    "passkey_credentials",
    {
      select:
        "id,user_id,credential_id,public_key,counter,transports",
      credential_id: `eq.${credentialId}`,
      user_id: `eq.${challenge.user_id}`,
      limit: 1,
    }
  );

  const stored = credentials[0];

  if (!stored) {
    throw new ApiError(
      "authentication",
      "이 계정에서 사용할 수 없는 패스키입니다.",
      403
    );
  }

  // 사용자 핸들이 반환됐다면 등록 때 사용한 UUID와 비교합니다.
  const userHandle = body.response.response?.userHandle;

  if (userHandle !== undefined && userHandle !== null) {
    const expectedUserHandle = Buffer.from(
      challenge.user_id,
      "utf8"
    ).toString("base64url");

    if (userHandle !== expectedUserHandle) {
      throw new ApiError(
        "authentication",
        "패스키의 계정 정보가 일치하지 않습니다.",
        403
      );
    }
  }

  const { origin, rpID } = getConfig();
  const { verifyAuthenticationResponse } = await getWebAuthn();

  let verification;

  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,

      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,

      requireUserVerification: true,

      // 서버에 저장한 공개키로 서명을 확인합니다.
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(
          Buffer.from(stored.public_key, "base64url")
        ),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
  } catch {
    throw new ApiError(
      "verification",
      "패스키 서명 검증에 실패했습니다. 다시 로그인해 주세요.",
      403
    );
  }

  if (
    !verification.verified ||
    !verification.authenticationInfo
  ) {
    throw new ApiError(
      "verification",
      "패스키 서명을 확인하지 못했습니다.",
      403
    );
  }

  const {
    newCounter,
    credentialDeviceType,
    credentialBackedUp,
  } = verification.authenticationInfo;

  if (
    !Number.isSafeInteger(newCounter) ||
    newCounter < 0 ||
    !["singleDevice", "multiDevice"].includes(credentialDeviceType) ||
    typeof credentialBackedUp !== "boolean"
  ) {
    throw new ApiError(
      "verification",
      "검증된 패스키 정보가 올바르지 않습니다.",
      403
    );
  }

  // 조회 이후 삭제되거나 카운터가 변경됐다면 그대로 진행하지 않습니다.
  const updated = await db(
    "passkey_credentials",
    {
      select: "id,user_id",
      id: `eq.${stored.id}`,
      user_id: `eq.${challenge.user_id}`,
      counter: `eq.${stored.counter}`,
    },
    {
      method: "PATCH",
      body: {
        counter: newCounter,
        device_type: credentialDeviceType,
        backed_up: credentialBackedUp,
        last_used_at: new Date().toISOString(),
      },
    }
  );

  if (updated.length !== 1) {
    throw new ApiError(
      "conflict",
      "패스키가 삭제되었거나 다른 인증 요청으로 변경되었습니다. 다시 로그인해 주세요.",
      409
    );
  }

  const users = await db(
    "passkey_users",
    {
      select: "id,account_name,display_name",
      id: `eq.${challenge.user_id}`,
      limit: 1,
    }
  );

  if (users.length !== 1) {
    throw new ApiError(
      "authentication",
      "로그인 계정을 확인하지 못했습니다.",
      403
    );
  }

  // 이전 세션을 폐기한 뒤 새 세션을 발급합니다.
  await revokeSession(req, res);

  const session = await createSession(
    res,
    users[0].id,
    stored.id
  );

  return res.status(200).json({
    authenticated: true,
    user: publicUser(users[0]),
    expires_at: session.expires_at,
    message: "패스키로 로그인했습니다.",
  });
}

// ============================================
// 현재 로그인 사용자 확인
// GET /api/passkey-login
// ============================================

async function currentUser(req, res) {
  const auth = await requireUser(req);

  return res.status(200).json({
    user: publicUser(auth.user),
    expires_at: auth.expiresAt,
  });
}

// ============================================
// 로그아웃
// POST /api/passkey-login?action=logout
// ============================================

async function logout(req, res) {
  readBody(req, []);

  // 서버 세션 폐기에 실패하면 성공 응답을 보내지 않습니다.
  await revokeSession(req, res);

  return res.status(200).json({
    logged_out: true,
    message: "로그아웃했습니다.",
  });
}

// ============================================
// API 진입점
// ============================================

module.exports = async function handler(req, res) {
  prepareResponse(res);

  const method = req.method?.toUpperCase();

  if (!["GET", "POST"].includes(method)) {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      error: {
        code: "method",
        message: "지원하지 않는 요청 방식입니다.",
      },
    });
  }

  try {
    const query = req.query ?? {};

    if (method === "GET") {
      if (Object.keys(query).length !== 0) {
        throw new ApiError(
          "validation",
          "사용자 조회에는 추가 항목을 지정하지 마세요."
        );
      }

      return await currentUser(req, res);
    }

    requireSameOrigin(req);

    if (
      Object.keys(query).length !== 1 ||
      typeof query.action !== "string"
    ) {
      throw new ApiError(
        "validation",
        "로그인 동작을 하나 지정해 주세요."
      );
    }

    switch (query.action) {
      case "options":
        return await loginOptions(req, res);

      case "verify":
        return await loginVerify(req, res);

      case "logout":
        return await logout(req, res);

      default:
        throw new ApiError(
          "validation",
          "지원하지 않는 로그인 동작입니다."
        );
    }
  } catch (error) {
    return sendError(res, error);
  }
};