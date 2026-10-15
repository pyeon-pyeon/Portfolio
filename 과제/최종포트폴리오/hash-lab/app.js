"use strict";

(() => {
  // ========================================
  // 기본 설정
  // ========================================

  const $ = (id) => document.getElementById(id);

  const ALGORITHM_NAMES = {
    salted_sha256: "salted SHA-256",
    bcrypt: "bcrypt",
    argon2id: "Argon2id",
  };

  // 기존 논문 결과입니다.
  // 앱에서 새로 측정한 결과와 구분합니다.
  const PAPER = Object.freeze({
    title: (
      "Salt만으로 충분한가? " +
      "SHA-256과 bcrypt의 비밀번호 후보 검증 비용 비교"
    ),
    measuredOn: "2026-10-14",
    candidateCount: 32,
    bcryptCost: 12,
    timeRatio: 249356.63,
    environment: "Windows 11 · Python 3.14.7 · bcrypt 5.0.0",
  });

  const numberFormat = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 2,
  });

  let worker = null;
  let ready = false;
  let active = null;
  let requestCounter = 0;

  let bootTimer = null;
  let requestTimer = null;

  let latestResult = null;

  // ========================================
  // 공통 화면 처리
  // ========================================

  function setText(id, text) {
    const element = $(id);

    if (element) {
      element.textContent = text;
    }
  }

  function formatNumber(value) {
    return numberFormat.format(value);
  }

  function formatDuration(milliseconds) {
    if (milliseconds < 0.001) {
      return `${formatNumber(milliseconds * 1000000)} ns`;
    }

    if (milliseconds < 1) {
      return `${formatNumber(milliseconds * 1000)} μs`;
    }

    if (milliseconds < 1000) {
      return `${formatNumber(milliseconds)} ms`;
    }

    return `${formatNumber(milliseconds / 1000)} s`;
  }

  function setProgress(percent, label) {
    const value = Math.min(
      100,
      Math.max(0, Number(percent) || 0)
    );

    $("benchmark-progress").value = value;

    setText(
      "benchmark-progress-label",
      label || `${Math.round(value)}%`
    );
  }

  function syncControls() {
    const busy = active !== null;

    $("salt-run-button").disabled = !ready || busy;
    $("benchmark-run-button").disabled = !ready || busy;

    $("benchmark-cancel-button").disabled = (
      !busy || active.kind !== "benchmark"
    );

    $("download-result-button").disabled = (
      busy || latestResult === null
    );

    for (const select of document.querySelectorAll(
      "#salt-form select, #benchmark-form select"
    )) {
      select.disabled = !ready || busy;
    }

    $("execution-panel").setAttribute(
      "aria-busy",
      String(busy && active.kind === "benchmark")
    );

    $("salt-form").setAttribute(
      "aria-busy",
      String(busy && active.kind === "salt")
    );
  }

  function hideError() {
    $("benchmark-error").hidden = true;
    setText("benchmark-error-message", "");
  }

  function showError(message) {
    setText("benchmark-error-message", message);
    $("benchmark-error").hidden = false;
  }

  function stopTimers() {
    window.clearTimeout(bootTimer);
    window.clearTimeout(requestTimer);

    bootTimer = null;
    requestTimer = null;
  }

  function finishRequest() {
    window.clearTimeout(requestTimer);
    requestTimer = null;

    active = null;
    syncControls();
  }

  function terminateWorker() {
    stopTimers();

    if (worker) {
      worker.terminate();
      worker = null;
    }

    ready = false;
  }

  // ========================================
  // 결과 표시 초기화
  // ========================================

  function clearBenchmarkResult() {
    latestResult = null;

    const fragment = document.createDocumentFragment();

    for (const name of Object.values(ALGORITHM_NAMES)) {
      const row = document.createElement("tr");

      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = name;

      row.append(heading);

      for (let i = 0; i < 4; i += 1) {
        const cell = document.createElement("td");
        cell.textContent = "—";
        row.append(cell);
      }

      fragment.append(row);
    }

    $("benchmark-table-body").replaceChildren(fragment);

    const oldChart = $("cost-chart");

    if (oldChart) {
      oldChart.remove();
    }

    setText(
      "benchmark-interpretation",
      "측정이 끝나면 설정과 결과를 표시합니다."
    );

    setText(
      "research-comparison",
      (
        "이번 측정은 아직 완료되지 않았습니다."
      )
    );

    syncControls();
  }

  // ========================================
  // Worker 준비
  // ========================================

  function failWorker(message) {
    const kind = active?.kind;

    terminateWorker();
    active = null;

    setText("module-status", message);

    if (kind === "salt") {
      setText("salt-status", message);
    } else if (kind === "benchmark") {
      setText("benchmark-state", "오류");
      setText(
        "benchmark-status",
        "측정을 완료하지 못했습니다."
      );
      showError(message);
    } else {
      setText("salt-status", message);
      setText("benchmark-state", "준비 실패");
      setText("benchmark-status", message);
    }

    syncControls();
  }

  function initializeWorker() {
    terminateWorker();

    if (
      window.location.protocol === "file:"
    ) {
      failWorker(
        "HTML 파일 직접 열기 대신 로컬 서버나 HTTPS 배포 주소에서 실행해 주세요."
      );
      return;
    }

    if (
      !window.isSecureContext ||
      !("Worker" in window) ||
      !("WebAssembly" in window) ||
      !window.crypto?.getRandomValues
    ) {
      failWorker(
        "HTTPS 또는 localhost와 Web Worker·WebAssembly를 지원하는 브라우저가 필요합니다."
      );
      return;
    }

    setText(
      "module-status",
      "로컬 계산 모듈과 SHA-256 기본 검사를 준비합니다."
    );

    syncControls();

    let currentWorker;

    try {
      currentWorker = new Worker(
        "./hash-worker.js"
      );

      worker = currentWorker;
    } catch {
      failWorker(
        "계산 Worker를 만들지 못했습니다. 파일 경로와 브라우저 설정을 확인해 주세요."
      );
      return;
    }

    bootTimer = window.setTimeout(() => {
      if (worker === currentWorker && !ready) {
        failWorker(
          "계산 모듈 준비 시간이 초과됐습니다. vendor 파일을 확인하고 새로고침해 주세요."
        );
      }
    }, 15000);

    currentWorker.addEventListener(
      "message",
      (event) => {
        if (worker !== currentWorker) {
          return;
        }

        handleWorkerMessage(event.data);
      }
    );

    currentWorker.addEventListener(
      "error",
      (event) => {
        event.preventDefault();

        if (worker !== currentWorker) {
          return;
        }

        failWorker(
          "계산 모듈을 실행하지 못했습니다. hash-worker.js와 vendor 파일을 확인해 주세요."
        );
      }
    );

    currentWorker.addEventListener(
      "messageerror",
      () => {
        if (worker !== currentWorker) {
          return;
        }

        failWorker(
          "계산 결과를 전달받지 못했습니다. 페이지를 새로고침해 주세요."
        );
      }
    );
  }

  // ========================================
  // 요청 보내기
  // ========================================

  function startRequest(kind, payload) {
    if (!ready || !worker || active) {
      return;
    }

    requestCounter += 1;

    active = {
      kind,
      requestId: requestCounter,
    };

    syncControls();

    const currentId = active.requestId;

    requestTimer = window.setTimeout(() => {
      if (active?.requestId !== currentId) {
        return;
      }

      failWorker(
        "응답 제한 시간을 넘었습니다. 새로고침 후 후보 수나 비용을 낮춰 주세요."
      );
    }, kind === "benchmark" ? 120000 : 15000);

    try {
      worker.postMessage({
        type: kind,
        requestId: currentId,
        ...payload,
      });
    } catch {
      failWorker(
        "계산 요청을 보내지 못했습니다. 페이지를 새로고침해 주세요."
      );
    }
  }

  // ========================================
  // Worker 메시지 처리
  // ========================================

  function handleWorkerMessage(data) {
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.type === "ready") {
      window.clearTimeout(bootTimer);
      bootTimer = null;

      ready = true;

      setText(
        "module-status",
        `hash-wasm ${data.libraryVersion} · 기본 검사 완료 · 브라우저 내부 계산`
      );

      setText(
        "salt-status",
        "가상 문자열을 선택하고 계산 버튼을 눌러 주세요."
      );

      // 취소 직후에는 취소 상태를 유지합니다.
      if ($("benchmark-state").textContent !== "취소됨") {
        setText("benchmark-state", "준비 완료");
        setText(
          "benchmark-status",
          "설정을 선택하고 세 방식 비교를 실행해 주세요."
        );
      }

      syncControls();
      return;
    }

    if (data.type === "boot-error") {
      failWorker(
        data.message || "계산 모듈을 준비하지 못했습니다."
      );
      return;
    }

    // 취소했거나 이전 실행에서 온 메시지는 반영하지 않습니다.
    if (
      !active ||
      data.requestId !== active.requestId
    ) {
      return;
    }

    if (data.type === "progress") {
      if (active.kind === "benchmark") {
        setProgress(data.percent);
        setText("benchmark-status", data.message);
      }

      return;
    }

    if (data.type === "error") {
      const kind = active.kind;

      finishRequest();

      const message = data.message || (
        "계산 중 오류가 발생했습니다."
      );

      if (kind === "salt") {
        setText("salt-status", message);
      } else {
        setText("benchmark-state", "오류");
        setText(
          "benchmark-status",
          "이번 실행은 완료되지 않았습니다."
        );
        showError(message);
      }

      return;
    }

    if (data.type !== "result") {
      return;
    }

    const kind = active.kind;

    try {
      if (data.kind !== kind) {
        throw new Error("결과 종류가 요청과 다릅니다.");
      }

      if (kind === "salt") {
        renderSalt(data.result);
      } else {
        validateBenchmarkResult(data.result);

        renderBenchmark(data.result);

        latestResult = {
          ...data.result,
          measuredAt: new Date().toISOString(),
          researchReference: PAPER,
        };

        setText("benchmark-state", "측정 완료");

        setText(
          "benchmark-status",
          "세 방식의 결과를 표시했습니다. 설정과 해석 범위를 함께 확인해 주세요."
        );

        setProgress(100, "완료 · 100%");
      }
    } catch {
      if (kind === "salt") {
        setText(
          "salt-status",
          "계산 결과 형식을 확인하지 못했습니다. 다시 실행해 주세요."
        );
      } else {
        latestResult = null;

        setText("benchmark-state", "결과 확인 실패");

        showError(
          "측정 결과가 예상 형식과 달라 완료 결과로 저장하지 않았습니다."
        );
      }
    } finally {
      finishRequest();
    }
  }

  // ========================================
  // Salt 결과 표시
  // ========================================

  function renderSalt(result) {
    const valid = (
      result &&
      typeof result.sample === "string" &&
      /^[0-9a-f]{32}$/.test(result.saltA) &&
      /^[0-9a-f]{32}$/.test(result.saltB) &&
      /^[0-9a-f]{64}$/.test(result.hashA) &&
      /^[0-9a-f]{64}$/.test(result.hashB)
    );

    if (!valid) {
      throw new Error("Salt 결과 형식 오류");
    }

    setText("salt-a-value", result.saltA);
    setText("salt-b-value", result.saltB);
    setText("hash-a-value", result.hashA);
    setText("hash-b-value", result.hashB);

    const different = (
      result.saltA !== result.saltB &&
      result.hashA !== result.hashB
    );

    setText(
      "salt-verdict",
      different
        ? (
            "같은 가상 문자열에 서로 다른 salt를 적용해 " +
            "다른 저장값이 생성됐습니다."
          )
        : (
            "예상한 차이를 확인하지 못했습니다. " +
            "다시 계산해 주세요."
          )
    );

    setText(
      "salt-status",
      `계산 완료 · 가상 문자열: ${result.sample}`
    );
  }

  // ========================================
  // 측정 결과 검증
  // ========================================

  function validateBenchmarkResult(result) {
    if (
      !result ||
      !result.settings ||
      !Array.isArray(result.measurements) ||
      result.measurements.length !== 3
    ) {
      throw new Error("측정 결과 형식 오류");
    }

    const expected = Object.keys(ALGORITHM_NAMES);
    const seen = new Set();

    for (const row of result.measurements) {
      if (
        !row ||
        !expected.includes(row.algorithm) ||
        seen.has(row.algorithm) ||
        !Number.isSafeInteger(row.checks) ||
        row.checks <= 0 ||
        !Number.isFinite(row.elapsedMs) ||
        row.elapsedMs <= 0 ||
        !Number.isFinite(row.perCandidateMs) ||
        row.perCandidateMs <= 0 ||
        !Number.isFinite(row.checksPerSecond) ||
        row.checksPerSecond <= 0 ||
        !Number.isSafeInteger(row.matches) ||
        !Number.isSafeInteger(row.expectedMatches) ||
        row.expectedMatches < 1 ||
        row.matches !== row.expectedMatches
      ) {
        throw new Error("측정값 검증 실패");
      }

      const expectedTime = row.elapsedMs / row.checks;

      if (
        Math.abs(expectedTime - row.perCandidateMs) >
        Math.max(1e-9, expectedTime * 1e-9)
      ) {
        throw new Error("측정 계산식 불일치");
      }

      seen.add(row.algorithm);
    }
  }

  // ========================================
  // 측정 표와 해석
  // ========================================

  function renderBenchmark(result) {
    const rows = result.measurements;
    const fragment = document.createDocumentFragment();

    for (const measurement of rows) {
      const row = document.createElement("tr");

      const heading = document.createElement("th");
      heading.scope = "row";

      heading.textContent = (
        ALGORITHM_NAMES[measurement.algorithm]
      );

      row.append(heading);

      const values = [
        formatNumber(measurement.checks),
        formatDuration(measurement.elapsedMs),
        formatDuration(measurement.perCandidateMs),
        formatNumber(measurement.checksPerSecond),
      ];

      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }

      fragment.append(row);
    }

    $("benchmark-table-body").replaceChildren(fragment);

    renderChart(rows);

    const sha = rows.find(
      (row) => row.algorithm === "salted_sha256"
    );

    const bcrypt = rows.find(
      (row) => row.algorithm === "bcrypt"
    );

    const argon = rows.find(
      (row) => row.algorithm === "argon2id"
    );

    const bcryptRatio = (
      bcrypt.perCandidateMs / sha.perCandidateMs
    );

    const argonRatio = (
      argon.perCandidateMs / sha.perCandidateMs
    );

    setText(
      "benchmark-interpretation",
      [
        (
          `이번 실행의 후보당 시간 비율은 ` +
          `bcrypt / SHA-256 약 ${formatNumber(bcryptRatio)}배, ` +
          `Argon2id / SHA-256 약 ${formatNumber(argonRatio)}배입니다.`
        ),
        (
          `bcrypt cost ${result.settings.bcryptCost}, ` +
          `Argon2id 메모리 ${result.settings.argonMemory / 1024} MiB · ` +
          `반복 ${result.settings.argonIterations} · 병렬도 1로 측정했습니다.`
        ),
        (
          "시간 비율은 이번 환경의 측정값이며, " +
          "방식별 안전성 순위나 실제 해독 시간을 뜻하지 않습니다."
        ),
      ].join("\n\n")
    );

    setText(
      "research-comparison",
      [
        (
          `기존 논문: 가상 후보 ${PAPER.candidateCount}개, ` +
          `bcrypt cost ${PAPER.bcryptCost}, ` +
          `방식별 독립 측정 10회, 평균 시간 비율 약 ` +
          `${formatNumber(PAPER.timeRatio)}배.`
        ),
        (
          `이번 앱: 가상 후보 ${result.settings.candidateCount}개, ` +
          `bcrypt cost ${result.settings.bcryptCost}, ` +
          "브라우저 WebAssembly에서 한 번 실행한 체험 측정입니다."
        ),
        (
          "Argon2id는 앱에서 추가한 실험입니다. " +
          "SHA-256 목록 반복은 논문의 독립적인 10회 측정과 다릅니다. " +
          "기기·구현·측정 절차가 달라 숫자의 일치 여부로 통과를 판단하지 않습니다."
        ),
      ].join("\n\n")
    );
  }

  // ========================================
  // 후보당 시간 비교 그래프
  // 실제 값에 비례하는 선형 눈금을 사용합니다.
  // ========================================

  function renderChart(rows) {
    const oldChart = $("cost-chart");

    if (oldChart) {
      oldChart.remove();
    }

    const chart = document.createElement("section");
    chart.id = "cost-chart";
    chart.className = "cost-chart";
    chart.setAttribute(
      "aria-labelledby",
      "cost-chart-title"
    );

    const title = document.createElement("h3");
    title.id = "cost-chart-title";
    title.textContent = "후보당 검증 시간";

    const note = document.createElement("p");
    note.className = "field-help";

    note.textContent = (
      "선형 눈금입니다. 차이가 크면 짧은 막대가 거의 보이지 않을 수 있습니다. " +
      "정확한 값은 표와 숫자를 확인해 주세요."
    );

    chart.append(title, note);

    const maximum = Math.max(
      ...rows.map((row) => row.perCandidateMs)
    );

    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "cost-chart-row";

      const label = document.createElement("label");
      const meter = document.createElement("meter");
      const value = document.createElement("span");

      meter.id = `cost-meter-${row.algorithm}`;
      meter.min = 0;
      meter.max = maximum;
      meter.value = row.perCandidateMs;

      label.htmlFor = meter.id;
      label.textContent = ALGORITHM_NAMES[row.algorithm];

      meter.textContent = formatDuration(
        row.perCandidateMs
      );

      value.textContent = formatDuration(
        row.perCandidateMs
      );

      item.append(label, meter, value);
      chart.append(item);
    }

    document.querySelector(".result-toolbar").before(chart);
  }

  // ========================================
  // 실습 실행
  // ========================================

  $("salt-form").addEventListener("submit", (event) => {
    event.preventDefault();

    if (!ready || active) {
      return;
    }

    setText("salt-status", "서로 다른 salt로 계산 중입니다.");

    startRequest("salt", {
      sample: $("sample-password").value,
    });
  });

  $("benchmark-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();

      if (!ready || active) {
        return;
      }

      hideError();
      clearBenchmarkResult();

      setText("benchmark-state", "측정 중");

      setText(
        "benchmark-status",
        "가상 후보와 목표 해시를 준비합니다."
      );

      setProgress(0, "시작 · 0%");

      startRequest("benchmark", {
        settings: {
          candidateCount: Number(
            $("candidate-count").value
          ),
          bcryptCost: Number(
            $("bcrypt-cost").value
          ),
          argonMemory: Number(
            $("argon-memory").value
          ),
          argonIterations: Number(
            $("argon-iterations").value
          ),
        },
      });
    }
  );

  // ========================================
  // 취소
  // ========================================

  $("benchmark-cancel-button").addEventListener(
    "click",
    () => {
      if (active?.kind !== "benchmark") {
        return;
      }

      terminateWorker();
      active = null;

      clearBenchmarkResult();
      hideError();

      setText("benchmark-state", "취소됨");

      setText(
        "benchmark-status",
        "계산을 중단했습니다. 미완료 결과는 저장하지 않았습니다."
      );

      setProgress(0, "취소됨");

      initializeWorker();
    }
  );

  // ========================================
  // JSON 내려받기
  // ========================================

  $("download-result-button").addEventListener(
    "click",
    () => {
      if (!latestResult || active) {
        return;
      }

      const content = JSON.stringify(
        latestResult,
        null,
        2
      );

      const blob = new Blob(
        [content + "\n"],
        { type: "application/json;charset=utf-8" }
      );

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;

      link.download = (
        `hash-lab-result-${latestResult.measuredAt
          .replace(/[:.]/g, "-")}.json`
      );

      document.body.append(link);
      link.click();
      link.remove();

      window.setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }
  );

  // ========================================
  // 시작
  // ========================================

  hideError();
  initializeWorker();
})();