"use strict";

const {
  ApiError,
  prepareResponse,
  sendError,
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
} = require("./_lib/auth");

// 브라우저에 공개해도 되는 사용자 정보만 반환합니다.
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    created_at: user.created_at,
  };
}

function requireJson(req) {
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
}

async function findUserByEmail(email) {
  const rows = await db(
    "diary_users",
    {
      select: "id,email,display_name,password_hash,created_at",
      email: `eq.${email}`,
      limit: "1",
    },
    { method: "GET" }
  );

  return rows[0] ?? null;
}

// ==================================================
// 가입
// 가입 완료 후 자동 로그인하지 않습니다.
// ==================================================

async function signup(req, res) {
  const body = readBody(req, [
    "email",
    "display_name",
    "password",
  ]);

  const email = readEmail(body.email);
  const displayName = readDisplayName(body.display_name);
  const password = readPassword(body.password);

  const existing = await findUserByEmail(email);

  if (existing) {
    throw new ApiError(
      "duplicate",
      "이미 등록된 이메일입니다.",
      409
    );
  }

  const passwordHash = await hashPassword(password);

  let users;

  try {
    users = await db(
      "diary_users",
      {
        select: "id,email,display_name,created_at",
      },
      {
        method: "POST",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          email,
          display_name: displayName,
          password_hash: passwordHash,
        }),
      }
    );
  } catch (error) {
    // 동시에 같은 이메일로 가입한 경우도 처리합니다.
    if (
      error instanceof ApiError &&
      error.code === "duplicate"
    ) {
      throw new ApiError(
        "duplicate",
        "이미 등록된 이메일입니다.",
        409
      );
    }

    throw error;
  }

  if (users.length !== 1 || users[0].email !== email) {
    throw new ApiError(
      "storage",
      "가입 결과를 확인하지 못했습니다.",
      503
    );
  }

  // 기존 다이어리 자료는 자동으로 가져오지 않습니다.
  return res.status(201).json({
    user: publicUser(users[0]),
    message: "가입되었습니다. 로그인해 주세요.",
  });
}

// ==================================================
// 로그인
// ==================================================

async function login(req, res) {
  const body = readBody(req, [
    "email",
    "password",
  ]);

  const email = readEmail(body.email);
  const password = readPassword(body.password);

  const user = await findUserByEmail(email);

  // 없는 계정도 공통 함수에서 bcrypt 비교를 수행합니다.
  const matches = await verifyPassword(
    password,
    user?.password_hash
  );

  if (!user || !matches) {
    throw new ApiError(
      "unauthorized",
      "이메일 또는 비밀번호가 올바르지 않습니다.",
      401
    );
  }

  // 기존 쿠키가 있으면 이전 세션부터 폐기합니다.
  await revokeSession(req, res);

  // 새 세션 발급. 원문 세션값은 HttpOnly 쿠키로만 전달합니다.
  const session = await createSession(res, user.id);

  return res.status(200).json({
    user: publicUser(user),
    expires_at: session.expires_at,
    message: "로그인되었습니다.",
  });
}

// ==================================================
// 로그아웃
// ==================================================

async function logout(req, res) {
  // 빈 JSON 객체만 허용합니다.
  readBody(req, []);

  // DB 세션 폐기에 실패하면 성공 응답을 보내지 않습니다.
  await revokeSession(req, res);

  return res.status(200).json({
    logged_out: true,
    message: "로그아웃되었습니다.",
  });
}
// ==================================================
// 계정 삭제
// POST /api/auth?action=delete-account
// ==================================================

async function deleteAccount(req, res) {
  const auth = await requireUser(req);

  const body = readBody(req, [
    "password",
    "confirmation",
  ]);

  if (body.confirmation !== "계정 삭제") {
    throw new ApiError(
      "validation",
      '삭제 확인 문구로 "계정 삭제"를 입력해 주세요.',
      400
    );
  }

  const password = readPassword(body.password);

  // 계정 ID는 요청 본문이 아니라 검증된 세션에서 가져옵니다.
  const users = await db(
    "diary_users",
    {
      select: "id,password_hash",
      id: `eq.${auth.user.id}`,
      limit: "1",
    },
    { method: "GET" }
  );

  const user = users[0];

  const matches = await verifyPassword(
    password,
    user?.password_hash
  );

  if (!user || !matches) {
    throw new ApiError(
      "invalid_password",
      "현재 비밀번호가 올바르지 않습니다.",
      403
    );
  }

  // 외래키의 ON DELETE CASCADE로 연결 자료를 함께 삭제합니다.
  // 사용자 → 계획 → 할 일 → 실행 기록
  // 사용자 → 세션
  // 계획 → 계획 변경 기록
  const deleted = await db(
    "diary_users",
    {
      select: "id",
      id: `eq.${auth.user.id}`,
    },
    {
      method: "DELETE",
      headers: {
        Prefer: "return=representation",
      },
    }
  );

  if (
    deleted.length !== 1 ||
    deleted[0].id !== auth.user.id
  ) {
    throw new ApiError(
      "storage",
      "계정 삭제 결과를 확인하지 못했습니다.",
      503
    );
  }

  // DB에서 모든 세션이 삭제된 뒤 브라우저의 세션 쿠키도 지웁니다.
  // _lib/auth.js에서 사용하는 쿠키 이름·경로와 일치해야 합니다.
  res.setHeader(
    "Set-Cookie",
    [
      "__Host-pds_session=",
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ].join("; ")
  );

  return res.status(200).json({
    deleted: true,
    logged_out: true,
    message: "계정과 연결된 다이어리 자료를 삭제했습니다.",
  });
}


// ==================================================
// API handler
// ==================================================

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
      // GET /api/auth
      if (Object.keys(query).length !== 0) {
        throw new ApiError(
          "validation",
          "현재 사용자 조회에는 추가 항목을 지정하지 마세요."
        );
      }

      const auth = await requireUser(req);

      return res.status(200).json({
        user: publicUser(auth.user),
        expires_at: auth.expiresAt,
      });
    }

    // 변경 요청은 출처와 JSON 형식을 검사합니다.
    requireSameOrigin(req);
    requireJson(req);

    if (
      Object.keys(query).length !== 1 ||
      typeof query.action !== "string"
    ) {
      throw new ApiError(
        "validation",
        "요청할 인증 동작을 하나 지정해 주세요."
      );
    }

    switch (query.action) {
      case "signup":
        return await signup(req, res);

      case "login":
        return await login(req, res);

      case "logout":
        return await logout(req, res);
      
      case "delete-account":
        return await deleteAccount(req, res);

      default:
        throw new ApiError(
          "validation",
          "지원하지 않는 인증 동작입니다."
        );
    }
  } catch (error) {
    return sendError(res, error);
  }
};