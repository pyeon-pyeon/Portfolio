"use strict";

(() => {
  const gate = document.getElementById("auth-gate");
  const gateMessage = document.getElementById("auth-gate-message");
  const app = document.getElementById("diary-app");
  const accountName = document.getElementById("account-name");
  const logoutButton = document.getElementById("logout-button");

  if (!gate || !gateMessage || !app || !accountName || !logoutButton) {
    throw new Error("diary.html의 인증 관련 요소를 확인하세요.");
  }

  const REQUEST_TIMEOUT_MS = 15_000;
  const MAX_TIMER_MS = 2_147_483_647;

  let currentUser = null;
  let expiresAt = null;
  let expiryTimer = null;
  let checking = false;
  let loggingOut = false;
  let stopped = false;
  let readySettled = false;
  let resolveReady;

  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function settleReady(value) {
    if (readySettled) return;

    readySettled = true;
    resolveReady(value);
  }

  function clearExpiryTimer() {
    if (expiryTimer !== null) {
      window.clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  }

  function hideDiary(message) {
    app.hidden = true;
    gate.hidden = false;
    gateMessage.textContent = message;
  }

  function loginUrl() {
    return new URL("index.html", window.location.href).href;
  }

  function endSession(
    message = "로그인이 만료되었습니다. 다시 로그인해 주세요."
  ) {
    if (stopped) return;

    stopped = true;
    clearExpiryTimer();

    currentUser = null;
    expiresAt = null;

    hideDiary(message);
    settleReady(null);

    // 공통 상태와 각 화면이 개인 기록을 지울 수 있도록 알립니다.
    window.dispatchEvent(
      new CustomEvent("pds:session-ended", {
        detail: { message },
      })
    );

    window.location.replace(loginUrl());
  }

  async function authRequest(action = null) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const isLogout = action === "logout";
    const url = isLogout
      ? "/api/auth?action=logout"
      : "/api/auth";

    try {
      const response = await fetch(url, {
        method: isLogout ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: isLogout
          ? {
              Accept: "application/json",
              "Content-Type": "application/json",
            }
          : {
              Accept: "application/json",
            },
        ...(isLogout ? { body: JSON.stringify({}) } : {}),
        signal: controller.signal,
      });

      let body = null;

      try {
        body = await response.json();
      } catch {
        // 응답 형식이 잘못되면 아래 단계에서 오류로 처리합니다.
      }

      return { response, body };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "로그인 확인 시간이 초과되었습니다. 잠시 후 새로고침해 주세요."
        );
      }

      throw new Error(
        "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요."
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function readSession(body) {
    if (!body || typeof body !== "object") {
      throw new Error("로그인 확인 응답 형식이 올바르지 않습니다.");
    }

    const user = body.user;

    if (
      !user ||
      typeof user !== "object" ||
      typeof user.id !== "string" ||
      typeof user.email !== "string" ||
      typeof user.display_name !== "string" ||
      !user.id ||
      !user.email ||
      !user.display_name.trim()
    ) {
      throw new Error("사용자 정보를 확인하지 못했습니다.");
    }

    const expiration = Date.parse(body.expires_at);

    if (!Number.isFinite(expiration)) {
      throw new Error("로그인 만료 시각을 확인하지 못했습니다.");
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
      },
      expiresAt: expiration,
    };
  }

  function scheduleExpiry() {
    clearExpiryTimer();

    if (stopped || expiresAt === null) return;

    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      endSession();
      return;
    }

    expiryTimer = window.setTimeout(() => {
      scheduleExpiry();
    }, Math.min(remaining, MAX_TIMER_MS));
  }

  function showDiary(session) {
    currentUser = session.user;
    expiresAt = session.expiresAt;

    accountName.textContent = `${currentUser.display_name}님`;

    if (!document.hidden) {
      gate.hidden = true;
      app.hidden = false;
    }

    scheduleExpiry();
  }

  async function checkSession(initial = false) {
    if (checking || loggingOut || stopped) return;

    checking = true;

    hideDiary(
      initial
        ? "로그인 상태를 확인하고 있습니다."
        : "로그인 상태를 다시 확인하고 있습니다."
    );

    try {
      const { response, body } = await authRequest();

      if (stopped) return;

      if (response.status === 401) {
        endSession("로그인이 필요합니다. 다시 로그인해 주세요.");
        return;
      }

      if (!response.ok) {
        throw new Error(
          "로그인 상태를 확인하지 못했습니다. 잠시 후 새로고침해 주세요."
        );
      }

      const session = readSession(body);

      if (session.expiresAt <= Date.now()) {
        endSession();
        return;
      }

      // 다른 탭에서 계정이 바뀌었다면 기존 화면 상태도 새로 불러옵니다.
      if (currentUser && currentUser.id !== session.user.id) {
        stopped = true;
        clearExpiryTimer();

        window.dispatchEvent(
          new CustomEvent("pds:session-ended", {
            detail: {
              message: "로그인 계정이 변경되었습니다.",
            },
          })
        );

        window.location.reload();
        return;
      }

      showDiary(session);
      settleReady({ ...session.user });
    } catch (error) {
      if (stopped) return;

      hideDiary(error.message);

      if (initial) {
        settleReady(null);
      }
    } finally {
      checking = false;
    }
  }

  async function logout() {
    if (loggingOut || stopped) return;

    loggingOut = true;
    logoutButton.disabled = true;

    hideDiary("로그아웃하고 있습니다.");

    try {
      const { response, body } = await authRequest("logout");

      if (stopped) return;

      if (response.status === 401) {
        endSession("로그인이 종료되었습니다.");
        return;
      }

      if (!response.ok || body?.logged_out !== true) {
        throw new Error(
          "로그아웃을 완료하지 못했습니다. 새로고침 후 다시 시도해 주세요. 서버의 로그인 상태는 아직 남아 있을 수 있습니다."
        );
      }

      endSession("로그아웃되었습니다.");
    } catch (error) {
      if (!stopped) {
        hideDiary(error.message);
      }
    } finally {
      loggingOut = false;
      logoutButton.disabled = false;
    }
  }

  logoutButton.addEventListener("click", logout);

  document.addEventListener("visibilitychange", () => {
    if (stopped) return;

    if (document.hidden) {
      hideDiary("화면으로 돌아오면 로그인 상태를 다시 확인합니다.");
      return;
    }

    // 초기 요청이 끝나기 전에는 중복 확인하지 않습니다.
    if (readySettled) {
      void checkSession();
    }
  });

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;

    // 뒤로 가기로 복원된 개인 기록을 그대로 보여 주지 않습니다.
    hideDiary("로그인 상태를 다시 확인하고 있습니다.");
    window.location.reload();
  });

  window.PdsAuth = Object.freeze({
    ready,

    endSession,

    getUser() {
      return currentUser ? { ...currentUser } : null;
    },

    isActive() {
      return (
        !stopped &&
        currentUser !== null &&
        expiresAt !== null &&
        expiresAt > Date.now()
      );
    },
  });

  void checkSession(true);
})();