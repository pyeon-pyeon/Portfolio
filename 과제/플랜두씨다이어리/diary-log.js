"use strict";

(() => {
  let context = null;
  let initialized = false;

  // 응답을 받지 못한 저장 요청을 같은 ID로 재시도하기 위한 값입니다.
  let pendingRequest = null;

  const kstFormatter = new Intl.DateTimeFormat("sv-SE", {
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

  function setValue(id, nextValue) {
    const node = element(id);

    if (node) {
      node.value = nextValue ?? "";
    }
  }

  function text(id, content) {
    const node = element(id);

    if (node) {
      node.textContent = content;
    }
  }

  function hidden(id, shouldHide) {
    const node = element(id);

    if (node) {
      node.hidden = shouldHide;
    }
  }

  function message(content, isError = false) {
    const node = element("log-message");

    if (!node) return;

    node.textContent = content;
    node.classList.toggle("is-error", isError);
    node.setAttribute("role", isError ? "alert" : "status");
  }

  function listen(id, event, handler) {
    const node = element(id);

    if (!node) {
      console.warn(`실행 기록 요소를 찾지 못했습니다: ${id}`);
      return;
    }

    node.addEventListener(event, handler);
  }

  function selectedTasks() {
    return context.state.tasks.filter(
      (task) => task.plan_id === context.state.selectedPlanId
    );
  }

  function selectedLogs() {
    const taskIds = new Set(selectedTasks().map((task) => task.id));

    return context.state.logs.filter(
      (log) => taskIds.has(log.task_id)
    );
  }

  function kstParts(timestamp) {
    const parsed = new Date(timestamp);

    if (!Number.isFinite(parsed.getTime())) return null;

    return Object.fromEntries(
      kstFormatter
        .formatToParts(parsed)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );
  }

  function toInputTime(timestamp) {
    const parts = kstParts(timestamp);

    if (!parts) return "";

    return (
      `${parts.year}-${parts.month}-${parts.day}` +
      `T${parts.hour}:${parts.minute}:${parts.second}`
    );
  }

  function displayTime(timestamp) {
    return toInputTime(timestamp).replace("T", " ") || "시각 없음";
  }

  function parseInputTime(raw, label) {
    const match = String(raw).match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
    );

    if (!match) {
      throw new Error(`${label}을 입력해 주세요.`);
    }

    const [, year, month, day, hour, minute, second = "00"] = match;

    if (
      Number(hour) > 23 ||
      Number(minute) > 59 ||
      Number(second) > 59
    ) {
      throw new Error(`${label}이 올바르지 않습니다.`);
    }

    const normalized =
      `${year}-${month}-${day}T${hour}:${minute}:${second}`;

    // 컴퓨터의 시간대와 관계없이 입력을 KST로 해석합니다.
    const parsed = new Date(`${normalized}+09:00`);

    if (
      !Number.isFinite(parsed.getTime()) ||
      toInputTime(parsed.toISOString()) !== normalized
    ) {
      throw new Error(`${label}이 올바르지 않습니다.`);
    }

    return parsed.toISOString();
  }

  function readTimes() {
    const startedAt = parseInputTime(value("log-start"), "시작 시각");
    const endedAt = parseInputTime(value("log-end"), "종료 시각");

    const elapsed = Date.parse(endedAt) - Date.parse(startedAt);

    if (elapsed <= 0) {
      throw new Error("종료 시각은 시작 시각보다 늦어야 합니다.");
    }

    if (elapsed > 24 * 60 * 60 * 1000) {
      throw new Error("실행 기록 한 건은 24시간 이내로 작성해 주세요.");
    }

    return {
      started_at: startedAt,
      ended_at: endedAt,
      actual_minutes: Math.ceil(elapsed / 60_000),
    };
  }

  function updateDuration() {
    const start = value("log-start");
    const end = value("log-end");

    if (!start || !end) {
      text("log-duration-preview", "시작과 종료 시각을 입력해 주세요.");
      return;
    }

    try {
      const times = readTimes();

      text(
        "log-duration-preview",
        `실제 소요 시간: ${times.actual_minutes}분 · 1분 미만은 올림`
      );
    } catch (error) {
      text("log-duration-preview", error.message);
    }
  }

  function optionalText(raw, label) {
    const result = String(raw).trim();

    if (result.length > 2000) {
      throw new Error(`${label}은 2000자 이하로 입력해 주세요.`);
    }

    return result;
  }

  function createRequestId() {
    if (typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    throw new Error(
      "요청 ID를 만들 수 없습니다. HTTPS 배포 주소에서 실행해 주세요."
    );
  }

  function renderTaskOptions(preferredId = null) {
    const select = element("log-task");

    if (!select) return;

    const previousId = preferredId ?? select.value;
    const tasks = selectedTasks();

    select.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = tasks.length
      ? "할 일을 선택하세요"
      : "선택한 계획에 할 일을 먼저 추가하세요";

    select.append(placeholder);

    tasks.forEach((task) => {
      const option = document.createElement("option");

      option.value = task.id;
      option.textContent = task.title;

      select.append(option);
    });

    select.value = tasks.some((task) => task.id === previousId)
      ? previousId
      : "";
  }

  function resetForm() {
    element("log-form")?.reset();

    setValue("log-id", "");
    setValue("log-request-id", "");

    renderTaskOptions("");

    hidden("log-cancel-button", true);
    text("log-save-button", "실행 기록 저장");
    message("");
    updateDuration();

    // 미확인 요청은 초기화하지 않습니다.
    // 서버에서 저장됐는지 확인할 때까지 동일 ID를 유지합니다.
  }

  function startForTask(taskId) {
    if (context.state.busy || !context.state.loaded) return;

    const task = context.state.tasks.find(
      (item) => item.id === taskId
    );

    if (!task) {
      message("할 일을 찾지 못했습니다. 새로고침해 주세요.", true);
      return;
    }

    if (task.plan_id !== context.state.selectedPlanId) {
      window.PdsPlan?.selectPlan(task.plan_id);
    }

    resetForm();
    renderTaskOptions(task.id);

    setValue("log-start", toInputTime(new Date().toISOString()));

    window.PdsView?.focusNode("log-end");
  }

  function editLog(log) {
    if (context.state.busy || !context.state.loaded) return;

    if (!selectedTasks().some((task) => task.id === log.task_id)) {
      return;
    }

    renderTaskOptions(log.task_id);

    setValue("log-id", log.id);
    setValue("log-request-id", log.client_request_id ?? "");
    setValue("log-start", toInputTime(log.started_at));
    setValue("log-end", toInputTime(log.ended_at));
    setValue("log-note", log.note);
    setValue("log-blocked", log.blocked_reason);

    hidden("log-cancel-button", false);
    text("log-save-button", "실행 기록 수정 저장");
    message("");
    updateDuration();

    window.PdsView?.focusNode("log-start");
  }

  function actionButton(label, handler, className = "") {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = label;
    button.className = className;
    button.disabled = context.state.busy || !context.state.loaded;
    button.addEventListener("click", handler);

    return button;
  }

  async function deleteLog(log) {
    if (context.state.busy || !context.state.loaded) return;

    const agreed = window.confirm(
      "이 실행 기록을 삭제할까요?\n돌아보기 집계에서도 제외됩니다."
    );

    if (!agreed) return;

    message("실행 기록을 삭제하고 있습니다.");

    try {
      await context.save(
        `/api/logs?id=${encodeURIComponent(log.id)}`,
        "DELETE"
      );

      if (value("log-id") === log.id) {
        resetForm();
      }

      message("실행 기록을 삭제했습니다.");
    } catch (error) {
      message(
        error.message || "실행 기록을 삭제하지 못했습니다.",
        true
      );
    }
  }

  function renderLogs() {
    const list = element("log-list");

    if (!list) return;

    list.replaceChildren();

    const logs = [...selectedLogs()].sort(
      (a, b) =>
        b.performed_on.localeCompare(a.performed_on) ||
        (b.started_at ?? b.created_at).localeCompare(
          a.started_at ?? a.created_at
        ) ||
        a.id.localeCompare(b.id)
    );

    text("log-count", `${logs.length}개`);
    hidden("log-empty", logs.length > 0);

    logs.forEach((log) => {
      const task = context.state.tasks.find(
        (item) => item.id === log.task_id
      );

      const item = document.createElement("li");
      item.id = `log-${log.id}`;
      item.className = "log-item";
      item.tabIndex = -1;

      const title = document.createElement("h4");
      title.textContent = task?.title ?? "연결된 할 일";

      const meta = document.createElement("p");
      meta.className = "log-meta";
      meta.textContent =
        `${log.performed_on} · 실제 ${log.actual_minutes}분`;

      const times = document.createElement("p");
      times.textContent = log.started_at && log.ended_at
        ? `${displayTime(log.started_at)} → ${displayTime(log.ended_at)} · KST`
        : "이전 기록: 시작·종료 시각이 저장되어 있지 않습니다.";

      item.append(title, meta, times);

      if (log.note) {
        const note = document.createElement("p");
        note.className = "log-note";
        note.textContent = `한 일: ${log.note}`;

        item.append(note);
      }

      if (log.blocked_reason) {
        const blocked = document.createElement("p");
        blocked.className = "log-blocked";
        blocked.textContent = `막힌 이유: ${log.blocked_reason}`;

        item.append(blocked);
      }

      const actions = document.createElement("div");
      actions.className = "log-actions";

      actions.append(
        actionButton("수정", () => editLog(log)),
        actionButton(
          "삭제",
          () => void deleteLog(log),
          "danger"
        )
      );

      item.append(actions);
      list.append(item);
    });
  }

  function reconcilePendingRequest() {
    if (!pendingRequest) return;

    const found = context.state.logs.some(
      (log) => log.client_request_id === pendingRequest.id
    );

    if (found) {
      pendingRequest = null;
    }
  }

  async function submitLog(event) {
    event.preventDefault();

    if (context.state.busy || !context.state.loaded) return;

    try {
      const taskId = value("log-task");

      const task = selectedTasks().find(
        (item) => item.id === taskId
      );

      if (!task) {
        throw new Error("선택한 계획의 할 일을 선택해 주세요.");
      }

      const id = value("log-id");
      const times = readTimes();

      const payload = {
        task_id: task.id,
        started_at: times.started_at,
        ended_at: times.ended_at,
        note: optionalText(value("log-note"), "한 일"),
        blocked_reason: optionalText(
          value("log-blocked"),
          "막힌 이유"
        ),
      };

      // 실제 시간과 기록 날짜는 서버가 시각을 기준으로 계산합니다.
      if (!id) {
        const fingerprint = JSON.stringify(payload);

        if (
          pendingRequest &&
          pendingRequest.fingerprint !== fingerprint
        ) {
          throw new Error(
            "이전 저장 요청의 결과가 아직 확인되지 않았습니다. " +
            "먼저 새로고침 버튼으로 기록을 다시 조회하거나, " +
            "이전 입력 내용으로 저장을 재시도해 주세요."
          );
        }

        if (!pendingRequest) {
          pendingRequest = {
            id: createRequestId(),
            fingerprint,
          };
        }

        payload.client_request_id = pendingRequest.id;
        setValue("log-request-id", pendingRequest.id);
      }

      message("실행 기록을 저장하고 있습니다.");

      const result = await context.save(
        id ? `/api/logs?id=${encodeURIComponent(id)}` : "/api/logs",
        id ? "PATCH" : "POST",
        payload
      );

      if (!id) {
        pendingRequest = null;
      }

      resetForm();

      message(
        result?.replayed
          ? "이미 저장된 요청을 확인했습니다. 중복 기록은 추가하지 않았습니다."
          : id
            ? "실행 기록을 수정했습니다."
            : "실행 기록을 저장했습니다. 할 일의 완료 상태는 별도로 변경해 주세요."
      );
    } catch (error) {
      message(
        error.message || "실행 기록을 저장하지 못했습니다.",
        true
      );
    }
  }

  function render() {
    if (!initialized) return;

    reconcilePendingRequest();
    renderTaskOptions();
    renderLogs();
  }

  function init(sharedContext) {
    if (initialized) return;

    if (
      !sharedContext?.state ||
      typeof sharedContext.save !== "function"
    ) {
      throw new Error("diary.js의 실행 기록 연결 설정을 확인하세요.");
    }

    context = sharedContext;
    initialized = true;

    listen("log-form", "submit", submitLog);
    listen("log-start", "input", updateDuration);
    listen("log-end", "input", updateDuration);
    listen("log-cancel-button", "click", resetForm);

    window.addEventListener("pds:log-task", (event) => {
      const taskId = event.detail?.taskId;

      if (typeof taskId === "string") {
        startForTask(taskId);
      }
    });

    window.addEventListener("pds:session-ended", () => {
      pendingRequest = null;

      element("log-form")?.reset();
      element("log-list")?.replaceChildren();

      setValue("log-id", "");
      setValue("log-request-id", "");

      element("log-task")?.replaceChildren();
      text("log-duration-preview", "");
      message("");
    });

    resetForm();
    render();
  }

  window.PdsLog = Object.freeze({
    init,
    render,
    resetForm,
    startForTask,
  });
})();