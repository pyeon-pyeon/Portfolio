"use strict";

(() => {
  const gate = document.getElementById("auth-gate");
  const gateMessage = document.getElementById("auth-gate-message");
  const app = document.getElementById("diary-app");
  const accountName = document.getElementById("account-name");
  const logoutButton = document.getElementById("logout-button");

  const deleteForm = document.getElementById("account-delete-form");
  const deleteFields = document.getElementById("account-delete-fields");
  const deletePassword = document.getElementById("account-delete-password");
  const deleteConfirmation = document.getElementById(
    "account-delete-confirmation"
  );
  const deleteMessage = document.getElementById("account-delete-message");
  const deleteDetails = document.getElementById("account-delete-details");

  if (
    !gate ||
    !gateMessage ||
    !app ||
    !accountName ||
    !logoutButton ||
    !deleteForm ||
    !deleteFields ||
    !deletePassword ||
    !deleteConfirmation ||
    !deleteMessage ||
    !deleteDetails
  ) {
    throw new Error("diary.html의 인증·계정 삭제 요소를 확인하세요.");
  }

  const REQUEST_TIMEOUT_MS = 15_000;
  const MAX_TIMER_MS = 2_147_483_647;

  let currentUser = null;
  let expiresAt = null;
  let expiryTimer = null;
  let checking = false;
  let loggingOut = false;
  let deleting = false;
  let stopped = false;
  let readySettled = false;
  let sessionVerified = false;
  let resolveReady;

  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function settleReady(value) {
    if (readySettled) return;

    readySettled = true;
    resolveReady(value);
  }

  function isActive() {
    return (
      !stopped &&
      currentUser !== null &&
      expiresAt !== null &&
      expiresAt > Date.now()
    );
  }

  function updateControls() {
    logoutButton.disabled =
      stopped || checking || loggingOut || deleting || !isActive();

    deleteFields.disabled =
      !sessionVerified ||
      document.hidden ||
      stopped ||
      checking ||
      loggingOut ||
      deleting ||
      !isActive();
  }

  function clearDeleteInputs() {
    deletePassword.value = "";
    deleteConfirmation.value = "";
  }

  function showDeleteMessage(message, isError = false) {
    deleteMessage.textContent = message;
    deleteMessage.classList.toggle("is-error", isError);
    deleteMessage.setAttribute("role", isError ? "alert" : "status");
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
    sessionVerified = false;

    clearExpiryTimer();
    clearDeleteInputs();

    currentUser = null;
    expiresAt = null;

    hideDiary(message);
    updateControls();
    settleReady(null);

    window.dispatchEvent(
      new CustomEvent("pds:session-ended", {
        detail: { message },
      })
    );

    window.location.replace(loginUrl());
  }

  async function authRequest(action = null, payload = undefined) {
    if (
      action !== null &&
      action !== "logout" &&
      action !== "delete-account"
    ) {
      throw new Error("지원하지 않는 인증 요청입니다.");
    }

    const controller = new AbortController();

    const timeout = window.setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const isPost = action !== null;
    const url = isPost
      ? `/api/auth?action=${encodeURIComponent(action)}`
      : "/api/auth";

    const options = {
      method: isPost ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    };

    if (isPost) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(payload ?? {});
    }

    try {
      const response = await fetch(url, options);

      let body = null;

      try {
        body = await response.json();
      } catch {
        //호출한 쪽에서 응답 형식을 확인합니다.
      }

      return { response, body };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "응답 시간이 초과되었습니다."
        );
      }

      throw new Error("서버에 연결하지 못했습니다.");
    } finally {
      window.clearTimeout(timeout);

      // 지역 변수에서 전송 내용을 제거합니다.
      // JavaScript 메모리에서 완전히 지워진다는 보장은 없습니다.
      delete options.body;
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
    sessionVerified = true;

    accountName.textContent = `${currentUser.display_name}님`;

    if (!document.hidden) {
      gate.hidden = true;
      app.hidden = false;
    }

    scheduleExpiry();
    updateControls();
  }

  function restoreDiary() {
    if (!sessionVerified || !isActive()) return;

    if (!document.hidden) {
      gate.hidden = true;
      app.hidden = false;
    }
  }

  async function checkSession(initial = false) {
    if (checking || loggingOut || deleting || stopped) return;

    checking = true;
    sessionVerified = false;
    updateControls();

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

      if (currentUser && currentUser.id !== session.user.id) {
        stopped = true;
        sessionVerified = false;

        clearExpiryTimer();
        clearDeleteInputs();

        currentUser = null;
        expiresAt = null;

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
      updateControls();
    }
  }

  async function logout() {
    if (loggingOut || deleting || checking || stopped) return;

    loggingOut = true;
    clearDeleteInputs();
    updateControls();

    hideDiary("로그아웃하고 있습니다.");

    try {
      const { response, body } = await authRequest("logout");

      if (stopped) return;

      if (response.status === 401) {
        endSession("로그인이 종료되었습니다.");
        return;
      }

      if (!response.ok || body?.logged_out !== true) {
        throw new Error("로그아웃 결과를 확인하지 못했습니다.");
      }

      endSession("로그아웃되었습니다.");
    } catch (error) {
      if (!stopped) {
        sessionVerified = false;

        hideDiary(
          `${error.message} 서버의 로그인 상태가 남아 있을 수 있습니다. ` +
          "새로고침 후 다시 시도해 주세요."
        );
      }
    } finally {
      loggingOut = false;
      updateControls();
    }
  }

  function readDeletePassword() {
    const password = deletePassword.value;

    if (
      password.length < 10 ||
      new TextEncoder().encode(password).length > 72 ||
      password.includes("\0")
    ) {
      throw new Error(
        "현재 비밀번호를 확인해 주세요. 10자 이상, UTF-8 기준 72바이트 이하여야 합니다."
      );
    }

    return password;
  }

  async function deleteAccount(event) {
    event.preventDefault();

    if (
      stopped ||
      checking ||
      loggingOut ||
      deleting ||
      !sessionVerified
    ) {
      return;
    }

    if (!isActive()) {
      endSession();
      return;
    }

    let payload = null;

    try {
      if (deleteConfirmation.value !== "계정 삭제") {
        throw new Error(
          '삭제 확인 문구에 "계정 삭제"를 정확히 입력해 주세요.'
        );
      }

      payload = {
        password: readDeletePassword(),
        confirmation: "계정 삭제",
      };

      const agreed = window.confirm(
        "계정과 연결된 모든 계획·할 일·실행 기록을 삭제할까요?\n" +
        "이 작업은 앱에서 되돌릴 수 없습니다."
      );

      if (!agreed) return;

      deleting = true;
      updateControls();

      showDeleteMessage("계정과 연결된 자료를 삭제하고 있습니다.");
      hideDiary("계정과 연결된 자료를 삭제하고 있습니다.");

      // 비밀번호는 입력란에 남겨 두지 않습니다.
      deletePassword.value = "";

      const { response, body } = await authRequest(
        "delete-account",
        payload
      );

      if (stopped) return;

      if (response.status === 401) {
        endSession("로그인이 종료되었습니다. 다시 로그인해 주세요.");
        return;
      }

      if (response.status === 403) {
        if (body?.error?.code === "invalid_password") {
          throw new Error(
            "현재 비밀번호가 올바르지 않습니다. 다시 입력해 주세요."
          );
        }

        throw new Error(
          "삭제 요청이 거절되었습니다. 접속 주소를 확인해 주세요."
        );
      }

      if (response.status === 400 || response.status === 415) {
        throw new Error(
          "삭제 요청의 입력값 또는 형식을 확인해 주세요."
        );
      }

      if (
        !response.ok ||
        body?.deleted !== true ||
        body?.logged_out !== true
      ) {
        throw new Error(
          "계정 삭제 결과를 확인하지 못했습니다. " +
          "이미 삭제되었을 수 있으므로 로그인 상태를 다시 확인해 주세요."
        );
      }

      endSession("계정과 연결된 자료가 삭제되었습니다.");
    } catch (error) {
      if (!stopped) {
        restoreDiary();
        deleteDetails.open = true;

        showDeleteMessage(
          `${error.message} 응답을 받지 못했다면 삭제가 완료되었을 수도 있습니다.`,
          true
        );
      }
    } finally {
      if (payload) {
        payload.password = "";
        payload = null;
      }

      deletePassword.value = "";
      deleting = false;
      updateControls();

      if (!stopped && !document.hidden && !app.hidden) {
        deletePassword.focus();
      }
    }
  }

  logoutButton.addEventListener("click", logout);
  deleteForm.addEventListener("submit", deleteAccount);

  deleteDetails.addEventListener("toggle", () => {
    if (!deleteDetails.open) {
      clearDeleteInputs();
      showDeleteMessage("");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (stopped) return;

    if (document.hidden) {
      clearDeleteInputs();
      updateControls();

      hideDiary("화면으로 돌아오면 로그인 상태를 다시 확인합니다.");
      return;
    }

    if (readySettled && !loggingOut && !deleting) {
      void checkSession();
    }
  });

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;

    clearDeleteInputs();
    hideDiary("로그인 상태를 다시 확인하고 있습니다.");
    window.location.reload();
  });

  window.PdsAuth = Object.freeze({
    ready,
    endSession,
    isActive,

    getUser() {
      return currentUser ? { ...currentUser } : null;
    },
  });

  updateControls();
  void checkSession(true);
})();