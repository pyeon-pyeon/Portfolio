"use strict";

(() => {
  const PRIORITIES = {
    high: "높음",
    medium: "보통",
    low: "낮음",
  };

  const STATUSES = {
    todo: "할 예정",
    doing: "진행 중",
    done: "완료",
    cancelled: "취소",
  };

  const PRIORITY_ORDER = {
    high: 0,
    medium: 1,
    low: 2,
  };

  let context = null;
  let initialized = false;
  let historyRequest = 0;

  function element(id) {
    return document.getElementById(id);
  }

  function value(id) {
    return element(id)?.value ?? "";
  }

  function setValue(id, nextValue) {
    const node = element(id);

    if (node) {
      node.value = nextValue ?? "";
    }
  }

  function text(id, message) {
    const node = element(id);

    if (node) {
      node.textContent = message;
    }
  }

  function hidden(id, shouldHide) {
    const node = element(id);

    if (node) {
      node.hidden = shouldHide;
    }
  }

  function listen(id, event, handler) {
    const node = element(id);

    if (!node) {
      console.warn(`계획 화면 요소를 찾지 못했습니다: ${id}`);
      return;
    }

    node.addEventListener(event, handler);
  }

  function message(id, content, isError = false) {
    const node = element(id);

    if (!node) return;

    node.textContent = content;
    node.classList.toggle("is-error", isError);
    node.setAttribute("role", isError ? "alert" : "status");
  }

  function selectedPlan() {
    return context.state.plans.find(
      (plan) => plan.id === context.state.selectedPlanId
    ) ?? null;
  }

  function selectedTasks() {
    const planId = context.state.selectedPlanId;

    return context.state.tasks.filter(
      (task) => task.plan_id === planId
    );
  }

  function requiredText(raw, label, maxLength) {
    const result = String(raw).trim();

    if (!result) {
      throw new Error(`${label}을 입력해 주세요.`);
    }

    if (result.length > maxLength) {
      throw new Error(`${label}은 ${maxLength}자 이하로 입력해 주세요.`);
    }

    return result;
  }

  function optionalText(raw, label, maxLength) {
    const result = String(raw).trim();

    if (result.length > maxLength) {
      throw new Error(`${label}은 ${maxLength}자 이하로 입력해 주세요.`);
    }

    return result;
  }

  function integer(raw, label, min, max) {
    if (!/^\d+$/.test(String(raw))) {
      throw new Error(`${label}은 정수로 입력해 주세요.`);
    }

    const result = Number(raw);

    if (!Number.isSafeInteger(result) || result < min || result > max) {
      throw new Error(`${label}은 ${min}~${max} 사이로 입력해 주세요.`);
    }

    return result;
  }

  function date(raw, label) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(`${label}을 입력해 주세요.`);
    }

    const parsed = new Date(`${raw}T00:00:00Z`);

    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== raw
    ) {
      throw new Error(`${label}이 올바르지 않습니다.`);
    }

    return raw;
  }

  function choice(raw, choices, label) {
    if (!Object.prototype.hasOwnProperty.call(choices, raw)) {
      throw new Error(`${label}을 확인해 주세요.`);
    }

    return raw;
  }

  function tags(raw) {
    const result = [
      ...new Set(
        String(raw)
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      ),
    ];

    if (result.length > 10) {
      throw new Error("태그는 최대 10개까지 입력할 수 있습니다.");
    }

    if (result.some((tag) => tag.length > 30)) {
      throw new Error("각 태그는 30자 이하로 입력해 주세요.");
    }

    return result;
  }

  function button(label, handler, className = "") {
    const node = document.createElement("button");

    node.type = "button";
    node.textContent = label;
    node.className = className;
    node.disabled = context.state.busy || !context.state.loaded;
    node.addEventListener("click", handler);

    return node;
  }

  function paragraph(content, className = "") {
    const node = document.createElement("p");

    node.textContent = content;
    node.className = className;

    return node;
  }

  function resetTaskForm() {
    element("task-form")?.reset();

    setValue("task-id", "");
    setValue("task-status", "todo");
    setValue("task-priority", "medium");
    setValue("task-estimated", 30);
    setValue("task-due", selectedPlan()?.end_date ?? "");

    hidden("task-cancel-button", true);
    text("task-save-button", "할 일 저장");
    message("task-message", "");
  }

  function fillPlanForm() {
    const plan = selectedPlan();

    element("plan-form")?.reset();

    setValue("plan-id", plan?.id ?? "");
    setValue("previous-plan-id", plan?.previous_plan_id ?? "");
    setValue("plan-start", plan?.start_date ?? context.today());
    setValue("plan-end", plan?.end_date ?? context.today());
    setValue("plan-name", plan?.title ?? "");
    setValue("plan-goal", plan?.goal ?? "");
    setValue("plan-success", plan?.success_criteria ?? "");
    setValue("plan-priority", plan?.priority ?? "medium");
    setValue("plan-estimated", plan?.estimated_minutes ?? "");

    text("plan-mode", plan ? "선택한 계획 수정" : "새 계획 작성");
    text("plan-save-button", plan ? "계획 수정 저장" : "계획 저장");

    text(
      "plan-record-info",
      plan
        ? `계획 ID: ${plan.id} · 현재 버전: ${plan.version}`
        : "기간·성공 기준·예상 시간을 정해 주세요."
    );

    hidden("plan-delete-button", !plan);
    hidden("plan-cancel-button", !plan);

    const previous = context.state.plans.find(
      (item) => item.id === plan?.previous_plan_id
    );

    text(
      "previous-plan-info",
      previous ? `이전 계획: ${previous.title}` : ""
    );

    hidden("previous-plan-info", !previous);

    message("plan-message", "");
    clearHistory();
    resetTaskForm();
  }

  function clearHistory() {
    historyRequest += 1;
    element("plan-history-list")?.replaceChildren();
    message("plan-history-message", "");

    const loadButton = element("load-history-button");

    if (loadButton) {
      loadButton.disabled =
        !selectedPlan() ||
        context.state.busy ||
        !context.state.loaded;
    }
  }

  function selectPlan(planId, focusTarget = null) {
    const plan = context.state.plans.find(
      (item) => item.id === planId
    );

    if (!plan) return;

    context.state.selectedPlanId = plan.id;

    fillPlanForm();
    context.render();

    if (focusTarget) {
      window.PdsView?.focusNode(focusTarget);
    } else {
      window.PdsView?.show("plan");
    }
  }

  function newPlan(previousPlan = null) {
    if (context.state.busy || !context.state.loaded) return;

    context.state.selectedPlanId = null;

    fillPlanForm();
    context.render();

    if (previousPlan) {
      const improvement = String(previousPlan.next_action ?? "").trim();

      if (!improvement) {
        message(
          "plan-message",
          "이전 계획의 다음 개선점을 먼저 저장해 주세요.",
          true
        );
        return;
      }

      setValue("previous-plan-id", previousPlan.id);
      setValue("plan-goal", improvement);

      text(
        "previous-plan-info",
        `이전 계획: ${previousPlan.title} · 개선점을 목표로 가져왔습니다.`
      );

      hidden("previous-plan-info", false);
    }

    window.PdsView?.focusNode("plan-name");
  }

  function renderPlans() {
    const list = element("plan-list");

    if (!list) return;

    list.replaceChildren();
    text("plan-count", `${context.state.plans.length}개`);
    hidden("plan-empty", context.state.plans.length > 0);

    const plans = [...context.state.plans].sort(
      (a, b) =>
        b.start_date.localeCompare(a.start_date) ||
        b.created_at.localeCompare(a.created_at) ||
        a.id.localeCompare(b.id)
    );

    plans.forEach((plan) => {
      const item = document.createElement("li");
      const selectButton = button(
        "",
        () => selectPlan(plan.id),
        "plan-select"
      );

      const title = document.createElement("strong");
      title.textContent = plan.title;

      const meta = document.createElement("span");
      meta.textContent =
        `${plan.start_date} ~ ${plan.end_date} · ` +
        `${PRIORITIES[plan.priority] ?? "보통"}`;

      selectButton.append(title, meta);

      const selected = plan.id === context.state.selectedPlanId;

      selectButton.classList.toggle("is-selected", selected);
      selectButton.setAttribute("aria-pressed", String(selected));

      item.append(selectButton);
      list.append(item);
    });
  }

  function filteredTasks() {
    const search = value("task-search").trim().toLowerCase();
    const status = value("task-filter-status") || "all";
    const priority = value("task-filter-priority") || "all";
    const tag = value("task-filter-tag").trim().toLowerCase();
    const sort = value("task-sort") || "manual";

    const result = selectedTasks().filter((task) => {
      const taskTags = Array.isArray(task.tags) ? task.tags : [];

      const searchable =
        `${task.title} ${taskTags.join(" ")}`.toLowerCase();

      return (
        (!search || searchable.includes(search)) &&
        (status === "all" || task.status === status) &&
        (priority === "all" || task.priority === priority) &&
        (!tag || taskTags.some(
          (item) => item.toLowerCase() === tag
        ))
      );
    });

    const comparisons = {
      manual: (a, b) => a.sort_order - b.sort_order,

      due: (a, b) => a.due_date.localeCompare(b.due_date),

      priority: (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],

      time: (a, b) => b.estimated_minutes - a.estimated_minutes,

      newest: (a, b) => b.created_at.localeCompare(a.created_at),
    };

    const compare = comparisons[sort] ?? comparisons.manual;

    result.sort(
      (a, b) =>
        compare(a, b) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id)
    );

    return result;
  }

  function editTask(task) {
    setValue("task-id", task.id);
    setValue("task-name", task.title);
    setValue("task-due", task.due_date);
    setValue("task-priority", task.priority);
    setValue("task-tags", (task.tags ?? []).join(", "));
    setValue("task-estimated", task.estimated_minutes);
    setValue("task-status", task.status);

    hidden("task-cancel-button", false);
    text("task-save-button", "할 일 수정 저장");
    message("task-message", "");

    window.PdsView?.focusNode("task-name");
  }

  async function saveChange(path, method, body, messageId, successText) {
    if (context.state.busy || !context.state.loaded) return false;

    message(messageId, "저장하고 있습니다.");

    try {
      // API 호출과 전체 데이터 재조회는 공통 파일에서 처리합니다.
      await context.save(path, method, body);

      message(messageId, successText);
      return true;
    } catch (error) {
      message(
        messageId,
        error.message || "처리하지 못했습니다. 다시 시도해 주세요.",
        true
      );

      return false;
    }
  }

  async function toggleTask(task) {
    const nextStatus = task.status === "done" ? "todo" : "done";

    await saveChange(
      `/api/tasks?id=${encodeURIComponent(task.id)}`,
      "PATCH",
      { status: nextStatus },
      "task-message",
      nextStatus === "done"
        ? "완료로 변경했습니다. 실행 기록은 별도로 작성해 주세요."
        : "할 예정 상태로 되돌렸습니다."
    );
  }

  async function deleteTask(task) {
    if (context.state.busy) return;

    const agreed = window.confirm(
      `"${task.title}"을 삭제할까요?\n연결된 실행 기록도 함께 삭제됩니다.`
    );

    if (!agreed) return;

    const saved = await saveChange(
      `/api/tasks?id=${encodeURIComponent(task.id)}`,
      "DELETE",
      undefined,
      "task-message",
      "할 일을 삭제했습니다."
    );

    if (saved && value("task-id") === task.id) {
      resetTaskForm();
      message("task-message", "할 일을 삭제했습니다.");
    }
  }

  function renderTasks() {
    const list = element("task-list");

    if (!list) return;

    list.replaceChildren();

    const tasks = filteredTasks();
    const total = selectedTasks().length;

    text("task-count", `${tasks.length}개 / 전체 ${total}개`);
    hidden("task-empty", tasks.length > 0);

    text(
      "task-empty",
      selectedPlan()
        ? "조건에 맞는 할 일이 없습니다."
        : "먼저 계획을 선택하거나 작성해 주세요."
    );

    tasks.forEach((task) => {
      const item = document.createElement("li");

      item.id = `task-${task.id}`;
      item.className = "task-item";
      item.tabIndex = -1;

      const title = document.createElement("h4");
      title.textContent = task.title;

      const actual = context.state.logs
        .filter((log) => log.task_id === task.id)
        .reduce((sum, log) => sum + log.actual_minutes, 0);

      const meta = paragraph(
        `${STATUSES[task.status]} · 마감 ${task.due_date} · ` +
        `우선순위 ${PRIORITIES[task.priority]} · ` +
        `예상 ${task.estimated_minutes}분 · 실제 ${actual}분`,
        "task-meta"
      );

      const actions = document.createElement("div");
      actions.className = "task-actions";

      actions.append(
        button("수정", () => editTask(task)),
        button(
          task.status === "done" ? "완료 되돌리기" : "완료",
          () => void toggleTask(task)
        ),
        button("실행 기록", () => {
          // 실행 기록 화면이 이 이벤트를 받아 작성 폼을 엽니다.
          window.PdsView?.show("do", false);

          window.dispatchEvent(
            new CustomEvent("pds:log-task", {
              detail: { taskId: task.id },
            })
          );
        }),
        button("삭제", () => void deleteTask(task), "danger")
      );

      item.append(title, meta);

      if (task.tags?.length) {
        item.append(paragraph(task.tags.join(" · "), "task-tags"));
      }

      item.append(actions);
      list.append(item);
    });
  }

  async function submitPlan(event) {
    event.preventDefault();

    if (context.state.busy || !context.state.loaded) return;

    try {
      const start = date(value("plan-start"), "시작일");
      const end = date(value("plan-end"), "종료일");

      if (end < start) {
        throw new Error("종료일은 시작일보다 빠를 수 없습니다.");
      }

      const id = value("plan-id");

      const payload = {
        title: requiredText(value("plan-name"), "계획 이름", 100),
        goal: optionalText(value("plan-goal"), "목표", 2000),
        start_date: start,
        end_date: end,
        priority: choice(
          value("plan-priority"),
          PRIORITIES,
          "우선순위"
        ),
        success_criteria: requiredText(
          value("plan-success"),
          "성공 기준",
          2000
        ),
        estimated_minutes: integer(
          value("plan-estimated"),
          "예상 시간",
          1,
          525600
        ),
      };

      if (!id) {
        payload.previous_plan_id = value("previous-plan-id") || null;
      }

      message("plan-message", "계획을 저장하고 있습니다.");

      const result = await context.save(
        id ? `/api/plans?id=${encodeURIComponent(id)}` : "/api/plans",
        id ? "PATCH" : "POST",
        payload
      );

      const savedPlan = result?.plan;

      if (savedPlan?.id) {
        selectPlan(savedPlan.id, "plan-title");
      }

      message(
        "plan-message",
        id
          ? "계획을 수정했습니다. 수정 전 내용은 변경 기록에서 확인할 수 있습니다."
          : "계획을 저장했습니다. 이제 할 일을 추가해 주세요."
      );
    } catch (error) {
      message("plan-message", error.message, true);
    }
  }

  async function submitTask(event) {
    event.preventDefault();

    if (context.state.busy || !context.state.loaded) return;

    try {
      const plan = selectedPlan();

      if (!plan) {
        throw new Error("먼저 계획을 저장하거나 선택해 주세요.");
      }

      const id = value("task-id");

      const payload = {
        title: requiredText(value("task-name"), "할 일 이름", 200),
        due_date: date(value("task-due"), "마감일"),
        priority: choice(
          value("task-priority"),
          PRIORITIES,
          "우선순위"
        ),
        tags: tags(value("task-tags")),
        estimated_minutes: integer(
          value("task-estimated"),
          "예상 시간",
          1,
          1440
        ),
        status: choice(value("task-status"), STATUSES, "상태"),
      };

      if (!id) {
        payload.plan_id = plan.id;

        const orders = selectedTasks().map((task) => task.sort_order);
        payload.sort_order = orders.length ? Math.max(...orders) + 1 : 0;
      }

      const saved = await saveChange(
        id ? `/api/tasks?id=${encodeURIComponent(id)}` : "/api/tasks",
        id ? "PATCH" : "POST",
        payload,
        "task-message",
        id ? "할 일을 수정했습니다." : "할 일을 저장했습니다."
      );

      if (saved) {
        resetTaskForm();
        message(
          "task-message",
          id ? "할 일을 수정했습니다." : "할 일을 저장했습니다."
        );
      }
    } catch (error) {
      message("task-message", error.message, true);
    }
  }

  async function deletePlan() {
    const plan = selectedPlan();

    if (!plan || context.state.busy) return;

    const agreed = window.confirm(
      `"${plan.title}" 계획을 삭제할까요?\n` +
      "연결된 할 일·실행 기록·계획 변경 기록도 함께 삭제됩니다."
    );

    if (!agreed) return;

    const saved = await saveChange(
      `/api/plans?id=${encodeURIComponent(plan.id)}`,
      "DELETE",
      undefined,
      "plan-message",
      "계획을 삭제했습니다."
    );

    if (saved) {
      newPlan();
      message("plan-message", "계획을 삭제했습니다.");
    }
  }

  async function loadHistory() {
    const plan = selectedPlan();

    if (!plan || context.state.busy) return;

    const requestId = ++historyRequest;
    const loadButton = element("load-history-button");

    if (loadButton) loadButton.disabled = true;

    message("plan-history-message", "변경 기록을 불러오고 있습니다.");

    try {
      const result = await context.request(
        `/api/plans?id=${encodeURIComponent(plan.id)}&history=true`
      );

      // 조회 중 계획이나 로그인 상태가 바뀌면 결과를 표시하지 않습니다.
      if (
        requestId !== historyRequest ||
        context.state.selectedPlanId !== plan.id ||
        !window.PdsAuth?.isActive()
      ) {
        return;
      }

      const versions = result?.versions;

      if (!Array.isArray(versions)) {
        throw new Error("변경 기록 응답 형식을 확인해 주세요.");
      }

      const list = element("plan-history-list");

      if (!list) return;

      list.replaceChildren();

      [...versions]
        .sort((a, b) => a.version - b.version)
        .forEach((version) => {
          const item = document.createElement("li");
          const details = document.createElement("details");
          const summary = document.createElement("summary");

          summary.textContent =
            `버전 ${version.version} · ${version.recorded_at}` +
            (version.is_migration_baseline
              ? " · 이전 자료의 이전 시점 기준본"
              : "");

          const snapshot = document.createElement("pre");

          // 입력값에 HTML이 있어도 실행하지 않고 글자로 표시합니다.
          snapshot.textContent = JSON.stringify(
            version.snapshot,
            null,
            2
          );

          details.append(summary, snapshot);
          item.append(details);
          list.append(item);
        });

      message(
        "plan-history-message",
        `${versions.length}개의 변경 기록을 확인했습니다.`
      );
    } catch (error) {
      if (requestId === historyRequest) {
        message("plan-history-message", error.message, true);
      }
    } finally {
      if (requestId === historyRequest && loadButton) {
        loadButton.disabled =
          context.state.busy ||
          !selectedPlan() ||
          !context.state.loaded;
      }
    }
  }

  function resetFilters() {
    element("task-filter-form")?.reset();
    renderTasks();
    message("task-filter-message", "검색 조건을 초기화했습니다.");
  }

  function render() {
    if (!initialized) return;

    renderPlans();
    renderTasks();

    const historyButton = element("load-history-button");

    if (historyButton) {
      historyButton.disabled =
        !selectedPlan() ||
        context.state.busy ||
        !context.state.loaded;
    }
  }

  function init(sharedContext) {
    if (initialized) return;

    if (
      !sharedContext?.state ||
      typeof sharedContext.request !== "function" ||
      typeof sharedContext.save !== "function" ||
      typeof sharedContext.render !== "function" ||
      typeof sharedContext.today !== "function"
    ) {
      throw new Error("diary.js의 공통 연결 설정을 확인하세요.");
    }

    context = sharedContext;
    initialized = true;

    listen("plan-form", "submit", submitPlan);
    listen("task-form", "submit", submitTask);

    listen("new-plan-button", "click", () => newPlan());
    listen("plan-cancel-button", "click", fillPlanForm);
    listen("plan-delete-button", "click", () => void deletePlan());

    listen("task-cancel-button", "click", resetTaskForm);
    listen("load-history-button", "click", () => void loadHistory());

    listen("task-filter-form", "submit", (event) => {
      event.preventDefault();
      renderTasks();
      message("task-filter-message", "검색 조건을 적용했습니다.");
    });

    listen("task-filter-reset", "click", resetFilters);

    window.addEventListener("pds:session-ended", () => {
      historyRequest += 1;

      element("plan-list")?.replaceChildren();
      element("task-list")?.replaceChildren();
      element("plan-history-list")?.replaceChildren();

      element("plan-form")?.reset();
      element("task-form")?.reset();
      element("task-filter-form")?.reset();
    });

    fillPlanForm();
    render();
  }

  window.PdsPlan = Object.freeze({
    init,
    render,
    selectPlan,
    newPlan,
    fillPlanForm,
    resetTaskForm,
  });
})();