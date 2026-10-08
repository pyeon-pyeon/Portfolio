"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  let busy = true;
  let activeScreen = "login";

  class RequestError extends Error {
    constructor(message, status = 0, code = "") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  function message(id, text, state = "idle") {
    $(id).textContent = text;
    $(id).dataset.state = state;
  }

  function updateControls() {
    $("show-login-button").disabled = busy;
    $("show-signup-button").disabled = busy;

    $("login-fields").disabled =
      busy || activeScreen !== "login";

    $("signup-fields").disabled =
      busy || activeScreen !== "signup";

    $("main").setAttribute("aria-busy", String(busy));
  }

  function showScreen(screen, moveFocus = true) {
    activeScreen = screen;

    const login = screen === "login";

    $("login-section").hidden = !login;
    $("signup-section").hidden = login;

    $("show-login-button").setAttribute(
      "aria-pressed",
      String(login)
    );

    $("show-signup-button").setAttribute(
      "aria-pressed",
      String(!login)
    );

    // 화면 전환 시 비밀번호 입력을 비웁니다.
    $("login-password").value = "";
    $("signup-password").value = "";
    $("signup-password-confirm").value = "";

    message("login-message", "");
    message("signup-message", "");

    updateControls();

    if (moveFocus) {
      $(login ? "login-title" : "signup-title").focus();
    }
  }

  function readEmail(id) {
    const email = $(id).value.trim().toLowerCase();

    if (
      email.length < 3 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.includes("\u0000")
    ) {
      throw new Error("이메일 형식을 확인해 주세요.");
    }

    return email;
  }

  function readPassword(id) {
    const password = $(id).value;
    const bytes = new TextEncoder().encode(password).length;

    if (
      password.length < 10 ||
      bytes > 72 ||
      password.includes("\u0000")
    ) {
      throw new Error(
        "비밀번호는 10자 이상, UTF-8 기준 72바이트 이내로 입력해 주세요."
      );
    }

    return password;
  }

  function readDisplayName() {
    const name = $("signup-name").value.trim();

    if (
      !name ||
      name.length > 50 ||
      name.includes("\u0000")
    ) {
      throw new Error("표시 이름은 1~50자로 입력해 주세요.");
    }

    return name;
  }

  function responseMessage(status, code) {
    if (status === 401) {
      return "이메일 또는 비밀번호가 올바르지 않습니다.";
    }

    const messages = {
      duplicate: "이미 등록된 이메일입니다. 로그인해 주세요.",
      validation: "입력 내용을 확인해 주세요.",
      forbidden: "요청 출처가 허용되지 않았습니다. APP_ORIGIN 설정을 확인해 주세요.",
      configuration: "서버 환경변수 설정을 확인해 주세요.",
      storage: "DB 요청에 실패했습니다. 잠시 후 다시 확인해 주세요.",
    };

    return messages[code] ?? "서버 요청에 실패했습니다.";
  }

  async function request(path, method = "GET", payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const options = {
        method,
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      };

      if (payload !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(payload);
      }

      const response = await fetch(path, options);

      let body;

      try {
        body = await response.json();
      } catch {
        throw new RequestError(
          "서버 응답을 읽지 못했습니다. API 배포 상태를 확인해 주세요.",
          response.status
        );
      }

      if (!response.ok) {
        const code = body?.error?.code ?? "";

        throw new RequestError(
          responseMessage(response.status, code),
          response.status,
          code
        );
      }

      return body;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new RequestError(
          "응답 시간이 초과됐습니다. 작업이 처리됐을 수 있으니 로그인 상태를 다시 확인해 주세요."
        );
      }

      if (error instanceof TypeError) {
        throw new RequestError(
          "서버에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요."
        );
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function validateUserResponse(body) {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !body?.user ||
      !uuid.test(body.user.id) ||
      typeof body.user.email !== "string" ||
      typeof body.user.display_name !== "string"
    ) {
      throw new Error("계정 응답 형식이 올바르지 않습니다.");
    }
  }

  function goToDiary() {
    // 사용자 입력으로 이동 주소를 정하지 않습니다.
    window.location.replace("./diary.html");
  }

  // --------------------------------------------------
  // 로그인
  // --------------------------------------------------

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (busy || activeScreen !== "login") return;

    let payload;

    try {
      payload = {
        email: readEmail("login-email"),
        password: readPassword("login-password"),
      };
    } catch (error) {
      message("login-message", error.message, "error");
      return;
    }

    busy = true;
    updateControls();

    message("auth-status", "로그인 요청을 처리하는 중입니다.", "loading");
    message("login-message", "");

    let moving = false;

    try {
      const body = await request(
        "/api/auth?action=login",
        "POST",
        payload
      );

      validateUserResponse(body);

      // 쿠키가 실제로 적용되어 서버가 세션을 인정하는지도 확인합니다.
      const current = await request("/api/auth");
      validateUserResponse(current);

      if (current.user.id !== body.user.id) {
        throw new Error("로그인 계정 확인에 실패했습니다.");
      }

      message("auth-status", "로그인되었습니다. 다이어리로 이동합니다.", "success");

      moving = true;
      goToDiary();
    } catch (error) {
      message("login-message", error.message, "error");
      message("auth-status", "로그인을 완료하지 못했습니다.", "error");
    } finally {
      $("login-password").value = "";

      // 입력값을 별도로 보존하지 않습니다.
      payload.password = "";

      if (!moving) {
        busy = false;
        updateControls();
      }
    }
  });

  // --------------------------------------------------
  // 가입
  // --------------------------------------------------

  $("signup-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (busy || activeScreen !== "signup") return;

    let payload;

    try {
      const password = readPassword("signup-password");

      if (password !== $("signup-password-confirm").value) {
        throw new Error("비밀번호 확인이 일치하지 않습니다.");
      }

      payload = {
        email: readEmail("signup-email"),
        display_name: readDisplayName(),
        password,
      };
    } catch (error) {
      message("signup-message", error.message, "error");
      return;
    }

    busy = true;
    updateControls();

    message("auth-status", "가입 요청을 처리하는 중입니다.", "loading");
    message("signup-message", "");

    try {
      const body = await request(
        "/api/auth?action=signup",
        "POST",
        payload
      );

      validateUserResponse(body);

      $("signup-form").reset();
      $("login-email").value = body.user.email;

      showScreen("login", false);

      message(
        "auth-status",
        "가입되었습니다. 방금 만든 계정으로 로그인해 주세요.",
        "success"
      );

      message(
        "login-message",
        "가입한 이메일을 입력했습니다. 비밀번호를 입력해 로그인하세요.",
        "success"
      );
    } catch (error) {
      message("signup-message", error.message, "error");
      message("auth-status", "가입을 완료하지 못했습니다.", "error");
    } finally {
      $("signup-password").value = "";
      $("signup-password-confirm").value = "";
      payload.password = "";

      busy = false;
      updateControls();

      if (activeScreen === "login") {
        $("login-password").focus();
      }
    }
  });

  // --------------------------------------------------
  // 화면 전환
  // --------------------------------------------------

  $("show-login-button").addEventListener("click", () => {
    if (!busy) showScreen("login");
  });

  $("show-signup-button").addEventListener("click", () => {
    if (!busy) showScreen("signup");
  });

  // 뒤로 가기로 복원된 페이지에서도 로그인 상태를 다시 확인합니다.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      window.location.reload();
    }
  });

  // --------------------------------------------------
  // 최초 로그인 상태 확인
  // --------------------------------------------------

  async function initialize() {
    busy = true;
    updateControls();

    message("auth-status", "로그인 상태를 확인하는 중입니다.", "loading");

    let moving = false;

    try {
      const body = await request("/api/auth");
      validateUserResponse(body);

      moving = true;
      goToDiary();
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status === 401
      ) {
        message("auth-status", "계정으로 로그인해 주세요.");
      } else {
        message(
          "auth-status",
          `${error.message} 문제가 해결되면 페이지를 새로고침해 주세요.`,
          "error"
        );
      }
    } finally {
      if (!moving) {
        busy = false;
        updateControls();
      }
    }
  }

  initialize();
})();