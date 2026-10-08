"use strict";

(() => {
  let context = null;
  let initialized = false;
  let exporting = false;
  let reviewPlanId = null;
  let evidenceType = null;

  const STATUS_LABELS = {
    todo: "할 예정",
    doing: "진행 중",
    done: "완료",
    cancelled: "취소",
  };

  // 실제 HTML의 집계 요소 ID는 이곳에서 관리합니다.
  const SUMMARY_ITEMS = {
    plan: {
      button: "summary-plan-button",
      value: "summary-plan-count",
      title: "기간에 포함된 계획",
    },
    task: {
      button: "summary-task-button",
      value: "summary-task-count",
      title: "기간에 포함된 할 일",
    },
    completed: {
      button: "summary-completed-button",
      value: "summary-completed-count",
      title: "현재 완료 상태인 할 일",
    },
    delayed: {
      button: "summary-delayed-button",
      value: "summary-delayed-count",
      title: "마감일이 지난 미완료 할 일",
    },
    blocked: {
      button: "summary-blocked-button",
      value: "summary-blocked-count",
      title: "막힌 이유가 있는 실행 기록",
    },
    rate: {
      button: "summary-rate-button",
      value: "summary-completion-rate",
      title: "완료율 계산에 사용한 할 일",
    },
    estimated: {
      button: "summary-estimated-button",
      value: "summary-estimated-minutes",
      title: "예상 시간 계산에 사용한 할 일",
    },
    actual: {
      button: "summary-actual-button",
      value: "summary-actual-minutes",
      title: "실제 시간 계산에 사용한 실행 기록",
    },
  };

  const kstDateTime = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function element(id) {
    return document.getElementById(id);
  }

  function value(id) {
    return element(id)?.value ?? "";
  }

  function text(id, content) {
    const node = element(id);

    if (node) {
      node.textContent = content;
    }
  }

  function message(id, content, isError = false) {
    const node = element(id);

    if (!node) return;

    node.textContent = content;
    node.classList.toggle("is-error", isError);
    node.setAttribute("role", isError ? "alert" : "status");
  }

  function listen(id, event, handler) {
    const node = element(id);

    if (!node) {
      console.warn(`돌아보기 요소를 찾지 못했습니다: ${id}`);
      return;
    }

    node.addEventListener(event, handler);
  }

  function sum(rows, field) {
    return rows.reduce((total, row) => total + row[field], 0);
  }

  function readDate(raw, label) {
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

  function inPeriod(date) {
    if (!date) return false;

    const { start, end } = context.state.period;

    return (!start || date >= start) && (!end || date <= end);
  }

  function overlapsPeriod(plan) {
    const { start, end } = context.state.period;

    return (
      (!start || plan.end_date >= start) &&
      (!end || plan.start_date <= end)
    );
  }

  function getStats() {
    const plans = context.state.plans.filter(overlapsPeriod);

    // 할 일은 마감일, 실행 기록은 KST 실행 날짜로 집계합니다.
    const tasks = context.state.tasks.filter(
      (task) => inPeriod(task.due_date)
    );

    const activeTasks = tasks.filter(
      (task) => task.status !== "cancelled"
    );

    const completed = activeTasks.filter(
      (task) => task.status === "done"
    );

    const today = context.today();

    const delayed = activeTasks.filter(
      (task) => task.status !== "done" && task.due_date < today
    );

    const logs = context.state.logs.filter(
      (log) => inPeriod(log.performed_on)
    );

    const blocked = logs.filter(
      (log) => String(log.blocked_reason ?? "").trim() !== ""
    );

    return {
      plans,
      tasks,
      activeTasks,
      completed,
      delayed,
      logs,
      blocked,

      completionRate: activeTasks.length
        ? Math.round((completed.length / activeTasks.length) * 100)
        : 0,

      estimatedMinutes: sum(activeTasks, "estimated_minutes"),
      actualMinutes: sum(logs, "actual_minutes"),
    };
  }

  function renderSummary() {
    const stats = getStats();

    const values = {
      plan: stats.plans.length,
      task: stats.tasks.length,
      completed: stats.completed.length,
      delayed: stats.delayed.length,
      blocked: stats.blocked.length,
      rate: `${stats.completionRate}%`,
      estimated: `${stats.estimatedMinutes}분`,
      actual: `${stats.actualMinutes}분`,
    };

    Object.entries(SUMMARY_ITEMS).forEach(([key, item]) => {
      text(item.value, values[key]);

      const button = element(item.button);

      if (button) {
        button.disabled =
          context.state.busy || !context.state.loaded;
      }
    });

    const { start, end } = context.state.period;

    text(
      "summary-period-label",
      start || end
        ? `${start || "처음"} ~ ${end || "현재"} · KST`
        : "전체 기간 · KST"
    );

    if (evidenceType) {
      renderEvidence();
    }
  }

  function evidenceRows(type, stats) {
    switch (type) {
      case "plan":
        return stats.plans.map((record) => ({
          kind: "plan",
          record,
        }));

      case "task":
        return stats.tasks.map((record) => ({
          kind: "task",
          record,
        }));

      case "completed":
        return stats.completed.map((record) => ({
          kind: "task",
          record,
        }));

      case "delayed":
        return stats.delayed.map((record) => ({
          kind: "task",
          record,
        }));

      case "rate":
      case "estimated":
        return stats.activeTasks.map((record) => ({
          kind: "task",
          record,
        }));

      case "blocked":
        return stats.blocked.map((record) => ({
          kind: "log",
          record,
        }));

      case "actual":
        return stats.logs.map((record) => ({
          kind: "log",
          record,
        }));

      default:
        return [];
    }
  }

  function evidenceDescription(kind, record) {
    if (kind === "plan") {
      return (
        `${record.title} · ${record.start_date} ~ ${record.end_date}`
      );
    }

    if (kind === "task") {
      return (
        `${record.title} · ${STATUS_LABELS[record.status]} · ` +
        `마감 ${record.due_date} · 예상 ${record.estimated_minutes}분`
      );
    }

    const task = context.state.tasks.find(
      (item) => item.id === record.task_id
    );

    return (
      `${task?.title ?? "실행 기록"} · ${record.performed_on} · ` +
      `실제 ${record.actual_minutes}분` +
      (record.blocked_reason
        ? ` · 막힌 이유: ${record.blocked_reason}`
        : "")
    );
  }

  function openEvidenceRecord(kind, record) {
    if (kind === "plan") {
      window.PdsPlan?.selectPlan(record.id, "plan-title");
      return;
    }

    if (kind === "task") {
      window.PdsPlan?.selectPlan(
        record.plan_id,
        `task-${record.id}`
      );
      return;
    }

    const task = context.state.tasks.find(
      (item) => item.id === record.task_id
    );

    if (task) {
      window.PdsPlan?.selectPlan(
        task.plan_id,
        `log-${record.id}`
      );
    }
  }

  function renderEvidence() {
    const section = element("summary-evidence");
    const list = element("evidence-list");

    if (!section || !list || !evidenceType) return;

    const rows = evidenceRows(evidenceType, getStats());

    section.hidden = false;
    list.replaceChildren();

    text(
      "evidence-title",
      SUMMARY_ITEMS[evidenceType].title
    );

    text(
      "evidence-message",
      rows.length
        ? `${rows.length}건입니다. 항목을 누르면 원래 기록으로 이동합니다.`
        : "조건에 맞는 기록이 없습니다."
    );

    rows.forEach(({ kind, record }) => {
      const item = document.createElement("li");
      const button = document.createElement("button");

      button.type = "button";
      button.textContent = evidenceDescription(kind, record);
      button.disabled =
        context.state.busy || !context.state.loaded;

      button.addEventListener("click", () => {
        openEvidenceRecord(kind, record);
      });

      item.append(button);
      list.append(item);
    });
  }

  function showEvidence(type) {
    if (!SUMMARY_ITEMS[type]) return;

    evidenceType = type;
    renderEvidence();
    window.PdsView?.focusNode("evidence-title");
  }

  function closeEvidence() {
    const previousType = evidenceType;

    evidenceType = null;

    const section = element("summary-evidence");

    if (section) {
      section.hidden = true;
    }

    element("evidence-list")?.replaceChildren();

    if (previousType) {
      element(SUMMARY_ITEMS[previousType].button)?.focus();
    }
  }

  function selectedPlan() {
    return context.state.plans.find(
      (plan) => plan.id === context.state.selectedPlanId
    ) ?? null;
  }

  function difference(actual, estimated) {
    const diff = actual - estimated;

    if (diff > 0) return `예상보다 ${diff}분 더 사용`;
    if (diff < 0) return `예상보다 ${Math.abs(diff)}분 적게 사용`;

    return "예상과 동일";
  }

  function renderComparison() {
    const plan = selectedPlan();
    const body = element("comparison-body");

    if (body) {
      body.replaceChildren();
    }

    if (!plan) {
      text("selected-plan-label", "계획을 선택해 주세요.");
      text("selected-success-criteria", "—");

      [
        "selected-plan-estimated",
        "selected-task-estimated",
        "selected-actual",
        "plan-time-difference",
        "task-time-difference",
        "selected-completion",
      ].forEach((id) => text(id, "—"));

      if (body) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 6;
        cell.textContent = "먼저 계획을 선택해 주세요.";

        row.append(cell);
        body.append(row);
      }

      return;
    }

    const tasks = context.state.tasks.filter(
      (task) => task.plan_id === plan.id
    );

    const activeTasks = tasks.filter(
      (task) => task.status !== "cancelled"
    );

    const taskIds = new Set(tasks.map((task) => task.id));

    const logs = context.state.logs.filter(
      (log) => taskIds.has(log.task_id)
    );

    const estimated = sum(activeTasks, "estimated_minutes");
    const actual = sum(logs, "actual_minutes");

    const completed = activeTasks.filter(
      (task) => task.status === "done"
    ).length;

    text("selected-plan-label", plan.title);
    text("selected-success-criteria", plan.success_criteria || "—");
    text("selected-plan-estimated", `${plan.estimated_minutes}분`);
    text("selected-task-estimated", `${estimated}분`);
    text("selected-actual", `${actual}분`);

    text(
      "plan-time-difference",
      difference(actual, plan.estimated_minutes)
    );

    text(
      "task-time-difference",
      difference(actual, estimated)
    );

    text(
      "selected-completion",
      `${completed} / ${activeTasks.length}개 완료 · 취소 제외`
    );

    if (!body) return;

    tasks.forEach((task) => {
      const taskActual = sum(
        logs.filter((log) => log.task_id === task.id),
        "actual_minutes"
      );

      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const button = document.createElement("button");

      button.type = "button";
      button.textContent = task.title;
      button.disabled =
        context.state.busy || !context.state.loaded;

      button.addEventListener("click", () => {
        window.PdsPlan?.selectPlan(
          plan.id,
          `task-${task.id}`
        );
      });

      nameCell.append(button);
      row.append(nameCell);

      [
        STATUS_LABELS[task.status],
        task.due_date,
        `${task.estimated_minutes}분`,
        `${taskActual}분`,
        difference(taskActual, task.estimated_minutes),
      ].forEach((content) => {
        const cell = document.createElement("td");
        cell.textContent = content;
        row.append(cell);
      });

      body.append(row);
    });

    if (!tasks.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = 6;
      cell.textContent = "이 계획에 등록된 할 일이 없습니다.";

      row.append(cell);
      body.append(row);
    }
  }

  function fillReviewForm() {
    const plan = selectedPlan();

    element("review-form")?.reset();

    const reflection = element("review-reflection");
    const nextAction = element("review-next-action");

    if (reflection) {
      reflection.value = plan?.reflection ?? "";
    }

    if (nextAction) {
      nextAction.value = plan?.next_action ?? "";
    }

    reviewPlanId = plan?.id ?? null;

    message("review-message", "");
  }

  function renderReview() {
    const plan = selectedPlan();

    if ((plan?.id ?? null) !== reviewPlanId) {
      fillReviewForm();
    }

    const reviewedAt = plan?.reviewed_at;
    const parsed = reviewedAt ? new Date(reviewedAt) : null;

    text(
      "reviewed-at",
      parsed && Number.isFinite(parsed.getTime())
        ? `최근 저장: ${kstDateTime.format(parsed)} · KST`
        : "아직 돌아보기를 저장하지 않았습니다."
    );

    const nextButton = element("create-next-plan-button");

    if (nextButton) {
      nextButton.disabled =
        context.state.busy ||
        !context.state.loaded ||
        !plan ||
        !String(plan.next_action ?? "").trim();
    }

    const fieldset = element("review-fields");

    if (fieldset) {
      fieldset.disabled =
        context.state.busy ||
        !context.state.loaded ||
        !plan;
    }
  }

  async function submitReview(event) {
    event.preventDefault();

    if (context.state.busy || !context.state.loaded) return;

    try {
      const plan = selectedPlan();

      if (!plan) {
        throw new Error("돌아볼 계획을 먼저 선택해 주세요.");
      }

      const reflection = value("review-reflection").trim();
      const nextAction = value("review-next-action").trim();

      if (!reflection) {
        throw new Error("돌아본 내용을 입력해 주세요.");
      }

      if (reflection.length > 4000) {
        throw new Error("돌아보기는 4000자 이하로 입력해 주세요.");
      }

      if (!nextAction) {
        throw new Error("다음 계획에 반영할 개선점을 입력해 주세요.");
      }

      if (
        nextAction.length > 2000 ||
        /[\r\n]/.test(nextAction)
      ) {
        throw new Error(
          "다음 개선점은 줄바꿈 없이 2000자 이하로 입력해 주세요."
        );
      }

      message("review-message", "돌아보기를 저장하고 있습니다.");

      await context.save(
        `/api/plans?id=${encodeURIComponent(plan.id)}`,
        "PATCH",
        {
          reflection,
          next_action: nextAction,
        }
      );

      message(
        "review-message",
        "돌아보기를 저장했습니다. 개선점을 다음 계획으로 가져올 수 있습니다."
      );
    } catch (error) {
      message("review-message", error.message, true);
    }
  }

  function createNextPlan() {
    const plan = selectedPlan();

    if (
      !plan ||
      context.state.busy ||
      !String(plan.next_action ?? "").trim()
    ) {
      return;
    }

    // 새 계획을 자동 저장하지 않습니다.
    // 목표를 가져온 뒤 기간·성공 기준·예상 시간을 직접 확인합니다.
    window.PdsPlan?.newPlan(plan);
  }

  function applyPeriod(event) {
    event.preventDefault();

    try {
      const start = readDate(value("summary-start"), "집계 시작일");
      const end = readDate(value("summary-end"), "집계 종료일");

      if (end < start) {
        throw new Error("종료일은 시작일보다 빠를 수 없습니다.");
      }

      context.state.period = { start, end };

      renderSummary();

      message("summary-message", "집계 기간을 적용했습니다.");
    } catch (error) {
      message("summary-message", error.message, true);
    }
  }

  function allPeriod() {
    context.state.period = {
      start: "",
      end: "",
    };

    const start = element("summary-start");
    const end = element("summary-end");

    if (start) start.value = "";
    if (end) end.value = "";

    renderSummary();
    message("summary-message", "전체 기간을 표시합니다.");
  }

  function checkExportSession(userId) {
    const user = window.PdsAuth?.getUser();

    if (
      !window.PdsAuth?.isActive() ||
      !user ||
      user.id !== userId
    ) {
      throw new Error(
        "로그인 상태가 변경되어 내보내기를 중단했습니다."
      );
    }
  }

  async function exportData() {
    if (
      exporting ||
      context.state.busy ||
      !context.state.loaded
    ) {
      return;
    }

    const user = window.PdsAuth?.getUser();

    if (!user || !window.PdsAuth?.isActive()) {
      window.PdsAuth?.endSession();
      return;
    }

    exporting = true;

    const exportButton = element("export-button");

    if (exportButton) exportButton.disabled = true;

    message("export-message", "내 자료를 불러오고 있습니다.");

    try {
      const [planResult, taskResult, logResult] = await Promise.all([
        context.request("/api/plans"),
        context.request("/api/tasks"),
        context.request("/api/logs"),
      ]);

      checkExportSession(user.id);

      if (
        !Array.isArray(planResult?.plans) ||
        !Array.isArray(taskResult?.tasks) ||
        !Array.isArray(logResult?.logs)
      ) {
        throw new Error("내보내기 자료 형식을 확인해 주세요.");
      }

      const plans = planResult.plans;
      const tasks = taskResult.tasks;
      const logs = logResult.logs;

      // 비밀번호·세션·토큰은 내보내기 자료에 포함하지 않습니다.
      const planIds = new Set(plans.map((plan) => plan.id));

      if (plans.some((plan) => plan.owner_id !== user.id)) {
        throw new Error(
          "자료의 소유자가 일치하지 않아 내보내기를 중단했습니다."
        );
      }

      if (tasks.some((task) => !planIds.has(task.plan_id))) {
        throw new Error(
          "할 일의 계획 연결이 일치하지 않습니다. 다시 조회해 주세요."
        );
      }

      const taskIds = new Set(tasks.map((task) => task.id));

      if (logs.some((log) => !taskIds.has(log.task_id))) {
        throw new Error(
          "실행 기록의 할 일 연결이 일치하지 않습니다. 다시 조회해 주세요."
        );
      }

      const versions = [];

      for (const plan of plans) {
        checkExportSession(user.id);

        const result = await context.request(
          `/api/plans?id=${encodeURIComponent(plan.id)}&history=true`
        );

        if (!Array.isArray(result?.versions)) {
          throw new Error("계획 변경 기록을 가져오지 못했습니다.");
        }

        if (
          result.versions.some(
            (version) => version.plan_id !== plan.id
          )
        ) {
          throw new Error("계획 변경 기록의 연결이 올바르지 않습니다.");
        }

        const latestVersion = result.versions.reduce(
          (latest, version) => Math.max(latest, version.version),
          0
        );

        if (latestVersion !== plan.version) {
          throw new Error(
            "내보내기 중 계획이 변경되었습니다. 다시 시도해 주세요."
          );
        }

        versions.push(...result.versions);
      }

      checkExportSession(user.id);

      const data = {
        metadata: {
          format: "pds-diary-export",
          format_version: 1,
          exported_at: new Date().toISOString(),
          timezone: "Asia/Seoul",
          note:
            "여러 API에서 순차 조회한 자료입니다. " +
            "전체 데이터베이스의 동일 시점 스냅샷은 아닙니다.",
        },
        plans,
        tasks,
        logs,
        plan_versions: versions,
      };

      const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: "application/json;charset=utf-8" }
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      try {
        link.href = url;
        link.download = `pds-diary-${context.today()}.json`;

        document.body.append(link);
        link.click();
      } finally {
        link.remove();

        window.setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 10_000);
      }

      message(
        "export-message",
        `계획 ${plans.length}개, 할 일 ${tasks.length}개, ` +
        `실행 기록 ${logs.length}개와 변경 기록을 내보냈습니다.`
      );
    } catch (error) {
      if (window.PdsAuth?.isActive()) {
        message("export-message", error.message, true);
      }
    } finally {
      exporting = false;

      if (exportButton) {
        exportButton.disabled =
          context.state.busy ||
          !context.state.loaded ||
          !window.PdsAuth?.isActive();
      }
    }
  }

  function render() {
    if (!initialized) return;

    renderSummary();
    renderComparison();
    renderReview();

    const exportButton = element("export-button");

    if (exportButton) {
      exportButton.disabled =
        exporting ||
        context.state.busy ||
        !context.state.loaded;
    }
  }

  function clearPrivateContent() {
    evidenceType = null;
    reviewPlanId = null;

    element("review-form")?.reset();
    element("evidence-list")?.replaceChildren();
    element("comparison-body")?.replaceChildren();

    const evidence = element("summary-evidence");

    if (evidence) evidence.hidden = true;

    Object.values(SUMMARY_ITEMS).forEach((item) => {
      text(item.value, "—");
    });

    [
      "selected-plan-label",
      "selected-success-criteria",
      "selected-plan-estimated",
      "selected-task-estimated",
      "selected-actual",
      "plan-time-difference",
      "task-time-difference",
      "selected-completion",
      "reviewed-at",
      "evidence-title",
      "evidence-message",
    ].forEach((id) => text(id, ""));

    message("review-message", "");
    message("export-message", "");
  }

  function init(sharedContext) {
    if (initialized) return;

    if (
      !sharedContext?.state ||
      typeof sharedContext.request !== "function" ||
      typeof sharedContext.save !== "function" ||
      typeof sharedContext.today !== "function"
    ) {
      throw new Error("diary.js의 공통 연결 설정을 확인하세요.");
    }

    context = sharedContext;

    context.state.period ??= {
      start: "",
      end: "",
    };

    initialized = true;

    Object.entries(SUMMARY_ITEMS).forEach(([type, item]) => {
      listen(item.button, "click", () => showEvidence(type));
    });

    listen("summary-filter-form", "submit", applyPeriod);
    listen("summary-all-button", "click", allPeriod);
    listen("close-evidence-button", "click", closeEvidence);

    listen("review-form", "submit", submitReview);
    listen("create-next-plan-button", "click", createNextPlan);
    listen("export-button", "click", () => void exportData());

    window.addEventListener(
      "pds:session-ended",
      clearPrivateContent
    );

    fillReviewForm();
    render();
  }

  window.PdsSee = Object.freeze({
    init,
    render,
    fillReviewForm,
    getStats,
  });
})();