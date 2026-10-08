"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const STATUS = {
    todo: "할 예정",
    doing: "진행 중",
    done: "완료",
    cancelled: "취소",
  };

  const PRIORITY = {
    high: "높음",
    medium: "보통",
    low: "낮음",
  };

  const SORT_LABEL = {
    manual: "등록 순서",
    due_asc: "마감일 빠른 순",
    priority_desc: "우선순위 높은 순",
    estimated_asc: "예상 시간 짧은 순",
    newest: "최근 등록 순",
  };

  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const nf = new Intl.NumberFormat("ko-KR");

  const state = {
    plans: [],
    tasks: [],
    logs: [],
    selectedPlanId: null,
    loaded: false,
    busy: false,
    period: { start: "", end: "" },
    filter: {
      search: "",
      status: "all",
      priority: "all",
      tag: "",
      sort: "manual",
    },
    evidenceType: null,
    evidenceTrigger: null,
    pendingLog: null,
  };

  // ==================================================
  // 날짜와 입력
  // ==================================================

  function kstParts(value = new Date()) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(value));
  }

  function kstDate(value = new Date()) {
    const parts = kstParts(value);
    const get = (type) =>
      parts.find((part) => part.type === type).value;

    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function localKstInput(value = new Date()) {
    const parts = kstParts(value);
    const get = (type) =>
      parts.find((part) => part.type === type).value;

    return (
      `${get("year")}-${get("month")}-${get("day")}T` +
      `${get("hour")}:${get("minute")}:${get("second")}`
    );
  }

  function formatTime(value) {
    const date = new Date(value);

    if (!Number.isFinite(date.getTime())) {
      return "시각 정보 없음";
    }

    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function validDate(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
      return false;
    }

    const date = new Date(`${value}T00:00:00Z`);

    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }

  function readDate(id) {
    const value = $(id).value;

    if (!validDate(value)) {
      throw new Error("올바른 날짜를 입력해 주세요.");
    }

    return value;
  }

  function readText(id, max, required = false) {
    const value = $(id).value.trim();

    if (
      (required && !value) ||
      value.length > max ||
      value.includes("\u0000")
    ) {
      throw new Error(
        `내용은 ${required ? "1~" : ""}${max}자 이내로 입력해 주세요.`
      );
    }

    return value;
  }

  function readInteger(id, max) {
    const raw = $(id).value.trim();
    const value = Number(raw);

    if (
      !raw ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > max
    ) {
      throw new Error(`시간은 1~${max}분 사이 정수로 입력해 주세요.`);
    }

    return value;
  }

  function readChoice(id, choices) {
    const value = $(id).value;

    if (!Object.hasOwn(choices, value)) {
      throw new Error("선택 항목을 확인해 주세요.");
    }

    return value;
  }

  function readTags() {
    const raw = $("task-tags").value.trim();

    if (!raw) return [];

    const tags = raw.split(",").map((tag) => tag.trim());

    if (
      tags.length > 10 ||
      tags.some(
        (tag) =>
          !tag ||
          tag.length > 30 ||
          tag.includes("\u0000")
      )
    ) {
      throw new Error(
        "태그는 빈 항목 없이 태그당 30자, 최대 10개로 입력해 주세요."
      );
    }

    return [...new Set(tags)];
  }

  // datetime-local 입력을 컴퓨터 시간대와 무관하게 KST로 해석합니다.
  function readKstTimestamp(id) {
    const value = $(id).value;
    const match = value.match(
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
    );

    if (
      !match ||
      !validDate(match[1]) ||
      Number(match[2]) > 23 ||
      Number(match[3]) > 59 ||
      Number(match[4] ?? "0") > 59
    ) {
      throw new Error("올바른 시작·종료 시각을 입력해 주세요.");
    }

    const timestamp =
      `${match[1]}T${match[2]}:${match[3]}:` +
      `${match[4] ?? "00"}+09:00`;

    return new Date(timestamp).toISOString();
  }

  function durationMinutes(start, end) {
    const diff = Date.parse(end) - Date.parse(start);

    if (
      !Number.isFinite(diff) ||
      diff <= 0 ||
      diff > 86400000
    ) {
      throw new Error(
        "종료는 시작 이후여야 하며 한 기록은 24시간 이내여야 합니다."
      );
    }

    return Math.ceil(diff / 60000);
  }

  function updateDurationPreview() {
    if (
      !$("log-started-at").value ||
      !$("log-ended-at").value
    ) {
      message(
        "log-duration-preview",
        "시작·종료 시각을 입력하면 실제 시간이 계산됩니다."
      );
      return;
    }

    try {
      const start = readKstTimestamp("log-started-at");
      const end = readKstTimestamp("log-ended-at");
      const minutes = durationMinutes(start, end);

      message(
        "log-duration-preview",
        `실제 ${nf.format(minutes)}분 · 실행 날짜 ${kstDate(start)}`,
        "success"
      );
    } catch (error) {
      message("log-duration-preview", error.message, "error");
    }
  }

  function signed(value) {
    return `${value > 0 ? "+" : ""}${nf.format(value)}`;
  }

  // ==================================================
  // 서버 요청
  // ==================================================

  async function request(path, method = "GET", payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const options = {
        method,
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
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
        throw new Error(
          "서버 응답을 읽지 못했습니다. API 배포 상태를 확인해 주세요."
        );
      }

      if (!response.ok) {
        const messages = {
          validation: "입력 내용과 연결된 기록을 확인해 주세요.",
          "not-found": "기록이 없습니다. 다시 불러와 주세요.",
          conflict: "기록이 변경됐거나 요청 내용이 충돌했습니다. 다시 불러와 주세요.",
          configuration: "서버 DB 환경변수 설정을 확인해 주세요.",
          limit: "기록 수가 많아 조회 범위 조정이 필요합니다.",
          storage: "DB 요청에 실패했습니다. 잠시 후 다시 확인해 주세요.",
        };

        throw new Error(
          messages[body?.error?.code] ??
          "서버 요청에 실패했습니다."
        );
      }

      return body;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "응답 시간이 초과됐습니다. 저장 여부를 다시 불러와 확인하세요."
        );
      }

      if (error instanceof TypeError) {
        throw new Error("서버에 연결하지 못했습니다.");
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function validateSnapshot(plans, tasks, logs) {
    if (![plans, tasks, logs].every(Array.isArray)) {
      throw new Error("서버 기록 목록 형식이 올바르지 않습니다.");
    }

    function validIds(rows) {
      return (
        rows.every((row) => row && UUID_PATTERN.test(row.id)) &&
        new Set(rows.map((row) => row.id)).size === rows.length
      );
    }

    if (![plans, tasks, logs].every(validIds)) {
      throw new Error("기록 ID가 올바르지 않습니다.");
    }

    const planIds = new Set(plans.map((plan) => plan.id));
    const taskIds = new Set(tasks.map((task) => task.id));

    const text = (value, max) =>
      typeof value === "string" && value.length <= max;

    const integer = (value, min, max) =>
      Number.isInteger(value) && value >= min && value <= max;

    const plansValid = plans.every(
      (plan) =>
        validDate(plan.start_date) &&
        validDate(plan.end_date) &&
        plan.end_date >= plan.start_date &&
        text(plan.title, 100) &&
        plan.title.trim() &&
        text(plan.goal, 2000) &&
        text(plan.success_criteria, 2000) &&
        text(plan.reflection, 4000) &&
        text(plan.next_action, 2000) &&
        Object.hasOwn(PRIORITY, plan.priority) &&
        integer(plan.estimated_minutes, 0, 525600) &&
        integer(plan.version, 1, 2147483647)
    );

    const tasksValid = tasks.every(
      (task) =>
        planIds.has(task.plan_id) &&
        text(task.title, 200) &&
        task.title.trim() &&
        validDate(task.due_date) &&
        integer(task.estimated_minutes, 1, 1440) &&
        integer(task.sort_order, 0, 2147483647) &&
        Object.hasOwn(STATUS, task.status) &&
        Object.hasOwn(PRIORITY, task.priority) &&
        Array.isArray(task.tags) &&
        task.tags.length <= 10 &&
        task.tags.every((tag) => typeof tag === "string")
    );

    const logsValid = logs.every((log) => {
      const legacy =
        log.started_at === null && log.ended_at === null;

      const start = Date.parse(log.started_at);
      const end = Date.parse(log.ended_at);
      const elapsed = end - start;

      const timesValid =
        legacy ||
        (
          typeof log.started_at === "string" &&
          typeof log.ended_at === "string" &&
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          elapsed > 0 &&
          elapsed <= 86400000 &&
          Math.ceil(elapsed / 60000) === log.actual_minutes &&
          kstDate(log.started_at) === log.performed_on
        );

      return (
        taskIds.has(log.task_id) &&
        validDate(log.performed_on) &&
        integer(log.actual_minutes, 1, 1440) &&
        text(log.note, 2000) &&
        text(log.blocked_reason, 2000) &&
        UUID_PATTERN.test(log.client_request_id) &&
        timesValid
      );
    });

    if (!plansValid || !tasksValid || !logsValid) {
      throw new Error(
        "기록 형식이나 연결이 올바르지 않습니다. DB와 API 버전을 확인하세요."
      );
    }
  }

  async function fetchSnapshot() {
    const results = await Promise.allSettled([
      request("/api/plans"),
      request("/api/tasks"),
      request("/api/logs"),
    ]);

    const failed = results.find(
      (result) => result.status === "rejected"
    );

    if (failed) throw failed.reason;

    const plans = results[0].value.plans;
    const tasks = results[1].value.tasks;
    const logs = results[2].value.logs;

    validateSnapshot(plans, tasks, logs);

    state.plans = plans;
    state.tasks = tasks;
    state.logs = logs;
    state.loaded = true;

    if (
      state.selectedPlanId &&
      !plans.some((plan) => plan.id === state.selectedPlanId)
    ) {
      state.selectedPlanId = plans[0]?.id ?? null;
    }
  }

  // ==================================================
  // 데이터 선택과 집계
  // ==================================================

  function selectedPlan() {
    return state.plans.find(
      (plan) => plan.id === state.selectedPlanId
    );
  }

  function selectedTasks() {
    return state.tasks.filter(
      (task) => task.plan_id === state.selectedPlanId
    );
  }

  function selectedLogs() {
    const ids = new Set(selectedTasks().map((task) => task.id));
    return state.logs.filter((log) => ids.has(log.task_id));
  }

  function actualMinutes(taskId) {
    return state.logs
      .filter((log) => log.task_id === taskId)
      .reduce((sum, log) => sum + log.actual_minutes, 0);
  }

  function isDelayed(task) {
    return (
      task.due_date < kstDate() &&
      task.status !== "done" &&
      task.status !== "cancelled"
    );
  }

  function inPeriod(date) {
    return (
      (!state.period.start || date >= state.period.start) &&
      (!state.period.end || date <= state.period.end)
    );
  }

  function summaryRecords() {
    const plans = state.plans.filter(
      (plan) =>
        (!state.period.start || plan.end_date >= state.period.start) &&
        (!state.period.end || plan.start_date <= state.period.end)
    );

    const tasks = state.tasks.filter((task) => inPeriod(task.due_date));
    const logs = state.logs.filter((log) => inPeriod(log.performed_on));
    const active = tasks.filter((task) => task.status !== "cancelled");
    const completed = tasks.filter((task) => task.status === "done");
    const delayed = tasks.filter(isDelayed);
    const blocked = logs.filter((log) => log.blocked_reason.trim());

    return {
      plans,
      tasks,
      logs,
      active,
      completed,
      delayed,
      blocked,
      estimated: active.reduce(
        (sum, task) => sum + task.estimated_minutes,
        0
      ),
      actual: logs.reduce(
        (sum, log) => sum + log.actual_minutes,
        0
      ),
      rate: active.length
        ? Math.round(completed.length / active.length * 100)
        : null,
    };
  }

  function visibleTasks() {
    const filter = state.filter;
    const normalize = (value) =>
      value.toLocaleLowerCase("ko-KR");

    const search = normalize(filter.search);
    const tag = normalize(filter.tag);

    const tasks = selectedTasks().filter(
      (task) =>
        (!search ||
          normalize([task.title, ...task.tags].join(" ")).includes(search)) &&
        (filter.status === "all" || task.status === filter.status) &&
        (filter.priority === "all" || task.priority === filter.priority) &&
        (!tag || task.tags.some((item) => normalize(item) === tag))
    );

    const ranks = { high: 0, medium: 1, low: 2 };

    function compare(a, b) {
      switch (filter.sort) {
        case "due_asc":
          return a.due_date.localeCompare(b.due_date);
        case "priority_desc":
          return ranks[a.priority] - ranks[b.priority];
        case "estimated_asc":
          return a.estimated_minutes - b.estimated_minutes;
        case "newest":
          return b.created_at.localeCompare(a.created_at);
        default:
          return a.sort_order - b.sort_order;
      }
    }

    return tasks.sort(
      (a, b) =>
        compare(a, b) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id)
    );
  }

  // ==================================================
  // 안전한 DOM 생성
  // ==================================================

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function action(label, handler, className) {
    const button = element("button", label, className);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function message(id, text, status = "idle") {
    $(id).textContent = text;
    $(id).dataset.state = status;
  }

  function focusNode(id) {
    const node = $(id);
    if (!node) return;
    node.setAttribute("tabindex", "-1");
    node.focus();
  }

  function updateControls() {
    const usable = state.loaded && !state.busy;
    const hasPlan = Boolean(selectedPlan());

    $("reload-button").disabled = state.busy;
    $("new-plan-button").disabled = !usable;
    $("export-button").disabled = !usable;

    $("plan-fields").disabled = !usable;
    $("summary-filter-fields").disabled = !usable;
    $("task-fields").disabled = !usable || !hasPlan;
    $("task-filter-fields").disabled = !usable || !hasPlan;
    $("log-fields").disabled =
      !usable || !hasPlan || !selectedTasks().length;
    $("review-fields").disabled = !usable || !hasPlan;

    $("load-plan-history-button").disabled = !usable || !hasPlan;
    $("create-next-plan-button").disabled =
      !usable || !selectedPlan()?.next_action?.trim();

    document.querySelectorAll(".summary-card").forEach(
      (button) => { button.disabled = !usable; }
    );

    document.querySelectorAll(
      ".plan-list button, .record-actions button, " +
      "#summary-evidence-list button, #comparison-body button"
    ).forEach((button) => {
      button.disabled = state.busy;
    });

    $("main").setAttribute("aria-busy", String(state.busy));
  }

  // ==================================================
  // 폼 초기화와 선택
  // ==================================================

  function resetTaskForm() {
    $("task-form").reset();
    $("task-id").value = "";
    $("task-due-date").value =
      selectedPlan()?.end_date ?? kstDate();
    $("save-task-button").textContent = "할 일 추가";
    $("cancel-task-button").hidden = true;
  }

  function resetLogForm() {
    $("log-form").reset();
    $("log-id").value = "";
    $("log-request-id").value = "";
    $("log-started-at").value = localKstInput();
    $("log-ended-at").value = "";
    $("save-log-button").textContent = "실행 기록 저장";
    $("cancel-log-button").hidden = true;
    state.pendingLog = null;
    updateDurationPreview();
  }

  function fillSelectedPlan() {
    const plan = selectedPlan();

    $("plan-form").reset();
    $("plan-id").value = plan?.id ?? "";
    $("previous-plan-id").value = plan?.previous_plan_id ?? "";
    $("plan-start-date").value = plan?.start_date ?? kstDate();
    $("plan-end-date").value = plan?.end_date ?? kstDate();
    $("plan-name").value = plan?.title ?? "";
    $("plan-goal").value = plan?.goal ?? "";
    $("plan-success-criteria").value = plan?.success_criteria ?? "";
    $("plan-priority").value = plan?.priority ?? "medium";
    $("plan-estimated-minutes").value = plan?.estimated_minutes ?? "";

    $("plan-editor-mode").textContent = plan ? "계획 수정" : "새 계획";
    $("save-plan-button").textContent = plan ? "계획 수정 저장" : "계획 저장";
    $("cancel-plan-button").hidden = !plan;
    $("delete-plan-button").hidden = !plan;

    $("plan-record-info").textContent = plan
      ? `ID: ${plan.id} · 버전 ${plan.version}`
      : "계획 저장 전 · ID와 버전 없음";

    const previous = state.plans.find(
      (item) => item.id === plan?.previous_plan_id
    );

    $("previous-plan-info").hidden = !plan?.previous_plan_id;
    $("previous-plan-info").textContent = previous
      ? `이전 계획 「${previous.title}」에서 이어졌습니다.`
      : "이전 계획에서 이어진 기록입니다.";

    $("review-reflection").value = plan?.reflection ?? "";
    $("review-next-action").value = plan?.next_action ?? "";

    $("plan-history-list").replaceChildren();
    message("plan-history-message", "");

    resetTaskForm();
    resetLogForm();

    [
      "plan-message",
      "task-message",
      "log-message",
      "review-message",
    ].forEach((id) => message(id, ""));

    updateControls();
  }

  function clearTaskFilters() {
    $("task-filter-form").reset();
    state.filter = {
      search: "",
      status: "all",
      priority: "all",
      tag: "",
      sort: "manual",
    };
  }

  function selectPlan(id, targetId = null) {
    if (state.busy) return;

    state.selectedPlanId = id;
    clearTaskFilters();
    renderAll();
    fillSelectedPlan();

    if (targetId) focusNode(targetId);
  }

  function newPlan(previous = null) {
    if (state.busy || !state.loaded) return;

    state.selectedPlanId = null;
    clearTaskFilters();
    renderAll();
    fillSelectedPlan();

    if (previous) {
      $("previous-plan-id").value = previous.id;
      $("plan-goal").value = previous.next_action;
      $("previous-plan-info").hidden = false;
      $("previous-plan-info").textContent =
        `「${previous.title}」의 개선점을 가져왔습니다.`;
    }

    $("plan-name").focus();
  }

  // ==================================================
  // 화면 렌더링
  // ==================================================

  function renderPlans() {
    const list = $("plan-list");
    list.replaceChildren();

    $("plan-list-count").textContent = `${state.plans.length}개`;
    $("plan-list-empty").hidden = state.plans.length > 0;
    $("plan-list-empty").textContent = "아직 계획이 없습니다.";

    for (const plan of state.plans) {
      const li = element("li");
      const button = action("", () => selectPlan(plan.id));

      button.append(
        element("strong", plan.title),
        element("small", `${plan.start_date} ~ ${plan.end_date}`),
        element("small", `우선순위 ${PRIORITY[plan.priority]} · v${plan.version}`)
      );

      if (plan.id === state.selectedPlanId) {
        button.setAttribute("aria-current", "true");
      }

      li.append(button);
      list.append(li);
    }
  }

  function editTask(task) {
    if (state.busy) return;

    $("task-id").value = task.id;
    $("task-name").value = task.title;
    $("task-due-date").value = task.due_date;
    $("task-priority").value = task.priority;
    $("task-tags").value = task.tags.join(", ");
    $("task-estimated-minutes").value = task.estimated_minutes;
    $("task-status").value = task.status;
    $("save-task-button").textContent = "할 일 수정 저장";
    $("cancel-task-button").hidden = false;
    $("task-name").focus();
  }

  function renderTasks() {
    const tasks = visibleTasks();
    const list = $("task-list");
    list.replaceChildren();

    $("task-help").textContent = selectedPlan()
      ? "마감일과 예상 시간을 정하고 할 일을 추가하세요."
      : "먼저 계획을 저장하거나 선택하세요.";

    $("task-list-count").textContent =
      `전체 ${selectedTasks().length}개 중 ${tasks.length}개 표시`;

    $("task-list-empty").hidden = tasks.length > 0;

    $("task-sort-description").textContent =
      `정렬: ${SORT_LABEL[state.filter.sort]}. ` +
      "같은 값이면 등록 시각, ID 순입니다.";

    for (const task of tasks) {
      const li = element("li");
      li.id = `task-record-${task.id}`;

      const badge = element("span", STATUS[task.status], "task-status");
      badge.dataset.status = task.status;

      const actions = element("div", undefined, "record-actions");

      actions.append(
        action("수정", () => editTask(task)),
        action(
          task.status === "done" ? "완료 되돌리기" : "완료",
          () => mutate(
            `/api/tasks?id=${encodeURIComponent(task.id)}`,
            "PATCH",
            { status: task.status === "done" ? "todo" : "done" },
            "task-message"
          )
        ),
        action("실행 기록 작성", () => {
          if (state.busy) return;
          resetLogForm();
          $("log-task-id").value = task.id;
          $("log-started-at").focus();
        }),
        action("삭제", () => {
          if (state.busy) return;
          if (!confirm(
            `「${task.title}」을 삭제할까요?\n연결된 실행 기록도 삭제됩니다.`
          )) return;

          mutate(
            `/api/tasks?id=${encodeURIComponent(task.id)}`,
            "DELETE",
            undefined,
            "task-message"
          );
        }, "danger-button")
      );

      li.append(
        element("h4", task.title),
        badge,
        element(
          "p",
          `마감 ${task.due_date} · 우선순위 ${PRIORITY[task.priority]}` +
          (isDelayed(task) ? " · 지연" : "")
        ),
        element(
          "p",
          `예상 ${nf.format(task.estimated_minutes)}분 · ` +
          `실제 ${nf.format(actualMinutes(task.id))}분`
        ),
        element("p", `태그: ${task.tags.join(", ") || "없음"}`),
        element(
          "p",
          task.completed_at
            ? `완료 시각: ${formatTime(task.completed_at)} · KST`
            : task.status === "done"
              ? "기존 완료 기록 · 완료 시각 미기록"
              : "완료 전"
        ),
        actions
      );

      list.append(li);
    }

    const select = $("log-task-id");
    const previousValue = select.value;
    select.replaceChildren();

    const placeholder = element("option", "실행한 할 일을 선택하세요.");
    placeholder.value = "";
    select.append(placeholder);

    for (const task of selectedTasks()) {
      const option = element("option", task.title);
      option.value = task.id;
      select.append(option);
    }

    if (selectedTasks().some((task) => task.id === previousValue)) {
      select.value = previousValue;
    }
  }

  function editLog(log) {
    if (state.busy) return;

    state.pendingLog = null;
    $("log-id").value = log.id;
    $("log-request-id").value = log.client_request_id;
    $("log-task-id").value = log.task_id;

    $("log-started-at").value = log.started_at
      ? localKstInput(log.started_at)
      : "";

    $("log-ended-at").value = log.ended_at
      ? localKstInput(log.ended_at)
      : "";

    $("log-note").value = log.note;
    $("log-blocked-reason").value = log.blocked_reason;
    $("save-log-button").textContent = "실행 기록 수정 저장";
    $("cancel-log-button").hidden = false;

    updateDurationPreview();

    if (!log.started_at) {
      message(
        "log-message",
        "기존 기록에는 실행 시각이 없습니다. 실제로 확인 가능한 시각만 입력하세요."
      );
    }

    $("log-started-at").focus();
  }

  function renderLogs() {
    const logs = selectedLogs().slice().sort(
      (a, b) =>
        b.performed_on.localeCompare(a.performed_on) ||
        b.created_at.localeCompare(a.created_at)
    );

    const list = $("log-list");
    list.replaceChildren();
    $("log-list-empty").hidden = logs.length > 0;

    for (const log of logs) {
      const task = state.tasks.find((item) => item.id === log.task_id);
      const li = element("li");
      li.id = `log-record-${log.id}`;

      const note = element("p", log.note || "실행 메모 없음");
      note.style.whiteSpace = "pre-wrap";

      const blocked = element(
        "p",
        log.blocked_reason
          ? `막힌 이유: ${log.blocked_reason}`
          : "막힌 이유 없음"
      );
      blocked.style.whiteSpace = "pre-wrap";

      const actions = element("div", undefined, "record-actions");

      actions.append(
        action("수정", () => editLog(log)),
        action("삭제", () => {
          if (state.busy) return;
          if (!confirm("이 실행 기록을 삭제할까요?")) return;

          mutate(
            `/api/logs?id=${encodeURIComponent(log.id)}`,
            "DELETE",
            undefined,
            "log-message"
          );
        }, "danger-button")
      );

      li.append(
        element("h4", task.title),
        element(
          "p",
          `${log.performed_on} · 실제 ${nf.format(log.actual_minutes)}분`
        ),
        element(
          "p",
          log.started_at
            ? `${formatTime(log.started_at)} ~ ${formatTime(log.ended_at)} · KST`
            : "기존 기록 · 시작·종료 시각 미기록"
        ),
        note,
        blocked,
        actions
      );

      list.append(li);
    }
  }

  function renderSummary() {
    const data = summaryRecords();

    const values = {
      "summary-plan-count": data.plans.length,
      "summary-task-count": data.tasks.length,
      "summary-completed-count": data.completed.length,
      "summary-delayed-count": data.delayed.length,
      "summary-blocked-count": data.blocked.length,
      "summary-estimated-minutes": data.estimated,
      "summary-actual-minutes": data.actual,
    };

    Object.entries(values).forEach(([id, value]) => {
      $(id).textContent = nf.format(value);
    });

    $("summary-completion-rate").textContent =
      data.rate === null ? "—" : data.rate;

    $("summary-period-label").textContent =
      state.period.start
        ? `집계 기간: ${state.period.start} ~ ${state.period.end} · KST`
        : "집계 기간: 전체";
  }

  function renderComparison() {
    const plan = selectedPlan();
    const tasks = selectedTasks();
    const logs = selectedLogs();

    const active = tasks.filter((task) => task.status !== "cancelled");
    const estimated = active.reduce(
      (sum, task) => sum + task.estimated_minutes,
      0
    );
    const actual = logs.reduce(
      (sum, log) => sum + log.actual_minutes,
      0
    );
    const completed = active.filter((task) => task.status === "done").length;
    const rate = active.length
      ? Math.round(completed / active.length * 100)
      : null;

    $("selected-plan-label").textContent = plan
      ? `${plan.title} · ${plan.start_date} ~ ${plan.end_date}`
      : "먼저 계획을 선택하세요.";

    $("selected-success-criteria").textContent =
      `성공 기준: ${plan?.success_criteria || "미입력"}`;

    $("selected-plan-estimated-minutes").textContent =
      plan ? nf.format(plan.estimated_minutes) : "—";

    $("selected-estimated-minutes").textContent =
      plan ? nf.format(estimated) : "—";

    $("selected-actual-minutes").textContent =
      plan ? nf.format(actual) : "—";

    $("selected-plan-time-difference").textContent =
      plan ? signed(actual - plan.estimated_minutes) : "—";

    $("selected-time-difference").textContent =
      plan ? signed(actual - estimated) : "—";

    $("selected-completion-rate").textContent =
      plan && rate !== null ? rate : "—";

    $("reviewed-at").textContent = plan?.reviewed_at
      ? `돌아보기 저장: ${formatTime(plan.reviewed_at)} · KST`
      : "돌아보기 저장 전";

    const body = $("comparison-body");
    body.replaceChildren();

    if (!tasks.length) {
      const row = element("tr");
      const cell = element("td", "아직 비교할 할 일이 없습니다.");
      cell.colSpan = 6;
      row.append(cell);
      body.append(row);
      return;
    }

    for (const task of tasks) {
      const actualTime = actualMinutes(task.id);
      const row = element("tr");
      const title = element("td");

      title.append(action(task.title, () => {
        clearTaskFilters();
        renderTasks();
        updateControls();
        focusNode(`task-record-${task.id}`);
      }));

      row.append(
        title,
        element("td", STATUS[task.status]),
        element("td", task.due_date),
        element("td", nf.format(task.estimated_minutes)),
        element("td", nf.format(actualTime)),
        element("td", signed(actualTime - task.estimated_minutes))
      );

      body.append(row);
    }
  }

  function renderEvidence() {
    const panel = $("summary-evidence");
    panel.hidden = !state.evidenceType;

    if (!state.evidenceType) return;

    const data = summaryRecords();
    const type = state.evidenceType;

    const titles = {
      plans: "계획 수의 근거",
      tasks: "할 일 수의 근거",
      completed: "완료 수의 근거",
      delayed: "지연 수의 근거",
      blocked: "막힘 수의 근거",
      rate: "완료율의 근거",
      estimated: "예상 시간의 근거",
      actual: "실제 시간의 근거",
    };

    $("summary-evidence-title").textContent = titles[type];

    $("summary-evidence-description").textContent =
      type === "rate"
        ? `완료 ${data.completed.length}개 ÷ 취소하지 않은 할 일 ` +
          `${data.active.length}개 × 100. ` +
          (data.rate === null ? "분모가 0이어서 표시하지 않습니다." : "정수로 반올림합니다.")
        : "아래 항목을 누르면 해당 계획이나 기록으로 이동합니다.";

    const list = $("summary-evidence-list");
    list.replaceChildren();

    function add(label, planId, targetId = "plan-title") {
      const li = element("li");

      li.append(
        action(label, () => selectPlan(planId, targetId))
      );

      list.append(li);
    }

    if (type === "plans") {
      data.plans.forEach((plan) => {
        add(
          `${plan.title} · ${plan.start_date} ~ ${plan.end_date}`,
          plan.id
        );
      });
    } else if (type === "actual" || type === "blocked") {
      const logs = type === "actual" ? data.logs : data.blocked;

      logs.forEach((log) => {
        const task = state.tasks.find((item) => item.id === log.task_id);

        add(
          `${log.performed_on} · ${task.title} · ${log.actual_minutes}분` +
          (type === "blocked" ? ` · ${log.blocked_reason}` : ""),
          task.plan_id,
          `log-record-${log.id}`
        );
      });
    } else {
      const groups = {
        tasks: data.tasks,
        completed: data.completed,
        delayed: data.delayed,
        rate: data.active,
        estimated: data.active,
      };

      groups[type].forEach((task) => {
        add(
          `${task.title} · 마감 ${task.due_date} · ${STATUS[task.status]}` +
          (type === "estimated" ? ` · ${task.estimated_minutes}분` : ""),
          task.plan_id,
          `task-record-${task.id}`
        );
      });
    }

    if (!list.childElementCount) {
      list.append(element("li", "해당 기록이 없습니다."));
    }
  }

  function renderAll() {
    renderPlans();
    renderTasks();
    renderLogs();
    renderSummary();
    renderComparison();
    renderEvidence();
    updateControls();
  }

  // ==================================================
  // 데이터 불러오기와 변경
  // ==================================================

  async function loadRecords() {
    if (state.busy) return;

    state.busy = true;
    updateControls();

    message("connection-status", "서버 기록을 불러오는 중입니다.", "loading");

    try {
      const firstLoad = !state.loaded;
      await fetchSnapshot();

      if (firstLoad && !state.selectedPlanId) {
        state.selectedPlanId = state.plans[0]?.id ?? null;
      }

      renderAll();
      fillSelectedPlan();

      message(
        "connection-status",
        "서버 기록을 불러왔습니다. 변경 내용은 저장 버튼을 눌러 반영하세요.",
        "success"
      );
    } catch (error) {
      message(
        "connection-status",
        error.message +
          (state.loaded ? " 마지막으로 읽은 화면을 유지합니다." : ""),
        "error"
      );
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  async function mutate(path, method, payload, messageId, onSaved) {
    if (state.busy || !state.loaded) return;

    state.busy = true;
    updateControls();
    message(messageId, "서버에 반영하는 중입니다.", "loading");

    let saved = false;

    try {
      const body = await request(path, method, payload);

      if (method === "DELETE") {
        if (body?.deleted !== true) {
          throw new Error("삭제 결과를 확인하지 못했습니다.");
        }
      } else {
        const key = path.split("?")[0].split("/").at(-1).slice(0, -1);

        if (!UUID_PATTERN.test(body?.[key]?.id ?? "")) {
          throw new Error("저장 결과를 확인하지 못했습니다.");
        }
      }

      saved = true;
      if (onSaved) onSaved(body);

      await fetchSnapshot();
      renderAll();
      fillSelectedPlan();

      message(messageId, "서버에 반영하고 기록을 다시 확인했습니다.", "success");
      message("connection-status", "서버 기록과 화면을 동기화했습니다.", "success");
    } catch (error) {
      const text = saved
        ? "서버 반영은 완료됐지만 목록을 다시 읽지 못했습니다. 다시 불러와 확인하세요."
        : `${error.message} 저장 여부가 불확실하면 다시 불러와 확인하세요.`;

      message(messageId, text, "error");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  // ==================================================
  // 계획 이력
  // ==================================================

  async function loadHistory() {
    const plan = selectedPlan();
    if (state.busy || !plan) return;

    state.busy = true;
    updateControls();
    message("plan-history-message", "이력을 불러오는 중입니다.", "loading");

    try {
      const body = await request(
        `/api/plans?id=${encodeURIComponent(plan.id)}&history=true`
      );

      if (!Array.isArray(body.versions)) {
        throw new Error("이력 응답 형식이 올바르지 않습니다.");
      }

      const container = $("plan-history-list");
      container.replaceChildren();

      for (const version of body.versions) {
        const details = element("details");
        const label = version.is_migration_baseline
          ? "확장 시점 기준본 · 최초 작성본 여부는 확인할 수 없음"
          : version.version === 1
            ? "최초 저장 계획"
            : "수정된 계획";

        const summary = element(
          "summary",
          `버전 ${version.version} · ${label} · ${formatTime(version.recorded_at)}`
        );

        const pre = element(
          "pre",
          JSON.stringify(version.snapshot, null, 2)
        );

        pre.style.whiteSpace = "pre-wrap";
        pre.style.overflowWrap = "anywhere";

        details.append(summary, pre);
        container.append(details);
      }

      message(
        "plan-history-message",
        `${body.versions.length}개 버전을 불러왔습니다.`,
        "success"
      );
    } catch (error) {
      message("plan-history-message", error.message, "error");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  // ==================================================
  // 전체 자료 내보내기
  // ==================================================

  async function exportData() {
    if (state.busy || !state.loaded) return;

    state.busy = true;
    updateControls();
    message("export-message", "서버 자료와 계획 이력을 모으는 중입니다.", "loading");

    try {
      await fetchSnapshot();

      const versions = [];

      // 이력은 계획별로 조회합니다.
      // 하나라도 실패하면 불완전한 파일을 내려받지 않습니다.
      for (const plan of state.plans) {
        const body = await request(
          `/api/plans?id=${encodeURIComponent(plan.id)}&history=true`
        );

        if (!Array.isArray(body.versions)) {
          throw new Error("계획 이력을 내보내지 못했습니다.");
        }

        if (body.plan?.version !== plan.version) {
          throw new Error(
            "내보내기 중 계획이 변경되었습니다. 다시 시도해 주세요."
          );
        }

        versions.push(...body.versions);
      }

      const data = {
        format: "pds-diary-export",
        schema_version: 2,
        exported_at: new Date().toISOString(),
        time_zone: "Asia/Seoul",
        collection_note:
          "각 테이블을 순차적으로 조회한 자료입니다. 동시 수정 시 완전히 동일한 한 시점의 스냅샷은 보장하지 않습니다.",
        plans: state.plans,
        tasks: state.tasks,
        logs: state.logs,
        plan_versions: versions,
      };

      const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: "application/json;charset=utf-8" }
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pds-diary-${kstDate()}.json`;

      document.body.append(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 10000);

      renderAll();
      fillSelectedPlan();

      message(
        "export-message",
        "전체 계획·할 일·실행 기록·계획 이력을 JSON 파일 하나로 내보냈습니다.",
        "success"
      );
    } catch (error) {
      message("export-message", error.message, "error");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  // ==================================================
  // 폼 이벤트
  // ==================================================

  $("plan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy || !state.loaded) return;

    try {
      const id = $("plan-id").value;
      const start = readDate("plan-start-date");
      const end = readDate("plan-end-date");

      if (end < start) {
        throw new Error("종료일은 시작일과 같거나 이후여야 합니다.");
      }

      const payload = {
        start_date: start,
        end_date: end,
        title: readText("plan-name", 100, true),
        goal: readText("plan-goal", 2000),
        success_criteria: readText("plan-success-criteria", 2000, true),
        priority: readChoice("plan-priority", PRIORITY),
        estimated_minutes: readInteger("plan-estimated-minutes", 525600),
        previous_plan_id: $("previous-plan-id").value || null,
      };

      mutate(
        id ? `/api/plans?id=${encodeURIComponent(id)}` : "/api/plans",
        id ? "PATCH" : "POST",
        payload,
        "plan-message",
        (body) => { state.selectedPlanId = body.plan.id; }
      );
    } catch (error) {
      message("plan-message", error.message, "error");
    }
  });

  $("task-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy || !selectedPlan()) return;

    try {
      const id = $("task-id").value;

      const payload = {
        plan_id: state.selectedPlanId,
        title: readText("task-name", 200, true),
        due_date: readDate("task-due-date"),
        priority: readChoice("task-priority", PRIORITY),
        tags: readTags(),
        estimated_minutes: readInteger("task-estimated-minutes", 1440),
        status: readChoice("task-status", STATUS),
      };

      if (!id) {
        const orders = selectedTasks().map((task) => task.sort_order);
        payload.sort_order = Math.max(-1, ...orders) + 1;
      }

      mutate(
        id ? `/api/tasks?id=${encodeURIComponent(id)}` : "/api/tasks",
        id ? "PATCH" : "POST",
        payload,
        "task-message"
      );
    } catch (error) {
      message("task-message", error.message, "error");
    }
  });

  $("log-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy || !selectedPlan()) return;

    try {
      const id = $("log-id").value;
      const taskId = $("log-task-id").value;

      if (!selectedTasks().some((task) => task.id === taskId)) {
        throw new Error("실행한 할 일을 선택해 주세요.");
      }

      const start = readKstTimestamp("log-started-at");
      const end = readKstTimestamp("log-ended-at");

      durationMinutes(start, end);

      const payload = {
        task_id: taskId,
        started_at: start,
        ended_at: end,
        note: readText("log-note", 2000),
        blocked_reason: readText("log-blocked-reason", 2000),
      };

      if (!id) {
        const fingerprint = JSON.stringify(payload);

        // 응답을 못 받은 동일한 내용의 재시도는 같은 키를 사용합니다.
        // 내용을 바꾸려면 먼저 저장 여부를 확인하도록 합니다.
        if (
          state.pendingLog &&
          state.pendingLog.fingerprint !== fingerprint
        ) {
          throw new Error(
            "이전 저장 결과가 불확실합니다. 기록을 다시 불러와 저장 여부를 확인한 뒤 작성해 주세요."
          );
        }

        if (!state.pendingLog) {
          state.pendingLog = {
            fingerprint,
            key: crypto.randomUUID(),
          };
        }

        payload.client_request_id = state.pendingLog.key;
        $("log-request-id").value = state.pendingLog.key;
      }

      mutate(
        id ? `/api/logs?id=${encodeURIComponent(id)}` : "/api/logs",
        id ? "PATCH" : "POST",
        payload,
        "log-message",
        () => {
          state.pendingLog = null;
          $("log-request-id").value = "";
          resetLogForm();
        }
      );
    } catch (error) {
      message("log-message", error.message, "error");
    }
  });

  $("review-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const plan = selectedPlan();
    if (state.busy || !plan) return;

    try {
      const reflection = readText("review-reflection", 4000, true);
      const nextAction = readText("review-next-action", 2000, true);

      if (/[\r\n]/.test(nextAction)) {
        throw new Error("다음 개선점은 한 줄로 입력해 주세요.");
      }

      mutate(
        `/api/plans?id=${encodeURIComponent(plan.id)}`,
        "PATCH",
        {
          reflection,
          next_action: nextAction,
        },
        "review-message"
      );
    } catch (error) {
      message("review-message", error.message, "error");
    }
  });

  $("summary-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) return;

    try {
      const start = readDate("summary-start-date");
      const end = readDate("summary-end-date");

      if (end < start) {
        throw new Error("집계 종료일은 시작일 이후여야 합니다.");
      }

      state.period = { start, end };
      renderSummary();
      renderEvidence();
      updateControls();
      message("summary-message", "집계 기간을 적용했습니다.", "success");
    } catch (error) {
      message("summary-message", error.message, "error");
    }
  });

  $("task-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) return;

    try {
      const status = $("task-filter-status").value;
      const priority = $("task-filter-priority").value;
      const sort = $("task-sort").value;

      if (
        (status !== "all" && !Object.hasOwn(STATUS, status)) ||
        (priority !== "all" && !Object.hasOwn(PRIORITY, priority)) ||
        !Object.hasOwn(SORT_LABEL, sort)
      ) {
        throw new Error("검색 조건을 확인해 주세요.");
      }

      state.filter = {
        search: readText("task-search", 200),
        status,
        priority,
        tag: readText("task-filter-tag", 30),
        sort,
      };

      renderTasks();
      updateControls();
      message("task-filter-message", "조건을 적용했습니다.", "success");
    } catch (error) {
      message("task-filter-message", error.message, "error");
    }
  });

  // ==================================================
  // 버튼 이벤트
  // ==================================================

  $("reload-button").addEventListener("click", loadRecords);
  $("new-plan-button").addEventListener("click", () => newPlan());
  $("export-button").addEventListener("click", exportData);
  $("load-plan-history-button").addEventListener("click", loadHistory);

  $("cancel-plan-button").addEventListener("click", fillSelectedPlan);
  $("cancel-task-button").addEventListener("click", resetTaskForm);
  $("cancel-log-button").addEventListener("click", resetLogForm);

  $("log-started-at").addEventListener("input", updateDurationPreview);
  $("log-ended-at").addEventListener("input", updateDurationPreview);

  $("summary-all-button").addEventListener("click", () => {
    if (state.busy) return;
    state.period = { start: "", end: "" };
    $("summary-filter-form").reset();
    renderSummary();
    renderEvidence();
    updateControls();
    message("summary-message", "전체 기간으로 변경했습니다.");
  });

  $("reset-task-filter-button").addEventListener("click", () => {
    if (state.busy) return;
    clearTaskFilters();
    renderTasks();
    updateControls();
    message("task-filter-message", "검색 조건을 초기화했습니다.");
  });

  $("delete-plan-button").addEventListener("click", () => {
    const plan = selectedPlan();
    if (state.busy || !plan) return;

    if (!confirm(
      `「${plan.title}」을 삭제할까요?\n` +
      "할 일·실행 기록·계획 이력도 삭제됩니다."
    )) return;

    mutate(
      `/api/plans?id=${encodeURIComponent(plan.id)}`,
      "DELETE",
      undefined,
      "plan-message"
    );
  });

  $("create-next-plan-button").addEventListener("click", () => {
    const plan = selectedPlan();
    if (state.busy || !plan?.next_action?.trim()) return;
    newPlan(plan);
  });

  const evidenceButtons = {
    "summary-plans-button": "plans",
    "summary-tasks-button": "tasks",
    "summary-completed-button": "completed",
    "summary-delayed-button": "delayed",
    "summary-blocked-button": "blocked",
    "summary-rate-button": "rate",
    "summary-estimated-button": "estimated",
    "summary-actual-button": "actual",
  };

  Object.entries(evidenceButtons).forEach(([id, type]) => {
    $(id).addEventListener("click", () => {
      if (state.busy) return;
      state.evidenceType = type;
      state.evidenceTrigger = id;
      renderEvidence();
      updateControls();
      focusNode("summary-evidence-title");
    });
  });

  $("close-summary-button").addEventListener("click", () => {
    state.evidenceType = null;
    renderEvidence();

    if (state.evidenceTrigger) {
      $(state.evidenceTrigger).focus();
    }
  });

  // 최초 실행
  fillSelectedPlan();
  loadRecords();
})();