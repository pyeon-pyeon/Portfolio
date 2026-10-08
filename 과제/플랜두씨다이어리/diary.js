"use strict";

(() => {
  const REQUEST_TIMEOUT_MS = 30_000;

  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const kstDateFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const state = {
    plans: [],
    tasks: [],
    logs: [],
    selectedPlanId: null,
    loaded: false,
    busy: false,
    period: {
      start: "",
      end: "",
    },
  };

  let sessionEnded = false;
  let initialized = false;
  let renderedPlanId = null;

  const activeRequests = new Set();

  class RequestError extends Error {
    constructor(message, status = 0, code = "") {
      super(message);

      this.name = "RequestError";
      this.status = status;
      this.code = code;
    }
  }

  function element(id) {
    return document.getElementById(id);
  }

  function today() {
    return kstDateFormatter.format(new Date());
  }

  function connectionMessage(content, isError = false) {
    const node = element("connection-status");

    if (!node) return;

    node.textContent = content;
    node.classList.toggle("is-error", isError);
    node.setAttribute("role", isError ? "alert" : "status");
  }

  function ensureSession() {
    if (sessionEnded || !window.PdsAuth?.isActive()) {
      window.PdsAuth?.endSession();

      throw new RequestError(
        "로그인이 종료되었습니다. 다시 로그인해 주세요.",
        401,
        "unauthorized"
      );
    }
  }

  function apiPath(raw) {
    const url = new URL(raw, window.location.origin);

    if (
      url.origin !== window.location.origin ||
      !["/api/plans", "/api/tasks", "/api/logs"].includes(url.pathname)
    ) {
      throw new RequestError("허용되지 않은 API 주소입니다.");
    }

    return `${url.pathname}${url.search}`;
  }

  function errorMessage(status, code) {
    if (status === 401) {
      return "로그인이 종료되었습니다. 다시 로그인해 주세요.";
    }

    if (status === 403) {
      return "이 요청을 실행할 권한이 없습니다.";
    }

    if (status === 404) {
      return "기록을 찾지 못했습니다. 데이터를 다시 조회해 주세요.";
    }

    if (status === 409) {
      if (code === "duplicate_request") {
        return "요청 ID가 이미 사용되었습니다. 기록을 다시 조회해 주세요.";
      }

      return (
        "다른 요청으로 자료가 변경되었거나 중복된 요청입니다. " +
        "데이터를 다시 조회한 뒤 시도해 주세요."
      );
    }

    if (status === 400 || status === 422) {
      return "입력값을 확인해 주세요. 날짜·시간·필수 항목을 확인하세요.";
    }

    if (status === 429) {
      return "요청이 많습니다. 잠시 후 다시 시도해 주세요.";
    }

    return "서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }

  async function request(path, method = "GET", body = undefined) {
    ensureSession();

    const url = apiPath(path);
    const controller = new AbortController();

    let timedOut = false;

    activeRequests.add(controller);

    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const headers = {
        Accept: "application/json",
      };

      const options = {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (response.status === 401) {
        window.PdsAuth?.endSession();

        throw new RequestError(
          errorMessage(401),
          401,
          "unauthorized"
        );
      }

      let result;

      try {
        result = await response.json();
      } catch {
        throw new RequestError(
          "서버 응답 형식이 올바르지 않습니다.",
          response.status
        );
      }

      // 요청 중 로그아웃되었다면 받은 개인 자료를 사용하지 않습니다.
      ensureSession();

      if (!response.ok) {
        const code =
          typeof result?.error?.code === "string"
            ? result.error.code
            : typeof result?.code === "string"
              ? result.code
              : "";

        throw new RequestError(
          errorMessage(response.status, code),
          response.status,
          code
        );
      }

      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new RequestError("서버 응답 형식을 확인해 주세요.");
      }

      return result;
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }

      if (sessionEnded) {
        throw new RequestError(
          "로그인이 종료되었습니다.",
          401,
          "unauthorized"
        );
      }

      if (error.name === "AbortError") {
        throw new RequestError(
          timedOut
            ? "응답 시간이 초과되었습니다. 저장 요청이었다면 먼저 기록을 다시 조회해 주세요."
            : "요청이 중단되었습니다."
        );
      }

      throw new RequestError(
        "서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. " +
        "저장 요청이었다면 다시 저장하기 전에 기록을 조회해 주세요."
      );
    } finally {
      window.clearTimeout(timer);
      activeRequests.delete(controller);
    }
  }

  function validId(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
  }

  function validDate(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
      return false;
    }

    const parsed = new Date(`${value}T00:00:00Z`);

    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }

  function validTimestamp(value) {
    return (
      typeof value === "string" &&
      Number.isFinite(Date.parse(value))
    );
  }

  function validInteger(value, min, max) {
    return (
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max
    );
  }

  function assert(condition, message) {
    if (!condition) {
      throw new RequestError(message);
    }
  }

  function assertUniqueIds(rows, label) {
    const ids = rows.map((row) => row.id);

    assert(
      new Set(ids).size === ids.length,
      `${label} 응답에 중복 ID가 있습니다.`
    );
  }

  function validateSnapshot(plans, tasks, logs) {
    const user = window.PdsAuth.getUser();

    assert(
      Array.isArray(plans) &&
      Array.isArray(tasks) &&
      Array.isArray(logs),
      "자료 목록 응답 형식을 확인해 주세요."
    );

    for (const plan of plans) {
      assert(
        plan &&
        validId(plan.id) &&
        plan.owner_id === user?.id &&
        typeof plan.title === "string" &&
        typeof plan.goal === "string" &&
        typeof plan.success_criteria === "string" &&
        typeof plan.reflection === "string" &&
        typeof plan.next_action === "string" &&
        validDate(plan.start_date) &&
        validDate(plan.end_date) &&
        plan.end_date >= plan.start_date &&
        ["high", "medium", "low"].includes(plan.priority) &&
        validInteger(plan.estimated_minutes, 0, 525600) &&
        validInteger(plan.version, 1, Number.MAX_SAFE_INTEGER) &&
        validTimestamp(plan.created_at) &&
        validTimestamp(plan.updated_at) &&
        (
          plan.previous_plan_id === null ||
          validId(plan.previous_plan_id)
        ) &&
        (
          plan.reviewed_at === null ||
          validTimestamp(plan.reviewed_at)
        ),
        "계획 자료의 형식 또는 소유자를 확인하지 못했습니다."
      );
    }

    assertUniqueIds(plans, "계획");

    const planIds = new Set(plans.map((plan) => plan.id));

    for (const task of tasks) {
      assert(
        task &&
        validId(task.id) &&
        planIds.has(task.plan_id) &&
        typeof task.title === "string" &&
        validDate(task.due_date) &&
        ["high", "medium", "low"].includes(task.priority) &&
        ["todo", "doing", "done", "cancelled"].includes(task.status) &&
        validInteger(task.estimated_minutes, 1, 1440) &&
        validInteger(task.sort_order, 0, Number.MAX_SAFE_INTEGER) &&
        Array.isArray(task.tags) &&
        task.tags.length <= 10 &&
        task.tags.every(
          (tag) =>
            typeof tag === "string" &&
            tag.length >= 1 &&
            tag.length <= 30
        ) &&
        validTimestamp(task.created_at) &&
        validTimestamp(task.updated_at),
        "할 일 자료의 형식 또는 계획 연결이 올바르지 않습니다."
      );
    }

    assertUniqueIds(tasks, "할 일");

    const taskIds = new Set(tasks.map((task) => task.id));

    for (const log of logs) {
      const hasTimes =
        validTimestamp(log?.started_at) &&
        validTimestamp(log?.ended_at);

      // 이전 과제에서 저장한 시각 없는 기록도 표시할 수 있습니다.
      const legacyTimes =
        log?.started_at === null &&
        log?.ended_at === null;

      assert(
        log &&
        validId(log.id) &&
        taskIds.has(log.task_id) &&
        validId(log.client_request_id) &&
        validDate(log.performed_on) &&
        validInteger(log.actual_minutes, 1, 1440) &&
        typeof log.note === "string" &&
        typeof log.blocked_reason === "string" &&
        validTimestamp(log.created_at) &&
        validTimestamp(log.updated_at) &&
        (hasTimes || legacyTimes),
        "실행 기록의 형식 또는 할 일 연결이 올바르지 않습니다."
      );

      if (hasTimes) {
        const elapsed =
          Date.parse(log.ended_at) - Date.parse(log.started_at);

        assert(
          elapsed > 0 &&
          elapsed <= 86_400_000 &&
          Math.ceil(elapsed / 60_000) === log.actual_minutes &&
          kstDateFormatter.format(new Date(log.started_at)) ===
            log.performed_on,
          "실행 기록의 시각과 실제 소요 시간이 일치하지 않습니다."
        );
      }
    }

    assertUniqueIds(logs, "실행 기록");
  }

  async function fetchSnapshot() {
    const results = await Promise.allSettled([
      request("/api/plans"),
      request("/api/tasks"),
      request("/api/logs"),
    ]);

    ensureSession();

    const failed = results.find(
      (result) => result.status === "rejected"
    );

    if (failed) {
      throw failed.reason;
    }

    const plans = results[0].value.plans;
    const tasks = results[1].value.tasks;
    const logs = results[2].value.logs;

    validateSnapshot(plans, tasks, logs);
    ensureSession();

    // 세 목록이 모두 정상일 때 한꺼번에 교체합니다.
    state.plans = plans;
    state.tasks = tasks;
    state.logs = logs;

    if (
      state.selectedPlanId &&
      !plans.some((plan) => plan.id === state.selectedPlanId)
    ) {
      state.selectedPlanId = null;
    }

    state.loaded = true;
  }

  function setFormEnabled(formId, enabled) {
    const form = element(formId);

    if (!form) return;

    form.querySelectorAll("fieldset").forEach((fieldset) => {
      fieldset.disabled = !enabled;
    });
  }

  function updateControls() {
    const available =
      state.loaded &&
      !state.busy &&
      !sessionEnded &&
      window.PdsAuth?.isActive();

    const hasPlan = state.plans.some(
      (plan) => plan.id === state.selectedPlanId
    );

    const hasTasks = state.tasks.some(
      (task) => task.plan_id === state.selectedPlanId
    );

    setFormEnabled("plan-form", available);
    setFormEnabled("task-form", available && hasPlan);
    setFormEnabled("task-filter-form", available && hasPlan);
    setFormEnabled("log-form", available && hasPlan && hasTasks);
    setFormEnabled("review-form", available && hasPlan);
    setFormEnabled("summary-filter-form", available);

    const newPlanButton = element("new-plan-button");

    if (newPlanButton) {
      newPlanButton.disabled = !available;
    }

    const reloadButton = element("reload-button");

    if (reloadButton) {
      reloadButton.disabled =
        state.busy ||
        sessionEnded ||
        !window.PdsAuth?.isActive();
    }
  }

  function render() {
    if (!initialized || sessionEnded) return;

    const selectionChanged = renderedPlanId !== state.selectedPlanId;

    if (selectionChanged) {
      renderedPlanId = state.selectedPlanId;

      window.PdsLog.resetForm();
      window.PdsSee.fillReviewForm();
    }

    window.PdsPlan.render();
    window.PdsLog.render();
    window.PdsSee.render();

    updateControls();
  }

  function setBusy(busy) {
    state.busy = busy;
    render();
  }

  async function reload() {
    if (state.busy || sessionEnded) return;

    setBusy(true);
    connectionMessage("서버에서 기록을 불러오고 있습니다.");

    try {
      await fetchSnapshot();

      window.PdsPlan.fillPlanForm();
      window.PdsLog.resetForm();
      window.PdsSee.fillReviewForm();

      connectionMessage(
        `조회 완료 · 계획 ${state.plans.length}개 · ` +
        `할 일 ${state.tasks.length}개 · ` +
        `실행 기록 ${state.logs.length}개`
      );
    } catch (error) {
      if (!sessionEnded) {
        connectionMessage(
          state.loaded
            ? `${error.message} 마지막으로 조회한 자료를 표시합니다.`
            : error.message,
          true
        );
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  async function save(path, method, body = undefined) {
    ensureSession();

    if (state.busy) {
      throw new RequestError(
        "이전 요청을 처리하고 있습니다. 잠시 기다려 주세요."
      );
    }

    if (!["POST", "PATCH", "DELETE"].includes(method)) {
      throw new RequestError("저장 요청 방식을 확인해 주세요.");
    }

    const url = new URL(apiPath(path), window.location.origin);
    const resource = url.pathname.split("/").pop();

    let serverSaved = false;

    setBusy(true);
    connectionMessage("변경 내용을 저장하고 있습니다.");

    try {
      const result = await request(path, method, body);

      // 삭제 응답 형식은 서버 구현에 따라 달라질 수 있으므로
      // POST·PATCH의 자료 응답만 여기에서 확인합니다.
      if (method !== "DELETE") {
        const recordName = {
          plans: "plan",
          tasks: "task",
          logs: "log",
        }[resource];

        assert(
          recordName &&
          result[recordName] &&
          validId(result[recordName].id),
          "저장 응답 형식을 확인하지 못했습니다. 기록을 다시 조회해 주세요."
        );
      }

      serverSaved = true;

      await fetchSnapshot();

      if (resource === "plans") {
        if (
          method === "POST" &&
          state.plans.some((plan) => plan.id === result.plan.id)
        ) {
          state.selectedPlanId = result.plan.id;
        }

        window.PdsPlan.fillPlanForm();
      }

      connectionMessage("저장과 데이터 재조회를 완료했습니다.");

      return result;
    } catch (error) {
      if (sessionEnded) throw error;

      const message = serverSaved
        ? (
            "서버 저장은 완료했지만 최신 자료를 다시 조회하지 못했습니다. " +
            "새로고침 버튼으로 확인해 주세요. " +
            error.message
          )
        : error.message;

      connectionMessage(message, true);

      throw new RequestError(
        message,
        error.status ?? 0,
        error.code ?? ""
      );
    } finally {
      state.busy = false;
      render();
    }
  }

  function clearSessionState() {
    sessionEnded = true;

    activeRequests.forEach((controller) => {
      controller.abort();
    });

    activeRequests.clear();

    state.plans = [];
    state.tasks = [];
    state.logs = [];
    state.selectedPlanId = null;
    state.loaded = false;
    state.busy = false;

    renderedPlanId = null;

    connectionMessage("로그인이 종료되었습니다.");
    updateControls();
  }

  async function initialize() {
    if (
      !window.PdsAuth ||
      !window.PdsView ||
      !window.PdsPlan ||
      !window.PdsLog ||
      !window.PdsSee
    ) {
      connectionMessage(
        "필요한 파일을 불러오지 못했습니다. HTML의 스크립트 경로와 순서를 확인하세요.",
        true
      );

      return;
    }

    const user = await window.PdsAuth.ready;

    if (!user || sessionEnded) return;

    const sharedContext = Object.freeze({
      state,
      request,
      save,
      render,
      today,
    });

    window.PdsPlan.init(sharedContext);
    window.PdsLog.init(sharedContext);
    window.PdsSee.init(sharedContext);

    initialized = true;

    element("reload-button")?.addEventListener("click", () => {
      if (
        state.loaded &&
        !window.confirm(
          "서버 자료를 다시 조회할까요?\n저장하지 않은 폼 입력은 초기화됩니다."
        )
      ) {
        return;
      }

      void reload();
    });

    render();
    await reload();
  }

  window.addEventListener(
    "pds:session-ended",
    clearSessionState
  );

  void initialize().catch((error) => {
    if (!sessionEnded) {
      connectionMessage(
        `초기화하지 못했습니다. ${error.message}`,
        true
      );
    }
  });
})();