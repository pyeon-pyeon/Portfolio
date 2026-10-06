"use strict";

(() => {
  // ============================================================
  // 기본 설정
  // ============================================================
  const COLS = 10;
  const ROWS = 20;
  const START_SECONDS = 30;
  const SURVIVAL_POINTS_PER_SECOND = 10;

  const ALLOWED_INTERVALS = [700, 900];
  const TIME_BONUS = [0, 1, 2, 5, 5];
  const LINE_SCORE = [0, 100, 300, 500, 800];

  const STORAGE_KEY = "tetris-30s-v1";

  // ============================================================
  // HTML 요소
  // ============================================================
  const canvas = document.getElementById("game-board");
  const context = canvas.getContext("2d");

  const stateElement = document.getElementById("game-state");
  const timeElement = document.getElementById("time-left");
  const scoreElement = document.getElementById("score");
  const linesElement = document.getElementById("lines-cleared");

  const startButton = document.getElementById("start-button");
  const pauseButton = document.getElementById("pause-button");
  const restartButton = document.getElementById("restart-button");

  const controlButtons = document.querySelectorAll("[data-action]");
  const messageElement = document.getElementById("game-message");

  const resultPanel = document.getElementById("result-panel");
  const endReasonElement = document.getElementById("end-reason");
  const finalScoreElement = document.getElementById("final-score");
  const survivalElement = document.getElementById("survival-time");
  const finalLinesElement = document.getElementById("final-lines");

  const bestScoreElement = document.getElementById("best-score");
  const difficultySelect = document.getElementById("difficulty");
  const soundCheckbox = document.getElementById("sound-enabled");
  const resetRecordsButton = document.getElementById(
    "reset-records-button"
  );
  const storageMessage = document.getElementById("storage-message");
  const recordsBody = document.getElementById("records-body");

  if (!context) {
    stateElement.textContent = "실행 불가";
    messageElement.textContent =
      "이 브라우저에서는 게임을 실행할 수 없습니다.";
    startButton.disabled = true;
    return;
  }

  const CELL_WIDTH = canvas.width / COLS;
  const CELL_HEIGHT = canvas.height / ROWS;

  // ============================================================
  // 블록 종류
  // ============================================================
  const PIECES = [
    {
      name: "I",
      color: "#64d8f3",
      matrix: [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    },
    {
      name: "O",
      color: "#f8d76a",
      matrix: [
        [1, 1],
        [1, 1],
      ],
    },
    {
      name: "T",
      color: "#c49bff",
      matrix: [
        [0, 1, 0],
        [1, 1, 1],
        [0, 0, 0],
      ],
    },
    {
      name: "S",
      color: "#7bdf9b",
      matrix: [
        [0, 1, 1],
        [1, 1, 0],
        [0, 0, 0],
      ],
    },
    {
      name: "Z",
      color: "#ff8791",
      matrix: [
        [1, 1, 0],
        [0, 1, 1],
        [0, 0, 0],
      ],
    },
    {
      name: "J",
      color: "#82aaff",
      matrix: [
        [1, 0, 0],
        [1, 1, 1],
        [0, 0, 0],
      ],
    },
    {
      name: "L",
      color: "#ffb86c",
      matrix: [
        [0, 0, 1],
        [1, 1, 1],
        [0, 0, 0],
      ],
    },
  ];

  // ============================================================
  // 현재 판 상태: 새 게임마다 초기화
  // ============================================================
  let board = createEmptyBoard();
  let currentPiece = null;
  let pieceBag = [];

  // ready / playing / paused / ended
  let gameState = "ready";

  let elapsedSeconds = 0;
  let earnedSeconds = 0;
  let linePoints = 0;
  let clearedLines = 0;

  let fallIntervalMs = 700;
  let previousTime = 0;
  let fallAccumulator = 0;
  let animationId = null;

  const pressedKeys = new Set();

  // ============================================================
  // 보존 데이터: 최고 점수·설정·최근 20회 기록
  // ============================================================
  function createDefaultData() {
    return {
      version: 1,
      bestScore: 0,
      interval: 700,
      soundEnabled: false,
      records: [],
    };
  }

  let savedData = createDefaultData();

  function isValidRecord(record) {
    return (
      record !== null &&
      typeof record === "object" &&
      ALLOWED_INTERVALS.includes(record.interval) &&
      Number.isSafeInteger(record.score) &&
      record.score >= 0 &&
      Number.isFinite(record.seconds) &&
      record.seconds >= 0 &&
      ["timeout", "topout"].includes(record.reason)
    );
  }

  function isValidData(data) {
    return (
      data !== null &&
      typeof data === "object" &&
      data.version === 1 &&
      Number.isSafeInteger(data.bestScore) &&
      data.bestScore >= 0 &&
      ALLOWED_INTERVALS.includes(data.interval) &&
      typeof data.soundEnabled === "boolean" &&
      Array.isArray(data.records) &&
      data.records.length <= 20 &&
      data.records.every(isValidRecord) &&
      data.records.every(
        (record) => record.score <= data.bestScore
      )
    );
  }

  function saveData() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(savedData)
      );
      return true;
    } catch {
      storageMessage.textContent =
        "저장할 수 없습니다. 이번 화면에서는 기록을 유지하지만 " +
        "새로고침하면 사라질 수 있습니다.";
      return false;
    }
  }

  function loadData() {
    let raw;

    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      savedData = createDefaultData();
      storageMessage.textContent =
        "저장소에 접근할 수 없어 기본값으로 시작합니다.";
      return;
    }

    if (raw === null) {
      savedData = createDefaultData();
      return;
    }

    try {
      const parsed = JSON.parse(raw);

      if (!isValidData(parsed)) {
        throw new Error("Invalid saved data");
      }

      savedData = {
        version: 1,
        bestScore: parsed.bestScore,
        interval: parsed.interval,
        soundEnabled: parsed.soundEnabled,
        records: parsed.records.map((record) => ({
          interval: record.interval,
          score: record.score,
          seconds: record.seconds,
          reason: record.reason,
        })),
      };
    } catch {
      savedData = createDefaultData();

      if (saveData()) {
        storageMessage.textContent =
          "저장값이 비어 있거나 손상되어 기본값으로 복구했습니다.";
      }
    }
  }

  function renderSavedData() {
    bestScoreElement.textContent = String(savedData.bestScore);
    difficultySelect.value = String(savedData.interval);
    soundCheckbox.checked = savedData.soundEnabled;

    recordsBody.replaceChildren();

    if (savedData.records.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = 5;
      cell.textContent = "아직 종료한 판의 기록이 없습니다.";

      row.append(cell);
      recordsBody.append(row);
      return;
    }

    savedData.records.forEach((record, index) => {
      const row = document.createElement("tr");

      const values = [
        String(index + 1),
        `${record.interval}ms`,
        String(record.score),
        `${record.seconds.toFixed(1)}초`,
        record.reason === "timeout"
          ? "시간 소진"
          : "블록 쌓임",
      ];

      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });

      recordsBody.append(row);
    });
  }

  function recordFinishedGame(reasonCode) {
    const score = getScore();

    savedData.bestScore = Math.max(savedData.bestScore, score);

    savedData.records.push({
      interval: fallIntervalMs,
      score,
      seconds: Number(elapsedSeconds.toFixed(1)),
      reason: reasonCode,
    });

    savedData.records = savedData.records.slice(-20);

    saveData();
    renderSavedData();
  }

  // ============================================================
  // 효과음
  // ============================================================
  let audioContext = null;
  const activeTones = new Set();

  function prepareAudio() {
    if (!savedData.soundEnabled) {
      return;
    }

    try {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) {
        return;
      }

      if (!audioContext) {
        audioContext = new AudioContextClass();
      }

      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {
          // 효과음이 제한돼도 게임은 계속 실행
        });
      }
    } catch {
      // 효과음 사용 불가 시 게임은 계속 실행
    }
  }

  function stopSounds() {
    for (const oscillator of activeTones) {
      try {
        oscillator.stop();
      } catch {
        // 이미 종료한 소리는 무시
      }
    }

    activeTones.clear();
  }

  function playLineSound(removedCount) {
    if (
      !savedData.soundEnabled ||
      !audioContext ||
      audioContext.state !== "running"
    ) {
      return;
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      440 + removedCount * 110,
      now
    );

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      now + 0.14
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    activeTones.add(oscillator);

    oscillator.onended = () => {
      activeTones.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };

    oscillator.start(now);
    oscillator.stop(now + 0.15);
  }

  // ============================================================
  // 보드·시간·점수
  // ============================================================
  function createEmptyBoard() {
    return Array.from(
      { length: ROWS },
      () => Array(COLS).fill(null)
    );
  }

  function getRemainingSeconds() {
    return Math.max(
      0,
      START_SECONDS + earnedSeconds - elapsedSeconds
    );
  }

  function getScore() {
    return (
      Math.floor(elapsedSeconds) *
        SURVIVAL_POINTS_PER_SECOND +
      linePoints
    );
  }

  function updateStats() {
    timeElement.textContent =
      getRemainingSeconds().toFixed(1);
    scoreElement.textContent = String(getScore());
    linesElement.textContent = String(clearedLines);
  }

  function updateControls() {
    const playing = gameState === "playing";
    const paused = gameState === "paused";
    const roundActive = playing || paused;

    startButton.disabled = gameState !== "ready";
    restartButton.disabled = gameState === "ready";

    pauseButton.disabled = !roundActive;
    pauseButton.textContent = paused
      ? "계속하기"
      : "일시정지";

    controlButtons.forEach((button) => {
      button.disabled = !playing;
    });

    difficultySelect.disabled = roundActive;
    resetRecordsButton.disabled = roundActive;
  }

  // ============================================================
  // 블록 생성: 7종류를 섞어서 하나씩 사용
  // ============================================================
  function refillBag() {
    pieceBag = PIECES.map((_, index) => index);

    for (let i = pieceBag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));

      [pieceBag[i], pieceBag[j]] = [
        pieceBag[j],
        pieceBag[i],
      ];
    }
  }

  function spawnPiece() {
    if (pieceBag.length === 0) {
      refillBag();
    }

    const template = PIECES[pieceBag.pop()];

    currentPiece = {
      name: template.name,
      color: template.color,
      matrix: template.matrix.map((row) => [...row]),
      x: Math.floor(
        (COLS - template.matrix[0].length) / 2
      ),
      y: 0,
    };

    if (
      hasCollision(
        currentPiece.matrix,
        currentPiece.x,
        currentPiece.y
      )
    ) {
      finishGame(
        "새 블록을 놓을 공간이 없습니다.",
        "topout"
      );
    }
  }

  // ============================================================
  // 충돌 검사
  // ============================================================
  function hasCollision(matrix, positionX, positionY) {
    for (let row = 0; row < matrix.length; row += 1) {
      for (
        let col = 0;
        col < matrix[row].length;
        col += 1
      ) {
        if (matrix[row][col] === 0) {
          continue;
        }

        const x = positionX + col;
        const y = positionY + row;

        if (x < 0 || x >= COLS || y >= ROWS) {
          return true;
        }

        if (y >= 0 && board[y][x] !== null) {
          return true;
        }
      }
    }

    return false;
  }

  // ============================================================
  // 이동·회전·즉시 낙하
  // ============================================================
  function moveHorizontal(direction) {
    const nextX = currentPiece.x + direction;

    if (
      !hasCollision(
        currentPiece.matrix,
        nextX,
        currentPiece.y
      )
    ) {
      currentPiece.x = nextX;
    }
  }

  function rotateMatrix(matrix) {
    const size = matrix.length;

    return Array.from({ length: size }, (_, row) =>
      Array.from(
        { length: size },
        (_, col) => matrix[size - 1 - col][row]
      )
    );
  }

  function rotatePiece() {
    if (currentPiece.name === "O") {
      return;
    }

    const rotated = rotateMatrix(currentPiece.matrix);
    const offsets = [0, -1, 1, -2, 2];

    for (const offset of offsets) {
      const nextX = currentPiece.x + offset;

      if (
        !hasCollision(
          rotated,
          nextX,
          currentPiece.y
        )
      ) {
        currentPiece.matrix = rotated;
        currentPiece.x = nextX;
        return;
      }
    }
  }

  function moveDown() {
    const nextY = currentPiece.y + 1;

    if (
      !hasCollision(
        currentPiece.matrix,
        currentPiece.x,
        nextY
      )
    ) {
      currentPiece.y = nextY;
      return;
    }

    lockPiece();
  }

  function hardDrop() {
    while (
      !hasCollision(
        currentPiece.matrix,
        currentPiece.x,
        currentPiece.y + 1
      )
    ) {
      currentPiece.y += 1;
    }

    lockPiece();
  }

  // ============================================================
  // 블록 고정·줄 제거
  // ============================================================
  function lockPiece() {
    // 보드 위쪽을 넘은 블록이 있는지 먼저 확인
    for (
      let row = 0;
      row < currentPiece.matrix.length;
      row += 1
    ) {
      for (
        let col = 0;
        col < currentPiece.matrix[row].length;
        col += 1
      ) {
        if (
          currentPiece.matrix[row][col] !== 0 &&
          currentPiece.y + row < 0
        ) {
          finishGame(
            "블록이 보드 위쪽을 넘었습니다.",
            "topout"
          );
          return;
        }
      }
    }

    for (
      let row = 0;
      row < currentPiece.matrix.length;
      row += 1
    ) {
      for (
        let col = 0;
        col < currentPiece.matrix[row].length;
        col += 1
      ) {
        if (currentPiece.matrix[row][col] === 0) {
          continue;
        }

        const x = currentPiece.x + col;
        const y = currentPiece.y + row;

        board[y][x] = currentPiece.color;
      }
    }

    clearCompletedLines();

    fallAccumulator = 0;
    spawnPiece();
  }

  function clearCompletedLines() {
    const remainingRows = board.filter((row) =>
      row.some((cell) => cell === null)
    );

    const removedCount = ROWS - remainingRows.length;

    if (removedCount === 0) {
      return;
    }

    while (remainingRows.length < ROWS) {
      remainingRows.unshift(Array(COLS).fill(null));
    }

    board = remainingRows;

    const extraSeconds = TIME_BONUS[removedCount];
    const extraPoints = LINE_SCORE[removedCount];

    earnedSeconds += extraSeconds;
    linePoints += extraPoints;
    clearedLines += removedCount;

    playLineSound(removedCount);

    messageElement.textContent =
      `${removedCount}줄 제거! 시간 +${extraSeconds}초, ` +
      `점수 +${extraPoints}점`;
  }

  // ============================================================
  // 시간·자동 낙하
  // ============================================================
  function advanceClock(now) {
    if (gameState !== "playing") {
      return false;
    }

    const deltaMilliseconds = Math.max(
      0,
      now - previousTime
    );

    previousTime = now;

    const remainingMilliseconds =
      getRemainingSeconds() * 1000;

    if (deltaMilliseconds >= remainingMilliseconds) {
      elapsedSeconds = START_SECONDS + earnedSeconds;

      finishGame(
        "남은 시간이 모두 소진되었습니다.",
        "timeout"
      );
      return false;
    }

    elapsedSeconds += deltaMilliseconds / 1000;
    fallAccumulator += deltaMilliseconds;

    return true;
  }

  function gameLoop(now) {
    animationId = null;

    if (!advanceClock(now)) {
      return;
    }

    while (
      fallAccumulator >= fallIntervalMs &&
      gameState === "playing"
    ) {
      fallAccumulator -= fallIntervalMs;
      moveDown();
    }

    updateStats();
    drawBoard();

    if (gameState === "playing") {
      animationId = requestAnimationFrame(gameLoop);
    }
  }

  // ============================================================
  // 일시정지·계속하기
  // ============================================================
  function pauseGame(automatic = false) {
    if (gameState !== "playing") {
      return;
    }

    if (!advanceClock(performance.now())) {
      return;
    }

    gameState = "paused";
    pressedKeys.clear();
    stopSounds();

    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    stateElement.textContent = "일시정지";
    messageElement.textContent = automatic
      ? "화면을 벗어나 자동 일시정지했습니다. 계속하기를 눌러 주세요."
      : "일시정지했습니다. 계속하기를 눌러 주세요.";

    updateControls();
    updateStats();
    drawBoard();

    if (!automatic) {
      pauseButton.focus();
    }
  }

  function resumeGame() {
    if (gameState !== "paused" || document.hidden) {
      return;
    }

    gameState = "playing";
    pressedKeys.clear();
    prepareAudio();

    previousTime = performance.now();

    stateElement.textContent = "진행 중";
    messageElement.textContent = "게임을 계속합니다.";

    updateControls();
    updateStats();
    drawBoard();

    canvas.focus();

    if (animationId === null) {
      animationId = requestAnimationFrame(gameLoop);
    }
  }

  // ============================================================
  // 시작·재시작·종료
  // ============================================================
  function startGame() {
    // 보이지 않는 탭에서는 새 판을 시작하지 않음
    if (document.hidden) {
      return;
    }

    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    stopSounds();
    prepareAudio();

    board = createEmptyBoard();
    currentPiece = null;
    pieceBag = [];

    elapsedSeconds = 0;
    earnedSeconds = 0;
    linePoints = 0;
    clearedLines = 0;
    fallAccumulator = 0;
    fallIntervalMs = savedData.interval;

    pressedKeys.clear();

    resultPanel.hidden = true;
    finalScoreElement.textContent = "0";
    survivalElement.textContent = "0.0";
    finalLinesElement.textContent = "0";
    endReasonElement.textContent = "";

    gameState = "playing";
    stateElement.textContent = "진행 중";
    messageElement.textContent =
      "줄을 제거해 시간을 늘려 보세요.";

    spawnPiece();
    updateControls();
    updateStats();
    drawBoard();

    canvas.focus();
    previousTime = performance.now();
    animationId = requestAnimationFrame(gameLoop);
  }

  function finishGame(reason, reasonCode = "topout") {
    if (gameState !== "playing") {
      return;
    }

    gameState = "ended";
    pressedKeys.clear();
    stopSounds();

    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    recordFinishedGame(reasonCode);

    stateElement.textContent = "종료";
    messageElement.textContent = reason;
    endReasonElement.textContent = reason;

    finalScoreElement.textContent = String(getScore());
    survivalElement.textContent =
      elapsedSeconds.toFixed(1);
    finalLinesElement.textContent =
      String(clearedLines);

    resultPanel.hidden = false;

    updateControls();
    updateStats();
    drawBoard();


  }

  // ============================================================
  // 플레이어 입력
  // ============================================================
  function performAction(action) {
    if (gameState !== "playing") {
      return;
    }

    if (!advanceClock(performance.now())) {
      return;
    }

    switch (action) {
      case "left":
        moveHorizontal(-1);
        break;

      case "right":
        moveHorizontal(1);
        break;

      case "rotate":
        rotatePiece();
        break;

      case "down":
        moveDown();
        break;

      case "drop":
        hardDrop();
        break;

      default:
        return;
    }

    updateStats();
    drawBoard();
  }

  const keyActions = {
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
    ArrowUp: "rotate",
    ArrowDown: "down",
    Space: "drop",
  };

  canvas.addEventListener("keydown", (event) => {
    const action = keyActions[event.code];

    if (!action) {
        return;
    }

    // 게임이 끝나거나 정지해도 게임 키의 기본 스크롤 방지
    event.preventDefault();

    if (gameState !== "playing") {
        return;
    }

    if (event.repeat || pressedKeys.has(event.code)) {
        return;
    }

    pressedKeys.add(event.code);
    performAction(action);
   });

  window.addEventListener("keyup", (event) => {
    pressedKeys.delete(event.code);
  });

  canvas.addEventListener("blur", () => {
    pressedKeys.clear();
  });

  canvas.addEventListener("click", () => {
    canvas.focus();
  });

  controlButtons.forEach((button) => {
    button.addEventListener("click", () => {
      performAction(button.dataset.action);
    });
  });

  // ============================================================
  // 버튼·설정·자동 일시정지 이벤트
  // 이벤트는 최초 실행 시 한 번만 등록
  // ============================================================
  startButton.addEventListener("click", startGame);
  restartButton.addEventListener("click", startGame);

  pauseButton.addEventListener("click", () => {
    if (gameState === "playing") {
      pauseGame();
    } else if (gameState === "paused") {
      resumeGame();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pauseGame(true);
    }
  });

  window.addEventListener("blur", () => {
    pressedKeys.clear();
    pauseGame(true);
  });

  difficultySelect.addEventListener("change", () => {
    if (
      gameState === "playing" ||
      gameState === "paused"
    ) {
      difficultySelect.value =
        String(savedData.interval);
      return;
    }

    const interval = Number(difficultySelect.value);

    if (!ALLOWED_INTERVALS.includes(interval)) {
      return;
    }

    savedData.interval = interval;
    saveData();
  });

  soundCheckbox.addEventListener("change", () => {
    savedData.soundEnabled = soundCheckbox.checked;

    if (savedData.soundEnabled) {
      prepareAudio();
    } else {
      stopSounds();
    }

    saveData();
  });

  resetRecordsButton.addEventListener("click", () => {
    if (
      gameState === "playing" ||
      gameState === "paused"
    ) {
      return;
    }

    savedData.bestScore = 0;
    savedData.records = [];

    if (saveData()) {
      storageMessage.textContent =
        "최고 점수와 플레이 기록을 초기화했습니다. " +
        "설정은 유지합니다.";
    }

    renderSavedData();
  });

  // ============================================================
  // 화면 그리기
  // ============================================================
  function drawCell(x, y, color) {
    const left = x * CELL_WIDTH;
    const top = y * CELL_HEIGHT;

    context.fillStyle = color;
    context.fillRect(
      left + 1,
      top + 1,
      CELL_WIDTH - 2,
      CELL_HEIGHT - 2
    );

    context.strokeStyle = "#080f1c";
    context.lineWidth = 1;
    context.strokeRect(
      left + 1,
      top + 1,
      CELL_WIDTH - 2,
      CELL_HEIGHT - 2
    );
  }

  function drawBoard() {
    context.fillStyle = "#080f1c";
    context.fillRect(
      0,
      0,
      canvas.width,
      canvas.height
    );

    context.strokeStyle = "#24334b";
    context.lineWidth = 1;
    context.beginPath();

    for (let col = 0; col <= COLS; col += 1) {
      const x = col * CELL_WIDTH;

      context.moveTo(x, 0);
      context.lineTo(x, canvas.height);
    }

    for (let row = 0; row <= ROWS; row += 1) {
      const y = row * CELL_HEIGHT;

      context.moveTo(0, y);
      context.lineTo(canvas.width, y);
    }

    context.stroke();

    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        if (board[row][col] !== null) {
          drawCell(col, row, board[row][col]);
        }
      }
    }

    if (currentPiece) {
      for (
        let row = 0;
        row < currentPiece.matrix.length;
        row += 1
      ) {
        for (
          let col = 0;
          col < currentPiece.matrix[row].length;
          col += 1
        ) {
          if (currentPiece.matrix[row][col] === 0) {
            continue;
          }

          const x = currentPiece.x + col;
          const y = currentPiece.y + row;

          if (y >= 0) {
            drawCell(x, y, currentPiece.color);
          }
        }
      }
    }

    if (gameState !== "playing") {
      context.fillStyle = "rgba(8, 15, 28, 0.78)";
      context.fillRect(
        0,
        0,
        canvas.width,
        canvas.height
      );

      context.fillStyle = "#ffffff";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.font =
        'bold 22px "Malgun Gothic", sans-serif';

      let overlayText = "게임 종료";

      if (gameState === "ready") {
        overlayText = "게임 시작을 눌러 주세요";
      } else if (gameState === "paused") {
        overlayText = "일시정지";
      }

      context.fillText(
        overlayText,
        canvas.width / 2,
        canvas.height / 2,
        canvas.width - 24
      );
    }
  }

  // ============================================================
  // 최초 실행
  // ============================================================
  loadData();
  renderSavedData();
  updateControls();
  updateStats();
  drawBoard();
})();