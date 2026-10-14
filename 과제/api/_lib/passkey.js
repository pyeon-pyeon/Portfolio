"use strict";

const { randomBytes, createHash } = require("node:crypto");

const SESSION_COOKIE = "__Host-portfolio_passkey_session";
const CHALLENGE_COOKIE = "__Host-portfolio_passkey_challenge";

const SESSION_SECONDS = 2 * 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLES = new Set([
  "passkey_users",
  "passkey_credentials",
  "passkey_challenges",
  "passkey_sessions",
  "passkey_private_items",
  "passkey_registration_invites",
]);

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);

    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

// ============================================
// 설정과 공통 응답
// ============================================

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const originValue = process.env.APP_ORIGIN?.trim();
  const rpID = process.env.PASSKEY_RP_ID?.trim();
  const rpName = process.env.PASSKEY_RP_NAME?.trim();

  if (!supabaseUrl || !secretKey || !originValue || !rpID || !rpName) {
    throw new ApiError(
      "configuration",
      "서버 환경변수 설정을 확인해 주세요.",
      503
    );
  }

  let origin;
  let databaseUrl;

  try {
    origin = new URL(originValue);
    databaseUrl = new URL(supabaseUrl);
  } catch {
    throw new ApiError(
      "configuration",
      "서버 주소 설정이 올바르지 않습니다.",
      503
    );
  }

  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.hostname !== rpID ||
    origin.port
  ) {
    throw new ApiError(
      "configuration",
      "APP_ORIGIN과 PASSKEY_RP_ID 설정을 확인해 주세요.",
      503
    );
  }

  if (
    databaseUrl.protocol !== "https:" ||
    databaseUrl.username ||
    databaseUrl.password ||
    databaseUrl.pathname !== "/" ||
    databaseUrl.search ||
    databaseUrl.hash
  ) {
    throw new ApiError(
      "configuration",
      "Supabase 주소 설정이 올바르지 않습니다.",
      503
    );
  }

  return {
    supabaseUrl: databaseUrl.origin,
    secretKey,
    origin: origin.origin,
    rpID,
    rpName,
  };
}

function prepareResponse(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendError(res, error) {
  if (error instanceof ApiError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  // 요청 본문·쿠키·환경변수·오류 상세를 출력하지 않습니다.
  return res.status(500).json({
    error: {
      code: "internal",
      message: "서버에서 요청을 처리하지 못했습니다.",
    },
  });
}

// ============================================
// 입력값과 요청 출처 검사
// ============================================

function readId(value, label = "ID") {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(
      "validation",
      `${label} 형식이 올바르지 않습니다.`
    );
  }

  return value.toLowerCase();
}

function readText(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new ApiError("validation", `${label}을 입력해 주세요.`);
  }

  const result = value.trim();

  if (!result || result.length > maxLength) {
    throw new ApiError(
      "validation",
      `${label}은 1~${maxLength}자로 입력해 주세요.`
    );
  }

  return result;
}

function readBody(req, allowedKeys) {
  const contentType = req.headers?.["content-type"];

  if (
    typeof contentType !== "string" ||
    contentType.split(";")[0].trim().toLowerCase() !==
      "application/json"
  ) {
    throw new ApiError(
      "validation",
      "application/json 형식으로 요청해 주세요.",
      415
    );
  }

  let body = req.body;

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > 65536) {
      throw new ApiError("validation", "요청 크기가 너무 큽니다.", 413);
    }

    try {
      body = JSON.parse(body);
    } catch {
      throw new ApiError("validation", "JSON 형식이 올바르지 않습니다.");
    }
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw new ApiError("validation", "JSON 객체로 요청해 주세요.");
  }

  let serialized;

  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new ApiError("validation", "요청 형식이 올바르지 않습니다.");
  }

  if (Buffer.byteLength(serialized, "utf8") > 65536) {
    throw new ApiError("validation", "요청 크기가 너무 큽니다.", 413);
  }

  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw new ApiError(
      "validation",
      "허용되지 않은 요청 항목이 있습니다."
    );
  }

  return body;
}

function requireSameOrigin(req) {
  const { origin } = getConfig();

  if (req.headers?.origin !== origin) {
    throw new ApiError(
      "origin",
      "허용된 사이트에서 요청해 주세요.",
      403
    );
  }

  const fetchSite = req.headers?.["sec-fetch-site"];

  if (fetchSite && fetchSite !== "same-origin") {
    throw new ApiError(
      "origin",
      "다른 사이트에서 보낸 요청은 허용하지 않습니다.",
      403
    );
  }
}

// ============================================
// Supabase REST 연결
// ============================================

async function databaseRequest(path, query = {}, options = {}) {
  const config = getConfig();

  const url = new URL(
    `${config.supabaseUrl}/rest/v1/${path}`
  );

  Object.entries(query).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    apikey: config.secretKey,
    Prefer: "return=representation",
  };

  // 기존 JWT 형식의 service_role 키도 지원합니다.
  if (!config.secretKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${config.secretKey}`;
  }

  const fetchOptions = {
    method: options.method ?? "GET",
    headers,
    signal: controller.signal,
  };

  if (options.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url, fetchOptions);
    const raw = await response.text();

    let result = null;

    if (raw) {
      try {
        result = JSON.parse(raw);
      } catch {
        throw new ApiError(
          "storage",
          "저장소 응답 형식이 올바르지 않습니다.",
          503
        );
      }
    }

    if (!response.ok) {
      if (result?.code === "23505") {
        throw new ApiError(
          "duplicate",
          "이미 등록되었거나 사용된 값입니다.",
          409
        );
      }

      if (
        ["23502", "23503", "23514", "22P02"].includes(result?.code)
      ) {
        throw new ApiError(
          "validation",
          "저장할 값과 연결 정보를 확인해 주세요."
        );
      }

      throw new ApiError(
        "storage",
        "저장소 요청을 처리하지 못했습니다.",
        503
      );
    }

    if (!Array.isArray(result)) {
      throw new ApiError(
        "storage",
        "저장소 결과 형식을 확인하지 못했습니다.",
        503
      );
    }

    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    throw new ApiError(
      "storage",
      "저장소에 연결하지 못했거나 응답 시간이 초과되었습니다.",
      503
    );
  } finally {
    clearTimeout(timeout);
  }
}

function db(table, query = {}, options = {}) {
  if (!TABLES.has(table)) {
    throw new ApiError("internal", "지원하지 않는 저장소입니다.", 500);
  }

  return databaseRequest(table, query, options);
}

// ============================================
// 쿠키와 해시
// ============================================

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomToken() {
  return randomBytes(32).toString("hex");
}

function readCookie(req, name) {
  const header = req.headers?.cookie;

  if (typeof header !== "string") return null;

  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));

  if (matches.length !== 1) return null;

  const value = matches[0].slice(name.length + 1);

  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function appendCookie(res, cookie) {
  const existing = res.getHeader("Set-Cookie");

  const cookies = existing
    ? Array.isArray(existing)
      ? [...existing]
      : [String(existing)]
    : [];

  cookies.push(cookie);
  res.setHeader("Set-Cookie", cookies);
}

function setCookie(res, name, value, seconds) {
  appendCookie(
    res,
    [
      `${name}=${value}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      `Max-Age=${seconds}`,
      `Expires=${new Date(Date.now() + seconds * 1000).toUTCString()}`,
    ].join("; ")
  );
}

function clearCookie(res, name) {
  appendCookie(
    res,
    [
      `${name}=`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ].join("; ")
  );
}

// ============================================
// 사용자 조회
// ============================================

async function findUserByAccountName(accountName) {
  const name = readText(accountName, "계정 이름", 40);

  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(name)) {
    throw new ApiError("validation", "계정 이름 형식을 확인해 주세요.");
  }

  const users = await db("passkey_users", {
    select: "id,account_name,display_name,created_at",
    account_name: `eq.${name}`,
    limit: 1,
  });

  return users[0] ?? null;
}

// ============================================
// 일회성 질문 저장·소비
// ============================================

async function saveChallenge(
  req,
  res,
  {
    purpose,
    challenge,
    userId = null,
    credentialName = null,
    registrationInviteId = null,
    registrationSessionId = null,
  }
) {
  if (!["registration", "authentication"].includes(purpose)) {
    throw new ApiError(
      "internal",
      "질문 목적이 올바르지 않습니다.",
      500
    );
  }

  if (
    typeof challenge !== "string" ||
    !/^[A-Za-z0-9_-]{32,1024}$/.test(challenge)
  ) {
    throw new ApiError(
      "internal",
      "질문 형식이 올바르지 않습니다.",
      500
    );
  }

  if (purpose === "registration") {
    userId = readId(userId, "등록 계정 ID");
    credentialName = readText(
      credentialName,
      "패스키 이름",
      80
    );

    // 최초 등록은 초대, 추가 등록은 로그인 세션을 사용합니다.
    // 둘 중 하나만 반드시 지정해야 합니다.
    const hasInvite = registrationInviteId !== null;
    const hasSession = registrationSessionId !== null;

    if (hasInvite === hasSession) {
      throw new ApiError(
        "internal",
        "등록 권한 연결이 올바르지 않습니다.",
        500
      );
    }

    if (hasInvite) {
      registrationInviteId = readId(
        registrationInviteId,
        "등록 초대 ID"
      );
    }

    if (hasSession) {
      registrationSessionId = readId(
        registrationSessionId,
        "등록 세션 ID"
      );
    }
  } else {
    userId = userId === null
      ? null
      : readId(userId, "계정 ID");

    credentialName = null;
    registrationInviteId = null;
    registrationSessionId = null;
  }

  const binding =
    readCookie(req, CHALLENGE_COOKIE) ?? randomToken();

  const now = new Date();

  const expires = new Date(
    now.getTime() + CHALLENGE_SECONDS * 1000
  );

  const rows = await db(
    "passkey_challenges",
    {
      select: "id,expires_at",
    },
    {
      method: "POST",
      body: {
        purpose,
        user_id: userId,
        challenge,
        binding_hash: sha256(binding),
        credential_name: credentialName,
        registration_invite_id: registrationInviteId,
        registration_session_id: registrationSessionId,
        created_at: now.toISOString(),
        expires_at: expires.toISOString(),
      },
    }
  );

  if (rows.length !== 1) {
    throw new ApiError(
      "storage",
      "질문을 저장하지 못했습니다.",
      503
    );
  }

  setCookie(
    res,
    CHALLENGE_COOKIE,
    binding,
    CHALLENGE_SECONDS
  );

  return {
    challenge_id: rows[0].id,
    expires_at: rows[0].expires_at,
  };
}


async function consumeChallenge(req, challengeId, purpose) {
  const id = readId(challengeId, "질문 ID");
  const binding = readCookie(req, CHALLENGE_COOKIE);

  if (
    !binding ||
    !["registration", "authentication"].includes(purpose)
  ) {
    throw new ApiError(
      "challenge",
      "질문을 확인할 수 없습니다. 다시 시작해 주세요.",
      403
    );
  }

  const rows = await databaseRequest(
    "rpc/passkey_consume_challenge",
    {},
    {
      method: "POST",
      body: {
        p_id: id,
        p_purpose: purpose,
        p_binding_hash: sha256(binding),
      },
    }
  );

  if (rows.length !== 1) {
    throw new ApiError(
      "challenge",
      "질문이 만료되었거나 이미 사용되었습니다.",
      403
    );
  }

  // 이후 서명 검증이 실패해도 이 질문은 다시 사용할 수 없습니다.
  return rows[0];
}

// ============================================
// 검증된 최초 패스키 등록 완료
// ============================================

async function finishInvitedRegistration(
  consumedChallenge,
  verifiedRegistration
) {
  if (
    !consumedChallenge ||
    consumedChallenge.purpose !== "registration" ||
    !consumedChallenge.consumed_at ||
    !consumedChallenge.registration_invite_id
  ) {
    throw new ApiError(
      "registration",
      "최초 등록 질문을 확인하지 못했습니다.",
      403
    );
  }

  const {
    credentialId,
    publicKey,
    counter,
    transports,
    deviceType,
    backedUp,
  } = verifiedRegistration ?? {};

  if (
    typeof credentialId !== "string" ||
    !/^[A-Za-z0-9_-]{1,4096}$/.test(credentialId) ||
    !(publicKey instanceof Uint8Array) ||
    publicKey.byteLength === 0 ||
    publicKey.byteLength > 12288 ||
    !Number.isSafeInteger(counter) ||
    counter < 0 ||
    !Array.isArray(transports) ||
    transports.length > 10 ||
    transports.some(
      (transport) =>
        typeof transport !== "string" ||
        transport.length === 0 ||
        transport.length > 50
    ) ||
    !["singleDevice", "multiDevice"].includes(deviceType) ||
    typeof backedUp !== "boolean"
  ) {
    throw new ApiError(
      "registration",
      "검증된 패스키 정보의 형식이 올바르지 않습니다."
    );
  }

  const rows = await databaseRequest(
    "rpc/passkey_finish_invited_registration",
    {},
    {
      method: "POST",
      body: {
        p_challenge_id: readId(
          consumedChallenge.id,
          "질문 ID"
        ),
        p_credential_id: credentialId,
        p_public_key: Buffer.from(publicKey).toString("base64url"),
        p_counter: counter,
        p_transports: transports,
        p_device_type: deviceType,
        p_backed_up: backedUp,
      },
    }
  );

  if (
    rows.length !== 1 ||
    rows[0].user_id !== consumedChallenge.user_id ||
    rows[0].credential_id !== credentialId
  ) {
    throw new ApiError(
      "storage",
      "패스키 등록 결과를 확인하지 못했습니다.",
      503
    );
  }

  // 공개키·카운터 등 내부 저장값은 화면 응답에서 제외합니다.
  return {
    id: rows[0].id,
    name: rows[0].name,
    created_at: rows[0].created_at,
  };
}
// ============================================
// 검증된 추가 패스키 등록 완료
// ============================================

async function finishAdditionalRegistration(
  auth,
  consumedChallenge,
  verifiedRegistration
) {
  if (
    !auth?.user?.id ||
    !auth.sessionId ||
    !consumedChallenge ||
    consumedChallenge.purpose !== "registration" ||
    !consumedChallenge.consumed_at ||
    consumedChallenge.finalized_at ||
    consumedChallenge.registration_invite_id ||
    consumedChallenge.user_id !== auth.user.id ||
    consumedChallenge.registration_session_id !== auth.sessionId
  ) {
    throw new ApiError(
      "registration",
      "추가 등록을 시작한 계정과 세션으로 다시 시도해 주세요.",
      403
    );
  }

  const {
    credentialId,
    publicKey,
    counter,
    transports,
    deviceType,
    backedUp,
  } = verifiedRegistration ?? {};

  if (
    typeof credentialId !== "string" ||
    !/^[A-Za-z0-9_-]{1,4096}$/.test(credentialId) ||
    !(publicKey instanceof Uint8Array) ||
    publicKey.byteLength === 0 ||
    publicKey.byteLength > 12288 ||
    !Number.isSafeInteger(counter) ||
    counter < 0 ||
    !Array.isArray(transports) ||
    transports.length > 10 ||
    transports.some(
      (transport) =>
        typeof transport !== "string" ||
        transport.length === 0 ||
        transport.length > 50
    ) ||
    !["singleDevice", "multiDevice"].includes(deviceType) ||
    typeof backedUp !== "boolean"
  ) {
    throw new ApiError(
      "registration",
      "검증된 패스키 정보의 형식이 올바르지 않습니다."
    );
  }

  const rows = await databaseRequest(
    "rpc/passkey_finish_additional_registration",
    {},
    {
      method: "POST",
      body: {
        p_challenge_id: readId(
          consumedChallenge.id,
          "질문 ID"
        ),
        p_session_id: readId(
          auth.sessionId,
          "등록 세션 ID"
        ),
        p_credential_id: credentialId,
        p_public_key: Buffer.from(publicKey).toString("base64url"),
        p_counter: counter,
        p_transports: transports,
        p_device_type: deviceType,
        p_backed_up: backedUp,
      },
    }
  );

  if (
    rows.length !== 1 ||
    rows[0].user_id !== auth.user.id ||
    rows[0].credential_id !== credentialId
  ) {
    throw new ApiError(
      "storage",
      "추가 패스키 등록 결과를 확인하지 못했습니다.",
      503
    );
  }

  return {
    id: rows[0].id,
    name: rows[0].name,
    created_at: rows[0].created_at,
  };
}

// ============================================
// 로그인 세션 생성·확인·폐기
// ============================================

async function createSession(res, userId, credentialRowId) {
  const token = randomToken();
  const now = new Date();

  const expires = new Date(
    now.getTime() + SESSION_SECONDS * 1000
  );

  const rows = await db(
    "passkey_sessions",
    { select: "id,user_id,credential_id,expires_at" },
    {
      method: "POST",
      body: {
        user_id: readId(userId, "계정 ID"),
        credential_id: readId(credentialRowId, "패스키 ID"),
        token_hash: sha256(token),
        created_at: now.toISOString(),
        expires_at: expires.toISOString(),
      },
    }
  );

  if (rows.length !== 1) {
    throw new ApiError("storage", "세션을 저장하지 못했습니다.", 503);
  }

  setCookie(res, SESSION_COOKIE, token, SESSION_SECONDS);

  return {
    expires_at: rows[0].expires_at,
  };
}

async function requireUser(req) {
  const token = readCookie(req, SESSION_COOKIE);

  if (!token) {
    throw new ApiError(
      "unauthorized",
      "패스키 로그인이 필요합니다.",
      401
    );
  }

  const sessions = await db("passkey_sessions", {
    select: "id,user_id,credential_id,expires_at",
    token_hash: `eq.${sha256(token)}`,
    revoked_at: "is.null",
    expires_at: `gt.${new Date().toISOString()}`,
    limit: 1,
  });

  const session = sessions[0];

  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    throw new ApiError(
      "unauthorized",
      "세션이 만료되었거나 로그아웃되었습니다.",
      401
    );
  }

  const users = await db("passkey_users", {
    select: "id,account_name,display_name,created_at",
    id: `eq.${session.user_id}`,
    limit: 1,
  });

  if (users.length !== 1) {
    throw new ApiError(
      "unauthorized",
      "로그인 계정을 확인하지 못했습니다.",
      401
    );
  }

  return {
    user: users[0],
    sessionId: session.id,
    credentialRowId: session.credential_id,
    expiresAt: session.expires_at,
  };
}

function clearLoginCookies(res) {
  clearCookie(res, SESSION_COOKIE);
  clearCookie(res, CHALLENGE_COOKIE);
}

async function revokeSession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);

  if (token) {
    // DB 폐기에 실패하면 쿠키만 지우고 성공했다고 응답하지 않습니다.
    await db(
      "passkey_sessions",
      {
        select: "id",
        token_hash: `eq.${sha256(token)}`,
        revoked_at: "is.null",
      },
      {
        method: "PATCH",
        body: {
          revoked_at: new Date().toISOString(),
        },
      }
    );
  }

    clearLoginCookies(res);
  
}

// ============================================
// 비공개 자료 소유자 확인
// ============================================

async function requireOwnedItem(userId, itemId) {
  const rows = await db("passkey_private_items", {
    select: "id,user_id,title,content,sort_order,created_at,updated_at",
    id: `eq.${readId(itemId, "자료 ID")}`,
    user_id: `eq.${readId(userId, "계정 ID")}`,
    limit: 1,
  });

  if (rows.length !== 1) {
    throw new ApiError(
      "forbidden",
      "이 비공개 자료에 접근할 수 없습니다.",
      403
    );
  }

  return rows[0];
}

// ============================================
// 최초 등록용 초대 확인
// ============================================

async function requireRegistrationInvite(userId, inviteToken) {
  const accountId = readId(userId, "계정 ID");

  if (
    typeof inviteToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(inviteToken)
  ) {
    throw new ApiError(
      "invite",
      "등록 초대가 올바르지 않습니다.",
      403
    );
  }

  const invites = await db(
    "passkey_registration_invites",
    {
      select: "id,user_id,expires_at",
      user_id: `eq.${accountId}`,
      token_hash: `eq.${sha256(inviteToken)}`,
      used_at: "is.null",
      revoked_at: "is.null",
      expires_at: `gt.${new Date().toISOString()}`,
      limit: 1,
    }
  );

  const invite = invites[0];

  if (
    !invite ||
    Date.parse(invite.expires_at) <= Date.now()
  ) {
    throw new ApiError(
      "invite",
      "등록 초대가 올바르지 않거나 만료되었습니다.",
      403
    );
  }

  const credentials = await db(
    "passkey_credentials",
    {
      select: "id",
      user_id: `eq.${accountId}`,
      limit: 1,
    }
  );

  if (credentials.length > 0) {
    throw new ApiError(
      "invite",
      "이미 패스키가 등록된 계정입니다. 로그인 후 추가해 주세요.",
      403
    );
  }

  return invite;
}

module.exports = {
  ApiError,
  getConfig,
  prepareResponse,
  sendError,
  readId,
  readText,
  readBody,
  requireSameOrigin,
  db,
  sha256,
  findUserByAccountName,
  requireRegistrationInvite,
  saveChallenge,
  consumeChallenge,
  finishInvitedRegistration,
  finishAdditionalRegistration,
  createSession,
  requireUser,
  revokeSession,
  clearLoginCookies,
  requireOwnedItem,
};