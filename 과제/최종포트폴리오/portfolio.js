"use strict";

(() => {
  // ========================================
  // 공통 설정
  // ========================================

  const DATA_URL = "./data/approved.json";

  const motionQuery = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  );

  const statusElement = document.getElementById("data-status");

  function setStatus(message) {
    if (statusElement) {
      statusElement.textContent = message;
    }
  }

  function isObject(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    );
  }

  function isText(value, maxLength = 1000) {
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= maxLength
    );
  }

  function isCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isDate(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
      return false;
    }

    const parsed = new Date(`${value}T00:00:00Z`);

    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }

  // ========================================
  // 스크롤 진행률
  // ========================================

  function setupReadingProgress() {
    const bar = document.getElementById("reading-progress");

    if (!bar) {
      return;
    }

    let scheduled = false;

    function render() {
      const root = document.documentElement;

      const scrollableHeight = Math.max(
        0,
        root.scrollHeight - root.clientHeight
      );

      const progress = scrollableHeight > 0
        ? Math.min(
            1,
            Math.max(0, window.scrollY / scrollableHeight)
          )
        : 0;

      bar.style.transform = `scaleX(${progress})`;

      scheduled = false;
    }

    function schedule() {
      if (scheduled) {
        return;
      }

      scheduled = true;
      window.requestAnimationFrame(render);
    }

    window.addEventListener("scroll", schedule, {
      passive: true,
    });

    window.addEventListener("resize", schedule);

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(schedule);

      observer.observe(document.body);
    }

    render();
  }

  // ========================================
  // 현재 위치의 메뉴 표시
  // ========================================

  function setupNavigation() {
    const links = Array.from(
      document.querySelectorAll(".main-nav a[href^='#']")
    );

    const entries = links
      .map((link) => {
        const id = link.getAttribute("href").slice(1);

        return {
          link,
          section: document.getElementById(id),
        };
      })
      .filter((entry) => entry.section);

    if (entries.length === 0) {
      return;
    }

    let scheduled = false;

    function render() {
      const header = document.querySelector(".site-header");

      const boundary = (
        header ? header.getBoundingClientRect().height : 0
      ) + Math.min(window.innerHeight * 0.25, 180);

      let current = null;

      for (const entry of entries) {
        if (entry.section.getBoundingClientRect().top <= boundary) {
          current = entry;
        }
      }

      for (const entry of entries) {
        if (entry === current) {
          entry.link.setAttribute(
            "aria-current",
            "location"
          );
        } else {
          entry.link.removeAttribute("aria-current");
        }
      }

      scheduled = false;
    }

    function schedule() {
      if (scheduled) {
        return;
      }

      scheduled = true;
      window.requestAnimationFrame(render);
    }

    window.addEventListener("scroll", schedule, {
      passive: true,
    });

    window.addEventListener("resize", schedule);

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(schedule);

      observer.observe(document.body);
    }

    render();
  }

  // ========================================
  // 스크롤 등장 효과
  // 키보드로 접근하면 즉시 표시합니다.
  // ========================================

  function setupReveal() {
    if (
      motionQuery.matches ||
      !("IntersectionObserver" in window)
    ) {
      return;
    }

    const elements = Array.from(
      document.querySelectorAll([
        ".section-heading",
        ".story-row",
        ".story-statement",
        ".metric-card",
        ".recovery-panel",
        ".featured-work",
        ".upcoming-work",
        ".career-entry",
        ".update-panel",
      ].join(","))
    );

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          entry.target.classList.add("is-visible");

          observer.unobserve(entry.target);
        }
      },
      {
        threshold: 0,
        rootMargin: "0px 0px 40px 0px",
      }
    );

    for (const element of elements) {
      // 처음부터 화면에 있는 내용은 숨기지 않습니다.
      if (
        element.getBoundingClientRect().top <
        window.innerHeight
      ) {
        continue;
      }

      element.classList.add("reveal-pending");

      observer.observe(element);
    }

    document.addEventListener("focusin", (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const target = event.target.closest(
        ".reveal-pending"
      );

      if (target) {
        target.classList.add("is-visible");
        observer.unobserve(target);
      }
    });

    function revealAll() {
      observer.disconnect();

      for (const element of elements) {
        element.classList.add("is-visible");
        element.classList.remove("reveal-pending");
      }
    }

    motionQuery.addEventListener("change", (event) => {
      if (event.matches) {
        revealAll();
      }
    });

    window.addEventListener("beforeprint", revealAll);
  }

  // ========================================
  // 승인 데이터 검증
  //
  // 생성 후보 파일은 읽지 않습니다.
  // approved.json만 반영합니다.
  // ========================================

  function validateMetrics(metrics) {
    if (!isObject(metrics)) {
      throw new Error("숫자 자료의 형식이 올바르지 않습니다.");
    }

    const countKeys = [
      "recordDays",
      "openCount",
      "closeCount",
      "practiced",
      "partial",
      "notPracticed",
    ];

    for (const key of countKeys) {
      if (!isCount(metrics[key])) {
        throw new Error("집계 숫자를 확인해 주세요.");
      }
    }

    if (
      !isDate(metrics.startDate) ||
      !isDate(metrics.endDate) ||
      metrics.startDate > metrics.endDate
    ) {
      throw new Error("집계 기간을 확인해 주세요.");
    }

    const {
      recordDays,
      openCount,
      closeCount,
      practiced,
      partial,
      notPracticed,
    } = metrics;

    if (
      practiced + partial + notPracticed !== closeCount
    ) {
      throw new Error("마무리 기록의 분류 합계가 맞지 않습니다.");
    }

    if (
      openCount > recordDays ||
      closeCount > recordDays ||
      recordDays > openCount + closeCount
    ) {
      throw new Error("기록 날짜와 기록 건수가 맞지 않습니다.");
    }

    if (!isText(metrics.source, 200)) {
      throw new Error("숫자의 출처가 필요합니다.");
    }

    const periodDays = Math.round(
      (
        Date.parse(`${metrics.endDate}T00:00:00Z`) -
        Date.parse(`${metrics.startDate}T00:00:00Z`)
      ) / 86400000
    ) + 1;

    if (recordDays > periodDays) {
      throw new Error("기록 날짜 수가 집계 기간보다 많습니다.");
    }
  }

  function validateParagraphs(paragraphs) {
    if (!Array.isArray(paragraphs) || paragraphs.length > 30) {
      throw new Error("문단 목록을 확인해 주세요.");
    }

    const allowedAbilities = new Set([
      "자기조절력",
      "대인관계력",
      "자기동기력",
    ]);

    const ids = new Set();

    for (const paragraph of paragraphs) {
      if (
        !isObject(paragraph) ||
        !isText(paragraph.id, 80) ||
        ids.has(paragraph.id) ||
        paragraph.approved !== true ||
        !allowedAbilities.has(paragraph.ability) ||
        !isDate(paragraph.date) ||
        !isText(paragraph.text, 1500) ||
        !isText(paragraph.evidence, 500)
      ) {
        throw new Error("승인 문단의 내용이나 근거를 확인해 주세요.");
      }

      ids.add(paragraph.id);
    }
  }

  // 상대 경로와 HTTPS 주소만 허용합니다.
  // 계정·비밀값을 주소에 넣지 않습니다.
  function readPublicUrl(value, type = "web") {
    if (!isText(value, 1000)) {
      throw new Error("공개 링크 주소를 확인해 주세요.");
    }

    if (type === "email") {
      const email = value.trim();

      if (
        !/^[^\s@<>?&#]+@[^\s@<>?&#]+\.[^\s@<>?&#]+$/.test(email)
      ) {
        throw new Error("공개 이메일 주소를 확인해 주세요.");
      }

      return `mailto:${email}`;
    }

    const url = new URL(value, window.location.href);

    const localDevelopmentUrl = (
      ["localhost", "127.0.0.1", "[::1]"].includes(
        window.location.hostname
      ) &&
      url.origin === window.location.origin &&
      url.protocol === "http:"
    );

    if (
      (url.protocol !== "https:" && !localDevelopmentUrl) ||
      url.username ||
      url.password ||
      url.search
    ) {
      throw new Error("공개 링크는 비밀값 없는 HTTPS 주소로 지정해 주세요.");
    }

    return url.href;
  }
    // ========================================
  // 출석·제출·승인 자료 검증
  // ========================================

  function validateAttendance(attendance) {
    if (
      !isObject(attendance) ||
      !isText(attendance.source, 500) ||
      !isText(attendance.sourceFile, 200) ||
      !isDate(attendance.capturedOn) ||
      attendance.timezone !== "Asia/Seoul" ||
      !isObject(attendance.period) ||
      !isObject(attendance.summary)
    ) {
      throw new Error("출석 자료의 형식을 확인해 주세요.");
    }

    const period = attendance.period;
    const summary = attendance.summary;

    if (
      !isDate(period.startDate) ||
      !isDate(period.endDate) ||
      period.startDate > period.endDate ||
      period.endDate > attendance.capturedOn ||
      !isText(period.scope, 500)
    ) {
      throw new Error("출석 집계 기간을 확인해 주세요.");
    }

    const countKeys = [
      "trainingDays",
      "enrolledDays",
      "presentDays",
      "absentDays",
      "pendingDays",
    ];

    for (const key of countKeys) {
      if (!isCount(summary[key])) {
        throw new Error("출석 집계 숫자를 확인해 주세요.");
      }
    }

    if (
      summary.enrolledDays > summary.trainingDays ||
      (
        summary.presentDays +
        summary.absentDays +
        summary.pendingDays
      ) > summary.enrolledDays
    ) {
      throw new Error("출석 집계의 합계를 확인해 주세요.");
    }

    const rate = summary.displayedAttendanceRate;

    if (
      typeof rate !== "number" ||
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > 100
    ) {
      throw new Error("화면 표시 출석률을 확인해 주세요.");
    }

    const pendingDates = attendance.pendingDates;

    if (
      !Array.isArray(pendingDates) ||
      pendingDates.length !== summary.pendingDays ||
      new Set(pendingDates).size !== pendingDates.length ||
      pendingDates.some((day) => (
        !isDate(day) ||
        day < period.startDate ||
        day > period.endDate
      ))
    ) {
      throw new Error("미확정 출석 날짜를 확인해 주세요.");
    }

    if (!isText(attendance.rateBasis, 500)) {
      throw new Error("출석률의 출처 설명이 필요합니다.");
    }
  }

  function validateTasks(tasks) {
    if (
      !isObject(tasks) ||
      !isText(tasks.source, 500) ||
      !isDate(tasks.capturedOn) ||
      tasks.timezone !== "Asia/Seoul" ||
      !isText(tasks.scope, 500) ||
      !isText(tasks.approvalBasis, 1000) ||
      !Array.isArray(tasks.items)
    ) {
      throw new Error("과제 기록의 형식을 확인해 주세요.");
    }

    for (const key of [
      "submittedCount",
      "approvedCount",
      "reviewUnknownCount",
    ]) {
      if (!isCount(tasks[key])) {
        throw new Error("과제 집계 숫자를 확인해 주세요.");
      }
    }

    const ids = new Set();
    let approvedCount = 0;

    for (const task of tasks.items) {
      if (
        !isObject(task) ||
        typeof task.id !== "string" ||
        !/^T\d{2}$/.test(task.id) ||
        ids.has(task.id) ||
        !isText(task.title, 300) ||
        task.status !== "submitted" ||
        !isText(task.sourceFile, 200)
      ) {
        throw new Error("과제별 제출 기록을 확인해 주세요.");
      }

      ids.add(task.id);

      const submittedAt = task.submittedAt;

      if (
        typeof submittedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(
          submittedAt
        ) ||
        !isDate(submittedAt.slice(0, 10)) ||
        Number(submittedAt.slice(11, 13)) > 23 ||
        Number(submittedAt.slice(14, 16)) > 59 ||
        Number(submittedAt.slice(17, 19)) > 59 ||
        submittedAt.slice(0, 10) > tasks.capturedOn
      ) {
        throw new Error("과제 제출 시각을 확인해 주세요.");
      }

      if (task.reviewStatus === "approved") {
        approvedCount += 1;
      } else if (task.reviewStatus !== null) {
        throw new Error("과제 승인 상태를 확인해 주세요.");
      }
    }

    if (
      tasks.submittedCount !== tasks.items.length ||
      tasks.approvedCount !== approvedCount ||
      tasks.reviewUnknownCount !== (
        tasks.items.length - approvedCount
      )
    ) {
      throw new Error("과제 목록과 집계 숫자가 다릅니다.");
    }
  }

  // ========================================
  // 안전한 텍스트 표시
  // ========================================

  function setElementText(id, value) {
    const element = document.getElementById(id);

    if (element) {
      element.textContent = String(value);
    }
  }

  function replaceSourceRows(element, rows) {
    if (!element) {
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const [label, value] of rows) {
      const term = document.createElement("dt");
      const description = document.createElement("dd");

      term.textContent = label;
      description.textContent = value;

      fragment.append(term, description);
    }

    element.replaceChildren(fragment);
  }

  // ========================================
  // 출석·제출·승인 표시
  // ========================================

  function renderAttendanceAndTasks(attendance, tasks) {
    const summary = attendance.summary;

    setElementText(
      "metric-attendance-rate",
      summary.displayedAttendanceRate
    );

    setElementText(
      "attendance-description",
      (
        `출석 ${summary.presentDays}일 · ` +
        `재적 ${summary.enrolledDays}일 · ` +
        `미확정 ${summary.pendingDays}일`
      )
    );

    setElementText(
      "metric-submitted-count",
      tasks.submittedCount
    );

    setElementText(
      "submission-description",
      tasks.scope
    );

    setElementText(
      "metric-approved-count",
      tasks.approvedCount
    );

    setElementText(
      "approval-description",
      (
        `${tasks.capturedOn} 본인 확인 기준 · ` +
        `승인 상태 미확인 ${tasks.reviewUnknownCount}건`
      )
    );

    const pendingDescription = summary.pendingDays > 0
      ? (
          `미확정 ${summary.pendingDays}일` +
          `(${attendance.pendingDates.join(", ")})을 포함합니다.`
        )
      : "미확정 날짜가 없습니다.";

    setElementText(
      "attendance-pending-note",
      (
        `출석은 ${attendance.capturedOn} 조회 기준입니다. ` +
        `${pendingDescription} ` +
        "출석률은 원천 화면 표시값이며, " +
        "과제 승인은 본인 확인 기준입니다."
      )
    );

    const rows = [
      [
        "출석 출처",
        (
          `${attendance.source} · ` +
          `${attendance.sourceFile} · ` +
          `${attendance.capturedOn} 조회`
        ),
      ],

      [
        "출석 기간",
        (
          `${attendance.period.startDate}–` +
          `${attendance.period.endDate} · ` +
          attendance.period.scope
        ),
      ],

      [
        "출석 집계",
        (
          `훈련일 ${summary.trainingDays}일 · ` +
          `재적일 ${summary.enrolledDays}일 · ` +
          `출석 ${summary.presentDays}일 · ` +
          `결석 ${summary.absentDays}일 · ` +
          `미확정 ${summary.pendingDays}일`
        ),
      ],

      [
        "출석률",
        (
          `${summary.displayedAttendanceRate}% · ` +
          attendance.rateBasis
        ),
      ],

      [
        "미확정 날짜",
        attendance.pendingDates.length > 0
          ? attendance.pendingDates.join(", ")
          : "없음",
      ],

      [
        "제출 출처",
        `${tasks.source} · ${tasks.capturedOn} 확인`,
      ],

      [
        "제출·승인 집계",
        (
          `제출 ${tasks.submittedCount}건 · ` +
          `승인 ${tasks.approvedCount}건 · ` +
          `승인 상태 미확인 ${tasks.reviewUnknownCount}건`
        ),
      ],

      [
        "승인 근거",
        tasks.approvalBasis,
      ],
    ];

    if (Array.isArray(attendance.notes)) {
      for (const note of attendance.notes) {
        if (isText(note, 1000)) {
          rows.push(["출석 안내", note]);
        }
      }
    }

    if (Array.isArray(tasks.notes)) {
      for (const note of tasks.notes) {
        if (isText(note, 1000)) {
          rows.push(["과제 안내", note]);
        }
      }
    }

    replaceSourceRows(
      document.getElementById(
        "attendance-task-source-list"
      ),
      rows
    );

    const list = document.getElementById(
      "task-evidence-list"
    );

    if (list) {
      const fragment = document.createDocumentFragment();

      const orderedTasks = [...tasks.items].sort(
        (a, b) => a.id.localeCompare(b.id)
      );

      for (const task of orderedTasks) {
        const item = document.createElement("li");

        const state = task.reviewStatus === "approved"
          ? "승인 확인"
          : "승인 상태 미확인";

        const submittedAt = task.submittedAt
          .replace("T", " ")
          .replace("+09:00", " KST");

        item.textContent = (
          `${task.id} · ${task.title} / ` +
          `${submittedAt} 제출 / ${state} / ` +
          `출처: ${task.sourceFile}`
        );

        fragment.append(item);
      }

      list.replaceChildren(fragment);
    }
  }

  function validateData(data) {
    if (
      !isObject(data) ||
      data.schemaVersion !== 1 ||
      data.approved !== true
    ) {
      throw new Error("승인된 데이터 형식이 아닙니다.");
    }

    validateMetrics(data.metrics);
    validateAttendance(data.attendance);
    validateTasks(data.tasks);

    if (data.paragraphs !== undefined) {
      validateParagraphs(data.paragraphs);
    }

    if (data.links !== undefined) {
      if (!isObject(data.links)) {
        throw new Error("공개 링크 목록을 확인해 주세요.");
      }

      for (const key of ["paper", "resume", "contact"]) {
        const link = data.links[key];

        if (link === undefined || link === null) {
          continue;
        }

        if (
          !isObject(link) ||
          link.approved !== true ||
          !isText(link.label, 120)
        ) {
          throw new Error("승인된 링크 정보를 확인해 주세요.");
        }

        if (key === "contact") {
          if (!["email", "web"].includes(link.type)) {
            throw new Error("연락 수단의 종류를 확인해 주세요.");
          }

          readPublicUrl(link.url, link.type);
        } else {
          readPublicUrl(link.url);
        }
      }
    }
  }

  // ========================================
  // 숫자와 출처 표시
  // ========================================

  function renderMetrics(metrics) {
    const actionCount = (
      metrics.practiced + metrics.partial
    );

    const rate = metrics.closeCount > 0
      ? Math.round(
          actionCount / metrics.closeCount * 1000
        ) / 10
      : null;

    document.getElementById(
      "metric-record-days"
    ).textContent = String(metrics.recordDays);

    document.getElementById(
      "metric-close-count"
    ).textContent = String(metrics.closeCount);

    const rateElement = document.getElementById(
      "metric-action-rate"
    );

    rateElement.textContent = rate === null
      ? "—"
      : String(rate);

    const rateUnit = rateElement
      .closest(".metric-value")
      ?.querySelector(".metric-unit");

    if (rateUnit) {
      rateUnit.hidden = rate === null;
    }

    const descriptions = document.querySelectorAll(
      ".metric-description"
    );

    if (descriptions[2]) {
      descriptions[2].textContent = metrics.closeCount > 0
        ? (
            `마무리 ${metrics.closeCount}건 중 ` +
            `실천 ${metrics.practiced}건과 ` +
            `일부 실천 ${metrics.partial}건`
          )
        : "마무리 기록이 없어 비율을 계산하지 않았습니다.";
    }

    const sourceList = document.querySelector(
      "#record-sources .source-list"
    );

    const rows = [
      ["출처", metrics.source],

      [
        "기간",
        `${metrics.startDate}–${metrics.endDate}`,
      ],

      [
        "기록 날짜",
        (
          `내용이 있는 고유 날짜 ${metrics.recordDays}일. ` +
          `아침 ${metrics.openCount}건, ` +
          `마무리 ${metrics.closeCount}건입니다.`
        ),
      ],

      [
        "마무리 분류",
        (
          `실천 ${metrics.practiced}건, ` +
          `일부 실천 ${metrics.partial}건, ` +
          `미실천 ${metrics.notPracticed}건입니다.`
        ),
      ],

      [
        "비율 계산",
        rate === null
          ? "마무리 기록이 없어 계산하지 않았습니다."
          : (
              `(${metrics.practiced} + ${metrics.partial}) ` +
              `÷ ${metrics.closeCount} × 100 = ${rate}%. ` +
              "소수 첫째 자리까지 반올림했습니다."
            ),
      ],

      [
        "해석 범위",
        (
          "강점 행동에 대한 자기보고입니다. " +
          "출석률, 전체 과제 완료율, 작업 시간이나 " +
          "객관적인 능력 점수가 아닙니다."
        ),
      ],

      [
        "집계 범위",
        (
          "위 기간에 원자료로 제공된 리추얼만 셌습니다. " +
          "마무리가 없는 날짜는 미실천으로 처리하지 않았으며, " +
          "출석·제출 현황은 이 숫자에 포함하지 않았습니다."
        ),
      ],
    ];

    if (sourceList) {
      const fragment = document.createDocumentFragment();

      for (const [title, description] of rows) {
        const term = document.createElement("dt");
        const detail = document.createElement("dd");

        term.textContent = title;
        detail.textContent = description;

        fragment.append(term, detail);
      }

      sourceList.replaceChildren(fragment);
    }
  }

  // ========================================
  // 승인 문단 표시
  // 기존 본편은 자동으로 덮어쓰지 않습니다.
  // ========================================

  function renderParagraphs(paragraphs = []) {
    if (paragraphs.length === 0) {
      return;
    }

    const storyBody = document.querySelector(
      ".story-body"
    );

    if (!storyBody) {
      return;
    }

    const details = document.createElement("details");
    details.className = "source-details";
    details.id = "approved-record-paragraphs";

    const summary = document.createElement("summary");
    summary.textContent = "새 기록에서 승인한 장면 보기";

    const content = document.createElement("div");
    content.className = "details-body";

    const list = document.createElement("dl");
    list.className = "source-list";

    for (const paragraph of paragraphs) {
      const title = document.createElement("dt");

      title.textContent = (
        `${paragraph.date} · ${paragraph.ability}`
      );

      const description = document.createElement("dd");
      const text = document.createElement("p");
      const evidence = document.createElement("p");

      text.textContent = paragraph.text;

      evidence.className = "evidence-footnote";
      evidence.textContent = `근거: ${paragraph.evidence}`;

      description.append(text, evidence);
      list.append(title, description);
    }

    content.append(list);
    details.append(summary, content);

    const previous = document.getElementById(
      "approved-record-paragraphs"
    );

    if (previous) {
      previous.replaceWith(details);
    } else {
      storyBody.append(details);
    }
  }

  // ========================================
  // 공개 링크 연결
  // 문자열을 HTML로 실행하지 않습니다.
  // ========================================

  function renderLink(targetId, config, options = {}) {
    if (!config) {
      return;
    }

    const target = document.getElementById(targetId);

    if (!target) {
      return;
    }

    const link = document.createElement("a");

    link.className = options.className || "inline-link";
    link.textContent = config.label;

    link.href = readPublicUrl(
      config.url,
      options.contact ? config.type : "web"
    );

    if (options.download) {
      link.setAttribute("download", "");
    }

    target.replaceChildren(link);
  }

  function renderLinks(links = {}) {
    renderLink(
      "paper-availability",
      links.paper,
      { className: "inline-link" }
    );

    renderLink(
      "resume-availability",
      links.resume,
      {
        className: "inline-link",
        download: true,
      }
    );

    renderLink(
      "contact-availability",
      links.contact,
      {
        className: "inline-link",
        contact: true,
      }
    );
  }

  // ========================================
  // 승인 파일 불러오기
  // ========================================

  async function loadApprovedData() {
    // HTML 파일을 직접 열었을 때의 요청 실패를 피합니다.
    if (window.location.protocol === "file:") {
      setStatus(
        "HTML의 기본 기록을 표시합니다. 승인 데이터 연결은 로컬 서버나 배포 화면에서 확인해 주세요."
      );

      return;
    }

    const controller = new AbortController();

    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, 6000);

    try {
      const response = await fetch(DATA_URL, {
        signal: controller.signal,
        cache: "no-cache",
        credentials: "omit",
        headers: {
          Accept: "application/json",
        },
      });

      if (response.status === 404) {
        setStatus(
          "2026년 10월 15일 기준 기본 기록을 표시합니다. 승인 데이터 파일은 아직 연결되지 않았습니다."
        );

        return;
      }

      if (!response.ok) {
        throw new Error("승인 데이터를 불러오지 못했습니다.");
      }

      const data = await response.json();

      // 모든 항목을 먼저 검증한 뒤 화면에 반영합니다.
      validateData(data);

      renderMetrics(data.metrics);

      renderAttendanceAndTasks(
        data.attendance,
        data.tasks
      );

      renderParagraphs(data.paragraphs);
      renderLinks(data.links);

      setStatus(
        (
          `승인 데이터 반영 완료 · ` +
          `리추얼 ${data.metrics.startDate}–${data.metrics.endDate} · ` +
          `출석 ${data.attendance.capturedOn} 조회 · ` +
          `과제 상태 ${data.tasks.capturedOn} 확인`
        )
      );
    } catch (error) {
      if (error.name === "AbortError") {
        setStatus(
          "승인 데이터 응답이 늦어 HTML의 기본 기록을 유지합니다. 잠시 후 새로고침해 주세요."
        );
      } else {
        setStatus(
          "승인 데이터를 확인하지 못해 HTML의 기본 기록을 유지합니다. 데이터 파일의 형식과 연결 상태를 확인해 주세요."
        );
      }
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  // ========================================
  // 시작
  // ========================================

  setupReadingProgress();
  setupNavigation();
  setupReveal();

  void loadApprovedData();
})();