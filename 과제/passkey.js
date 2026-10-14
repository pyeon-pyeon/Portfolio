"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    user: null,
    expiresAt: null,
    credentials: [],
    busy: true,
    supported: false,
  };

  let expiryTimer = null;

  const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  });

  class RequestError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.status = status;
    }
  }

  function message(id, content, isError = false) {
    const node = $(id);

    if (!node) return;

    node.textContent = content;
    node.classList.toggle("error", isError);
    node.setAttribute("role", isError ? "alert" : "status");
  }

  function formatDate(raw) {
    const date = new Date(raw);

    return Number.isFinite(date.getTime())
      ? `${dateFormatter.format(date)} KST`
      : "시각 확인 불가";
  }

  function activeSession() {
    return (
      state.user !== null &&
      state.expiresAt !== null &&
      state.expiresAt > Date.now()
    );
  }

  function updateControls() {
    const available = state.supported && !state.busy;

    $("login-fields").disabled =
      !available || activeSession();

    $("registration-fields").disabled =
      !available || activeSession();

    $("additional-fields").disabled =
      !available || !activeSession();

    [
      "logout-button",
      "reload-items-button",
      "reload-credentials-button",
    ].forEach((id) => {
      $(id).disabled = state.busy || !activeSession();
    });

    $("credentials-list")
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = state.busy || !activeSession();
      });
  }

  function setBusy(busy) {
    state.busy = busy;
    updateControls();
  }

  function clearPrivateContent() {
    state.credentials = [];

    $("private-items-list").replaceChildren();
    $("credentials-list").replaceChildren();

    $("account-name").textContent = "";
    $("session-expiry").textContent = "";
    $("credentials-count").textContent = "";

    $("private-items-empty").hidden = true;

    message("private-items-message", "");
    message("credentials-message", "");
    message("additional-message", "");

    $("additional-form").reset();
  }

  function endLocalSession(content = "패스키로 로그인해 주세요.") {
    if (expiryTimer !== null) {
      window.clearTimeout(expiryTimer);
      expiryTimer = null;
    }

    state.user = null;
    state.expiresAt = null;

    clearPrivateContent();

    $("private-area").hidden = true;
    $("auth-area").hidden = false;

    message("connection-status", content);
    updateControls();
  }

  function scheduleExpiry() {
    if (expiryTimer !== null) {
      window.clearTimeout(expiryTimer);
    }

    const remaining = state.expiresAt - Date.now();

    if (remaining <= 0) {
      endLocalSession("로그인이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }

    expiryTimer = window.setTimeout(() => {
      endLocalSession("로그인이 만료되었습니다. 다시 로그인해 주세요.");
    }, remaining);
  }

  function acceptSession(result) {
    const user = result?.user;
    const expires = Date.parse(result?.expires_at);

    if (
      !user ||
      typeof user.id !== "string" ||
      typeof user.account_name !== "string" ||
      typeof user.display_name !== "string" ||
      !Number.isFinite(expires) ||
      expires <= Date.now()
    ) {
      throw new RequestError("로그인 응답 형식이 올바르지 않습니다.");
    }

    state.user = {
      id: user.id,
      account_name: user.account_name,
      display_name: user.display_name,
    };

    state.expiresAt = expires;

    $("account-name").textContent =
      `${user.display_name} · ${user.account_name}`;

    $("session-expiry").textContent =
      `세션 만료: ${formatDate(result.expires_at)}`;

    $("auth-area").hidden = true;
    $("private-area").hidden = false;

    message("connection-status", "패스키로 로그인한 상태입니다.");

    scheduleExpiry();
  }

  async function request(path, method = "GET", body = undefined) {
    const controller = new AbortController();

    const timer = window.setTimeout(() => {
      controller.abort();
    }, 30_000);

    const options = {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    };

    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(path, options);

      let result;

      try {
        result = await response.json();
      } catch {
        throw new RequestError(
          "서버 응답 형식을 확인하지 못했습니다.",
          response.status
        );
      }

      if (!response.ok) {
        if (response.status === 401) {
          endLocalSession(
            "로그인이 없거나 만료되었습니다. 패스키로 로그인해 주세요."
          );
        }

        const serverMessage = result?.error?.message;

        throw new RequestError(
          typeof serverMessage === "string"
            ? serverMessage
            : "요청을 처리하지 못했습니다.",
          response.status
        );
      }

      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new RequestError("서버 응답 형식이 올바르지 않습니다.");
      }

      return result;
    } catch (error) {
      if (error instanceof RequestError) throw error;

      if (error.name === "AbortError") {
        throw new RequestError(
          "응답 시간이 초과되었습니다. 등록·삭제 요청이었다면 목록을 다시 확인해 주세요."
        );
      }

      throw new RequestError(
        "서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요."
      );
    } finally {
      window.clearTimeout(timer);
      delete options.body;
    }
  }

  // ============================================
  // base64url과 바이너리 변환
  // ============================================

  function decodeBase64url(value) {
    const normalized = value
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const padded = normalized.padEnd(
      Math.ceil(normalized.length / 4) * 4,
      "="
    );

    const binary = atob(padded);

    return Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0)
    );
  }

  function encodeBase64url(value) {
    const bytes = new Uint8Array(value);
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function registrationOptionsFromJSON(options) {
    return {
      ...options,

      challenge: decodeBase64url(options.challenge),

      user: {
        ...options.user,
        id: decodeBase64url(options.user.id),
      },

      excludeCredentials: (options.excludeCredentials ?? []).map(
        (credential) => ({
          ...credential,
          id: decodeBase64url(credential.id),
        })
      ),
    };
  }

  function authenticationOptionsFromJSON(options) {
    return {
      ...options,

      challenge: decodeBase64url(options.challenge),

      allowCredentials: (options.allowCredentials ?? []).map(
        (credential) => ({
          ...credential,
          id: decodeBase64url(credential.id),
        })
      ),
    };
  }

  function registrationResponseToJSON(credential) {
    const response = credential.response;

    return {
      id: credential.id,
      rawId: encodeBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment:
        credential.authenticatorAttachment ?? undefined,

      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        attestationObject: encodeBase64url(response.attestationObject),
        transports:
          typeof response.getTransports === "function"
            ? response.getTransports()
            : [],
      },

      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  function authenticationResponseToJSON(credential) {
    const response = credential.response;

    return {
      id: credential.id,
      rawId: encodeBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment:
        credential.authenticatorAttachment ?? undefined,

      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        authenticatorData: encodeBase64url(response.authenticatorData),
        signature: encodeBase64url(response.signature),

        userHandle: response.userHandle
          ? encodeBase64url(response.userHandle)
          : null,
      },

      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  function actionError(error) {
    if (error.name === "NotAllowedError") {
      return (
        "기기 인증이 취소·거절되었거나 시간이 초과되었습니다. " +
        "필요하면 다시 시도해 주세요."
      );
    }

    if (error.name === "InvalidStateError") {
      return (
        "이미 등록된 패스키일 수 있습니다. " +
        "다른 기기나 보안 키를 선택해 주세요."
      );
    }

    if (error.name === "SecurityError") {
      return "접속 주소와 서버의 RP ID 설정을 확인해 주세요.";
    }

    return error.message || "패스키 동작을 완료하지 못했습니다.";
  }

  // ============================================
  // 개인 자료와 패스키 목록
  // ============================================

  async function loadItems() {
    const userId = state.user?.id;

    const result = await request("/api/passkey-private");

    if (!activeSession() || state.user.id !== userId) return;

    if (!Array.isArray(result.items)) {
      throw new RequestError("비공개 자료 응답 형식이 올바르지 않습니다.");
    }

    const fragment = document.createDocumentFragment();

    for (const item of result.items) {
      if (
        typeof item.id !== "string" ||
        typeof item.title !== "string" ||
        typeof item.content !== "string"
      ) {
        throw new RequestError("비공개 자료 형식을 확인해 주세요.");
      }

      const node = document.createElement("li");
      node.className = "private-item";

      const title = document.createElement("h3");
      title.textContent = item.title;

      const content = document.createElement("p");

      // HTML이나 스크립트를 실행하지 않고 글자로 표시합니다.
      content.textContent = item.content;

      node.append(title, content);
      fragment.append(node);
    }

    $("private-items-list").replaceChildren(fragment);
    $("private-items-empty").hidden = result.items.length > 0;

    message(
      "private-items-message",
      `본인 자료 ${result.items.length}개를 조회했습니다.`
    );
  }

  async function loadCredentials() {
    const userId = state.user?.id;

    const result = await request("/api/passkey-credentials");

    if (!activeSession() || state.user.id !== userId) return;

    if (!Array.isArray(result.credentials)) {
      throw new RequestError("패스키 목록 응답 형식이 올바르지 않습니다.");
    }

    for (const credential of result.credentials) {
      if (
        typeof credential.id !== "string" ||
        typeof credential.name !== "string" ||
        typeof credential.created_at !== "string" ||
        typeof credential.current !== "boolean"
      ) {
        throw new RequestError("패스키 목록 형식을 확인해 주세요.");
      }
    }

    state.credentials = result.credentials;

    const fragment = document.createDocumentFragment();

    for (const credential of state.credentials) {
      const item = document.createElement("li");
      item.className = "credential-item";

      const title = document.createElement("h3");
      title.textContent =
        credential.name +
        (credential.current ? " · 현재 로그인에 사용" : "");

      const date = document.createElement("p");
      date.textContent = `등록: ${formatDate(credential.created_at)}`;

      const lastUsed = document.createElement("p");
      lastUsed.textContent = credential.last_used_at
        ? `최근 사용: ${formatDate(credential.last_used_at)}`
        : "로그인에 사용한 기록 없음";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "button danger";
      button.textContent = "패스키 삭제";
      button.disabled = state.busy;

      button.addEventListener("click", () => {
        void deleteCredential(credential);
      });

      item.append(title, date, lastUsed, button);
      fragment.append(item);
    }

    $("credentials-list").replaceChildren(fragment);
    $("credentials-count").textContent =
      `등록된 패스키 ${state.credentials.length}개`;
  }

  async function refreshPrivateArea() {
    const results = await Promise.allSettled([
      loadItems(),
      loadCredentials(),
    ]);

    if (!activeSession()) return;

    if (results[0].status === "rejected") {
      message(
        "private-items-message",
        results[0].reason.message,
        true
      );
    }

    if (results[1].status === "rejected") {
      message(
        "credentials-message",
        results[1].reason.message,
        true
      );
    }
  }

  // ============================================
  // 최초 등록과 추가 등록
  // ============================================

  async function registerPasskey(event, additional = false) {
    event.preventDefault();

    if (state.busy || !state.supported) return;

    const messageId = additional
      ? "additional-message"
      : "registration-message";

    let payload = null;

    setBusy(true);

    try {
      const name = $(
        additional ? "additional-name" : "registration-name"
      ).value.trim();

      if (!name || name.length > 80) {
        throw new Error("패스키 이름을 1~80자로 입력해 주세요.");
      }

      payload = { name };

      if (!additional) {
        payload.account_name = $("registration-account").value;
        payload.invite_token = $("registration-invite").value.trim();

        if (
          !payload.account_name ||
          !/^[0-9a-f]{64}$/.test(payload.invite_token)
        ) {
          throw new Error("계정과 64자리 등록 초대값을 확인해 주세요.");
        }
      }

      message(messageId, "등록 질문을 발급받고 있습니다.");

      const optionsAction = additional ? "add-options" : "options";

      const result = await request(
        `/api/passkey-register?action=${optionsAction}`,
        "POST",
        payload
      );

      // 초대값은 질문 발급 후 입력란과 지역 참조에서 제거합니다.
      if (!additional) {
        $("registration-invite").value = "";
        payload.invite_token = "";
      }

      message(
        messageId,
        "기기의 안내에 따라 패스키 저장 위치를 선택하고 승인해 주세요."
      );

      const credential = await navigator.credentials.create({
        publicKey: registrationOptionsFromJSON(result.options),
      });

      if (!credential) {
        throw new Error("패스키 등록이 완료되지 않았습니다.");
      }

      const verifyAction = additional ? "add-verify" : "verify";

      const saved = await request(
        `/api/passkey-register?action=${verifyAction}`,
        "POST",
        {
          challenge_id: result.challenge_id,
          response: registrationResponseToJSON(credential),
        }
      );

      if (saved.registered !== true) {
        throw new Error("서버의 등록 결과를 확인하지 못했습니다.");
      }

      if (additional) {
        $("additional-form").reset();

        await loadCredentials();

        message("additional-message", "추가 패스키를 등록했습니다.");
      } else {
        const accountName = payload.account_name;

        $("registration-form").reset();
        $("login-account").value = accountName;

        message(
          "registration-message",
          "첫 패스키를 등록했습니다. 패스키 로그인 버튼으로 로그인해 주세요."
        );

        $("registration-details").open = false;

        message(
          "login-message",
          "등록이 완료되었습니다. 패스키로 로그인해 주세요."
        );
      }
    } catch (error) {
      message(messageId, actionError(error), true);
    } finally {
      if (payload) {
        delete payload.invite_token;
      }

      $("registration-invite").value = "";
      setBusy(false);
    }
  }

  // ============================================
  // 로그인과 로그아웃
  // ============================================

  async function login(event) {
    event.preventDefault();

    if (state.busy || !state.supported) return;

    setBusy(true);

    try {
      const accountName = $("login-account").value;

      if (!accountName) {
        throw new Error("로그인할 계정을 선택해 주세요.");
      }

      message("login-message", "로그인 질문을 발급받고 있습니다.");

      const result = await request(
        "/api/passkey-login?action=options",
        "POST",
        { account_name: accountName }
      );

      message("login-message", "등록한 패스키로 기기 인증을 승인해 주세요.");

      const credential = await navigator.credentials.get({
        publicKey: authenticationOptionsFromJSON(result.options),
      });

      if (!credential) {
        throw new Error("패스키 인증이 완료되지 않았습니다.");
      }

      const verified = await request(
        "/api/passkey-login?action=verify",
        "POST",
        {
          challenge_id: result.challenge_id,
          response: authenticationResponseToJSON(credential),
        }
      );

      if (verified.authenticated !== true) {
        throw new Error("서버의 로그인 결과를 확인하지 못했습니다.");
      }

      // 쿠키가 실제로 적용됐는지도 서버 조회로 확인합니다.
      const session = await request("/api/passkey-login");

      if (session.user?.id !== verified.user?.id) {
        throw new Error("로그인 계정이 일치하지 않습니다.");
      }

      acceptSession(session);
      message("login-message", "");

      await refreshPrivateArea();

      if (activeSession()) {
        $("account-title").focus();
      }
    } catch (error) {
      message("login-message", actionError(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (state.busy) return;

    setBusy(true);

    try {
      const result = await request(
        "/api/passkey-login?action=logout",
        "POST",
        {}
      );

      if (result.logged_out !== true) {
        throw new Error("로그아웃 결과를 확인하지 못했습니다.");
      }

      endLocalSession("로그아웃했습니다.");
    } catch (error) {
      // 서버 폐기 여부를 확인하지 못했더라도 화면의 개인 자료는 지웁니다.
      endLocalSession(
        `${error.message} 서버 세션이 남아 있을 수 있으므로 다시 확인해 주세요.`
      );
    } finally {
      setBusy(false);
    }
  }

  // ============================================
  // 패스키 삭제
  // ============================================

  async function deleteCredential(credential) {
    if (state.busy || !activeSession()) return;

    const lastCredential = state.credentials.length === 1;

    const warning = lastCredential
      ? "\n마지막 패스키입니다. 삭제하면 관리자 복구 전까지 로그인할 수 없습니다."
      : "";

    const agreed = window.confirm(
      `"${credential.name}" 패스키를 삭제할까요?\n` +
      "이 패스키로 만든 로그인 세션도 종료됩니다." +
      warning
    );

    if (!agreed) return;

    setBusy(true);

    try {
      const result = await request(
        `/api/passkey-credentials?id=${encodeURIComponent(credential.id)}`,
        "DELETE",
        { confirmation: "패스키 삭제" }
      );

      if (result.deleted !== true) {
        throw new Error("패스키 삭제 결과를 확인하지 못했습니다.");
      }

      if (result.session_ended) {
        endLocalSession(result.message);
        return;
      }

      await loadCredentials();

      message(
        "credentials-message",
        "패스키를 삭제했습니다. 삭제한 패스키로는 로그인할 수 없습니다."
      );
    } catch (error) {
      message("credentials-message", error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function reloadSection(loader, messageId) {
    if (state.busy || !activeSession()) return;

    setBusy(true);

    try {
      await loader();
    } catch (error) {
      if (activeSession()) {
        message(messageId, error.message, true);
      }
    } finally {
      setBusy(false);
    }
  }

  // ============================================
  // 이벤트와 초기화
  // ============================================

  $("login-form").addEventListener("submit", login);

  $("registration-form").addEventListener("submit", (event) => {
    void registerPasskey(event, false);
  });

  $("additional-form").addEventListener("submit", (event) => {
    void registerPasskey(event, true);
  });

  $("logout-button").addEventListener("click", () => {
    void logout();
  });

  $("reload-items-button").addEventListener("click", () => {
    void reloadSection(loadItems, "private-items-message");
  });

  $("reload-credentials-button").addEventListener("click", () => {
    void reloadSection(loadCredentials, "credentials-message");
  });

  $("registration-details").addEventListener("toggle", () => {
    if (!$("registration-details").open) {
      $("registration-invite").value = "";
    }
  });

  // 뒤로 가기로 복원된 개인 화면을 그대로 사용하지 않습니다.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      endLocalSession("로그인 상태를 다시 확인합니다.");
      window.location.reload();
    }
  });

  async function initialize() {
    state.supported = Boolean(
      window.isSecureContext &&
      window.PublicKeyCredential &&
      navigator.credentials?.create &&
      navigator.credentials?.get
    );

    if (!state.supported) {
      endLocalSession(
        "이 환경에서는 패스키를 사용할 수 없습니다. HTTPS 주소와 지원 브라우저를 확인해 주세요."
      );

      setBusy(false);
      return;
    }

    message("connection-status", "로그인 상태를 확인하고 있습니다.");

    try {
      const session = await request("/api/passkey-login");

      acceptSession(session);
      await refreshPrivateArea();
    } catch (error) {
      if (error.status !== 401) {
        endLocalSession(error.message);
      }
    } finally {
      setBusy(false);
    }
  }

  void initialize();
})();