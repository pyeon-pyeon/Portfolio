"use strict";

const {
  ApiError,
  getConfig,
  prepareResponse,
  sendError,
  readId,
  readText,
  readBody,
  requireSameOrigin,
  db,
  findUserByAccountName,
  requireRegistrationInvite,
  saveChallenge,
  consumeChallenge,
  finishInvitedRegistration,
  finishAdditionalRegistration,
  requireUser,
} = require("./_lib/passkey");

let libraryPromise;

function getWebAuthn() {
  libraryPromise ??= import("@simplewebauthn/server");
  return libraryPromise;
}

// ============================================
// 공통 등록 옵션 생성
// ============================================

async function makeRegistrationOptions(user, credentials) {
  const { rpID, rpName } = getConfig();
  const { generateRegistrationOptions } = await getWebAuthn();

  return generateRegistrationOptions({
    rpName,
    rpID,

    userID: new Uint8Array(Buffer.from(user.id, "utf8")),
    userName: user.account_name,
    userDisplayName: user.display_name,

    timeout: 60_000,
    attestationType: "none",

    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },

    // 기기 내장 인증기와 외부 보안 키 모두 허용합니다.
    supportedAlgorithmIDs: [-7, -257],

    // 이미 등록된 패스키의 중복 생성을 방지합니다.
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports,
    })),
  });
}

// ============================================
// 공통 등록 응답 검증
// ============================================

async function verifyRegistration(response, challenge) {
  const { origin, rpID } = getConfig();
  const { verifyRegistrationResponse } = await getWebAuthn();

  let verification;

  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch {
    throw new ApiError(
      "verification",
      "패스키 등록 응답 검증에 실패했습니다. 다시 시작해 주세요.",
      403
    );
  }

  if (
    !verification.verified ||
    !verification.registrationInfo
  ) {
    throw new ApiError(
      "verification",
      "패스키 등록 응답을 확인하지 못했습니다.",
      403
    );
  }

  const {
    credential,
    credentialDeviceType,
    credentialBackedUp,
  } = verification.registrationInfo;

  return {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}

function readVerificationBody(req) {
  const body = readBody(req, [
    "challenge_id",
    "response",
  ]);

  const challengeId = readId(body.challenge_id, "질문 ID");

  if (
    !body.response ||
    typeof body.response !== "object" ||
    Array.isArray(body.response)
  ) {
    throw new ApiError(
      "validation",
      "패스키 등록 응답을 확인해 주세요."
    );
  }

  return {
    challengeId,
    response: body.response,
  };
}

// ============================================
// 최초 등록 질문 발급
// POST /api/passkey-register?action=options
// ============================================

async function registrationOptions(req, res) {
  const body = readBody(req, [
    "account_name",
    "invite_token",
    "name",
  ]);

  const name = readText(body.name, "패스키 이름", 80);
  const user = await findUserByAccountName(body.account_name);

  if (!user) {
    throw new ApiError(
      "invite",
      "계정 또는 등록 초대를 확인하지 못했습니다.",
      403
    );
  }

  const invite = await requireRegistrationInvite(
    user.id,
    body.invite_token
  );

  const options = await makeRegistrationOptions(user, []);

  const saved = await saveChallenge(req, res, {
    purpose: "registration",
    challenge: options.challenge,
    userId: user.id,
    credentialName: name,
    registrationInviteId: invite.id,
  });

  return res.status(200).json({
    options,
    challenge_id: saved.challenge_id,
    expires_at: saved.expires_at,
  });
}

// ============================================
// 최초 등록 응답 검증
// POST /api/passkey-register?action=verify
// ============================================

async function registrationVerify(req, res) {
  const { challengeId, response } = readVerificationBody(req);

  const challenge = await consumeChallenge(
    req,
    challengeId,
    "registration"
  );

  if (
    !challenge.registration_invite_id ||
    challenge.registration_session_id ||
    !challenge.user_id
  ) {
    throw new ApiError(
      "registration",
      "최초 등록용 질문이 아닙니다.",
      403
    );
  }

  const invites = await db(
    "passkey_registration_invites",
    {
      select: "id",
      id: `eq.${challenge.registration_invite_id}`,
      user_id: `eq.${challenge.user_id}`,
      used_at: "is.null",
      revoked_at: "is.null",
      expires_at: `gt.${new Date().toISOString()}`,
      limit: 1,
    }
  );

  if (invites.length !== 1) {
    throw new ApiError(
      "invite",
      "등록 초대가 만료되었거나 이미 사용되었습니다.",
      403
    );
  }

  const verified = await verifyRegistration(response, challenge);

  const saved = await finishInvitedRegistration(
    challenge,
    verified
  );

  return res.status(201).json({
    registered: true,
    credential: saved,
    message: "패스키를 등록했습니다. 등록한 패스키로 로그인해 주세요.",
  });
}

// ============================================
// 추가 등록 질문 발급
// POST /api/passkey-register?action=add-options
// ============================================

async function additionalOptions(req, res) {
  const auth = await requireUser(req);
  const body = readBody(req, ["name"]);

  const name = readText(body.name, "패스키 이름", 80);

  const credentials = await db(
    "passkey_credentials",
    {
      select: "credential_id,transports",
      user_id: `eq.${auth.user.id}`,
      order: "created_at.asc,id.asc",
      limit: 101,
    }
  );

  if (credentials.length >= 100) {
    throw new ApiError(
      "limit",
      "패스키는 계정당 최대 100개까지 등록할 수 있습니다.",
      409
    );
  }

  const options = await makeRegistrationOptions(
    auth.user,
    credentials
  );

  const saved = await saveChallenge(req, res, {
    purpose: "registration",
    challenge: options.challenge,
    userId: auth.user.id,
    credentialName: name,
    registrationSessionId: auth.sessionId,
  });

  return res.status(200).json({
    options,
    challenge_id: saved.challenge_id,
    expires_at: saved.expires_at,
  });
}

// ============================================
// 추가 등록 응답 검증
// POST /api/passkey-register?action=add-verify
// ============================================

async function additionalVerify(req, res) {
  const auth = await requireUser(req);
  const { challengeId, response } = readVerificationBody(req);

  const challenge = await consumeChallenge(
    req,
    challengeId,
    "registration"
  );

  if (
    challenge.registration_invite_id ||
    challenge.user_id !== auth.user.id ||
    challenge.registration_session_id !== auth.sessionId
  ) {
    throw new ApiError(
      "registration",
      "추가 등록을 시작한 계정과 세션으로 다시 시도해 주세요.",
      403
    );
  }

  const verified = await verifyRegistration(response, challenge);

  // DB 함수에서도 세션 만료·폐기 여부를 다시 확인합니다.
  const saved = await finishAdditionalRegistration(
    auth,
    challenge,
    verified
  );

  return res.status(201).json({
    registered: true,
    credential: saved,
    message: "추가 패스키를 등록했습니다.",
  });
}

// ============================================
// API 진입점
// ============================================

module.exports = async function handler(req, res) {
  prepareResponse(res);

  if (req.method?.toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: {
        code: "method",
        message: "POST 요청만 지원합니다.",
      },
    });
  }

  try {
    requireSameOrigin(req);

    const query = req.query ?? {};

    if (
      Object.keys(query).length !== 1 ||
      typeof query.action !== "string"
    ) {
      throw new ApiError(
        "validation",
        "등록 동작을 하나 지정해 주세요."
      );
    }

    switch (query.action) {
      case "options":
        return await registrationOptions(req, res);

      case "verify":
        return await registrationVerify(req, res);

      case "add-options":
        return await additionalOptions(req, res);

      case "add-verify":
        return await additionalVerify(req, res);

      default:
        throw new ApiError(
          "validation",
          "지원하지 않는 등록 동작입니다."
        );
    }
  } catch (error) {
    return sendError(res, error);
  }
};