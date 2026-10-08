"use strict";

const bcrypt = require("bcryptjs");

const {
  randomBytes,
  createHash,
} = require("node:crypto");

const COOKIE_NAME = "__Host-pds_session";
const SESSION_SECONDS = 2 * 60 * 60;
const BCRYPT_ROUNDS = 12;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TABLES = new Set([
  "diary_users",
  "diary_sessions",
  "diary_plans",
  "diary_tasks",
  "diary_logs",
  "diary_plan_versions",
]);

// ==================================================
// 公開 오류
// ==================================================

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sendError(res, error) {
  res.setHeader("Cache-Control", "no-store");

  if (error instanceof ApiError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  // 원본 DB 오류·입력 비밀번호·세션값을 노출하지 않습니다.
  return res.status(500).json({
    error: {
      code: "internal",
      message: "서버 처리 중 오류가 발생했습니다.",
    },
  });
}

function prepareResponse(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// ==================================================
// 입력 검사
// ==================================================

function readId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw new ApiError(
      "validation",
      "올바른 기록 ID가 필요합니다."
    );
  }

  return value.toLowerCase();
}

function readEmail(value) {
  if (typeof value !== "string") {
    throw new ApiError(
      "validation",
      "이메일을 입력해 주세요."
    );
  }

  const email = value.trim().toLowerCase();

  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.includes("\u0000")
  ) {
    throw new ApiError(
      "validation",
      "이메일 형식을 확인해 주세요."
    );
  }

  return email;
}

function readDisplayName(value) {
  if (typeof value !== "string") {
    throw new ApiError(
      "validation",
      "표시 이름을 입력해 주세요."
    );
  }

  const name = value.trim();

  if (
    !name ||
    name.length > 50 ||
    name.includes("\u0000")
  ) {
    throw new ApiError(
      "validation",
      "표시 이름은 1~50자로 입력해 주세요."
    );
  }

  return name;
}

function readPassword(value) {
  // 비밀번호는 공백도 내용이므로 trim하지 않습니다.
  if (
    typeof value !== "string" ||
    value.length < 10 ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > 72
  ) {
    throw new ApiError(
      "validation",
      "비밀번호는 10자 이상, UTF-8 기준 72바이트 이내로 입력해 주세요."
    );
  }

  return value;
}

function readBody(req, allowedFields = []) {
  let body = req.body;

  try {
    if (typeof body === "string") {
      if (Buffer.byteLength(body, "utf8") > 16384) {
        throw new ApiError(
          "validation",
          "요청 내용이 너무 큽니다.",
          413
        );
      }

      body = JSON.parse(body);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;

    throw new ApiError(
      "validation",
      "올바른 JSON 형식이 필요합니다."
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new ApiError(
      "validation",
      "입력 내용이 올바르지 않습니다."
    );
  }

  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 16384) {
    throw new ApiError(
      "validation",
      "요청 내용이 너무 큽니다.",
      413
    );
  }

  const allowed = new Set(allowedFields);

  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new ApiError(
      "validation",
      "허용되지 않은 입력 항목이 있습니다."
    );
  }

  return body;
}

// ==================================================
// 변경 요청의 출처 확인
// 가입·로그인·로그아웃·등록·수정·삭제 API에서 사용
// ==================================================

function requireSameOrigin(req) {
  const configured = process.env.APP_ORIGIN?.trim();

  let expected;

  try {
    const url = new URL(configured);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid origin");
    }

    expected = url.origin;
  } catch {
    throw new ApiError(
      "configuration",
      "서버의 APP_ORIGIN 설정을 확인해 주세요.",
      500
    );
  }

  const origin = req.headers?.origin;

  if (typeof origin !== "string" || origin !== expected) {
    throw new ApiError(
      "forbidden",
      "허용되지 않은 요청 출처입니다.",
      403
    );
  }

  const site = req.headers?.["sec-fetch-site"];

  if (
    site !== undefined &&
    site !== "same-origin" &&
    site !== "none"
  ) {
    throw new ApiError(
      "forbidden",
      "다른 사이트에서 보낸 요청은 허용하지 않습니다.",
      403
    );
  }
}

// ==================================================
// DB 연결
// ==================================================

function databaseConfig() {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!rawUrl || !key) {
    throw new ApiError(
      "configuration",
      "서버 DB 환경변수가 설정되지 않았습니다.",
      500
    );
  }

  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(
      "configuration",
      "서버 DB 주소가 올바르지 않습니다.",
      500
    );
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ApiError(
      "configuration",
      "서버 DB 주소는 HTTPS 프로젝트 주소여야 합니다.",
      500
    );
  }

  return { url: parsed.origin, key };
}

async function db(table, query, options = {}) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new ApiError(
      "internal",
      "허용되지 않은 테이블입니다.",
      500
    );
  }

  const { url, key } = databaseConfig();

  const params = query instanceof URLSearchParams
    ? query
    : new URLSearchParams(query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  const headers = {
    apikey: key,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (!key.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${key}`;
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/${table}?${params.toString()}`,
      {
        ...options,
        headers,
        signal: controller.signal,
        cache: "no-store",
      }
    );

    if (!response.ok) {
      let code = "";

      try {
        code = (await response.json())?.code;
      } catch {
        // 원본 오류 본문은 공개하지 않습니다.
      }

      if (code === "23505") {
        throw new ApiError(
          "duplicate",
          "이미 등록된 값이 있습니다.",
          409
        );
      }

      if (
        ["23502", "23503", "23514", "22007", "22008"]
          .includes(code)
      ) {
        throw new ApiError(
          "validation",
          "입력 내용이나 연결된 기록을 확인해 주세요."
        );
      }

      throw new ApiError(
        "storage",
        "DB 요청에 실패했습니다.",
        503
      );
    }

    const rows = await response.json();

    if (!Array.isArray(rows)) {
      throw new ApiError(
        "storage",
        "DB 응답 형식이 올바르지 않습니다.",
        503
      );
    }

    return rows;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    throw new ApiError(
      "storage",
      "DB 연결 또는 응답 처리에 실패했습니다.",
      503
    );
  } finally {
    clearTimeout(timer);
  }
}

// ==================================================
// 비밀번호 해시와 비교
// ==================================================

async function hashPassword(password) {
  const validPassword = readPassword(password);

  // 매번 새 솔트를 생성하므로 같은 비밀번호도 해시가 달라집니다.
  return bcrypt.hash(validPassword, BCRYPT_ROUNDS);
}

let dummyHashPromise;

async function verifyPassword(password, storedHash) {
  const validPassword = readPassword(password);

  // 없는 계정도 bcrypt 비교를 수행합니다.
  // 이것만으로 모든 시간 차이를 제거하는 것은 아닙니다.
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(
      randomBytes(32).toString("hex"),
      BCRYPT_ROUNDS
    );
  }

  const usableHash =
    typeof storedHash === "string" &&
    /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(storedHash);

  const comparisonHash = usableHash
    ? storedHash
    : await dummyHashPromise;

  const matches = await bcrypt.compare(
    validPassword,
    comparisonHash
  );

  return usableHash && matches;
}

// ==================================================
// 세션 쿠키
// ==================================================

function sessionHash(token) {
  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

function readSessionToken(req) {
  const header = req.headers?.cookie;

  if (
    typeof header !== "string" ||
    header.length > 16384
  ) {
    return null;
  }

  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));

  // 같은 이름의 쿠키가 여러 개면 모호한 요청으로 처리합니다.
  if (matches.length !== 1) return null;

  const token = matches[0].slice(COOKIE_NAME.length + 1);

  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

function setSessionCookie(res, token, expiresAt) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)
  );

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; ` +
    `SameSite=Strict; Max-Age=${seconds}; ` +
    `Expires=${new Date(expiresAt).toUTCString()}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; ` +
    "SameSite=Strict; Max-Age=0; " +
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  );
}

// ==================================================
// 세션 생성과 로그인 사용자 확인
// ==================================================

async function createSession(res, userId) {
  const id = readId(userId);

  const token = randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();

  const expiresAt = new Date(
    Date.parse(createdAt) + SESSION_SECONDS * 1000
  ).toISOString();

  const rows = await db(
    "diary_sessions",
    { select: "id,user_id,expires_at" },
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: id,
        token_hash: sessionHash(token),
        created_at: createdAt,
        expires_at: expiresAt,
      }),
    }
  );

  if (
    rows.length !== 1 ||
    rows[0].user_id !== id ||
    !UUID_PATTERN.test(rows[0].id) ||
    !Number.isFinite(Date.parse(rows[0].expires_at))
  ) {
    throw new ApiError(
      "storage",
      "로그인 세션을 생성하지 못했습니다.",
      503
    );
  }

  setSessionCookie(res, token, rows[0].expires_at);

  // 세션 원문은 응답 JSON에 넣지 않습니다.
  return {
    expires_at: rows[0].expires_at,
  };
}

async function requireUser(req) {
  const token = readSessionToken(req);

  if (!token) {
    throw new ApiError(
      "unauthorized",
      "로그인이 필요합니다.",
      401
    );
  }

  const rows = await db(
    "diary_sessions",
    {
      select: "id,user_id,expires_at,revoked_at",
      token_hash: `eq.${sessionHash(token)}`,
      revoked_at: "is.null",
      expires_at: `gt.${new Date().toISOString()}`,
      limit: "1",
    },
    { method: "GET" }
  );

  const session = rows[0];

  if (
    rows.length !== 1 ||
    session.revoked_at !== null ||
    !UUID_PATTERN.test(session.user_id) ||
    !(Date.parse(session.expires_at) > Date.now())
  ) {
    throw new ApiError(
      "unauthorized",
      "세션이 만료되었거나 로그아웃되었습니다.",
      401
    );
  }

  const users = await db(
    "diary_users",
    {
      select: "id,email,display_name,created_at",
      id: `eq.${session.user_id}`,
      limit: "1",
    },
    { method: "GET" }
  );

  if (users.length !== 1) {
    throw new ApiError(
      "unauthorized",
      "로그인 계정을 찾을 수 없습니다.",
      401
    );
  }

  // 서버 내부에서만 사용하는 결과입니다.
  // 세션 정보 전체를 브라우저에 그대로 반환하지 않습니다.
  return {
    user: users[0],
    sessionId: session.id,
    expiresAt: session.expires_at,
  };
}

async function revokeSession(req, res) {
  const token = readSessionToken(req);

  if (token) {
    // 이미 만료·폐기된 세션도 같은 로그아웃 흐름을 사용합니다.
    await db(
      "diary_sessions",
      {
        token_hash: `eq.${sessionHash(token)}`,
        revoked_at: "is.null",
        select: "id",
      },
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          revoked_at: new Date().toISOString(),
        }),
      }
    );
  }

  // DB 요청 실패 시 성공으로 처리하지 않습니다.
  clearSessionCookie(res);
}

// ==================================================
// 계획 소유자 확인
// ==================================================

async function requireOwnedPlan(userId, planId) {
  const ownerId = readId(userId);
  const id = readId(planId);

  const rows = await db(
    "diary_plans",
    {
      select: "*",
      id: `eq.${id}`,
      owner_id: `eq.${ownerId}`,
      limit: "1",
    },
    { method: "GET" }
  );

  if (rows.length !== 1) {
    // 없는 계획과 다른 사람의 계획을 동일하게 응답합니다.
    throw new ApiError(
      "not-found",
      "접근 가능한 계획을 찾을 수 없습니다.",
      404
    );
  }

  return rows[0];
}

// ==================================================
// 서버 API에서 사용할 함수
// ==================================================

module.exports = {
  ApiError,
  prepareResponse,
  sendError,
  readId,
  readEmail,
  readDisplayName,
  readPassword,
  readBody,
  requireSameOrigin,
  db,
  hashPassword,
  verifyPassword,
  createSession,
  requireUser,
  revokeSession,
  clearSessionCookie,
  requireOwnedPlan,
};