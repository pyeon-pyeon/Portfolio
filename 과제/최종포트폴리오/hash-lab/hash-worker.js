"use strict";

// ========================================
// 기본 설정
// ========================================

const LIBRARY_VERSION = "4.12.0";

const SAMPLES = new Set([
  "LabOnly-0016-Example!",
  "StudyOnly-Hash-Lab-2026!",
  "DemoOnly-Salt-Compare!",
]);

const encoder = new TextEncoder();

let libraryReady = false;
let busy = false;

// ========================================
// 공통 함수
// ========================================

function send(type, requestId, payload = {}) {
  self.postMessage({
    type,
    requestId,
    ...payload,
  });
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

function hex(bytes) {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

function digest(hasher, salt, bytes) {
  hasher.init();
  hasher.update(salt);
  hasher.update(bytes);

  return hasher.digest("hex");
}

function progress(requestId, percent, message) {
  send("progress", requestId, {
    percent,
    message,
  });
}

function checkTime(deadline) {
  ensure(
    performance.now() < deadline,
    "측정 제한 시간 90초를 넘었습니다. 후보 수나 비용 설정을 낮춰 다시 실행해 주세요."
  );
}

// ========================================
// Salt 효과 실습
// ========================================

async function saltExperiment(sample) {
  ensure(
    SAMPLES.has(sample),
    "목록에 있는 가상 문자열을 선택해 주세요."
  );

  const hasher = await hashwasm.createSHA256();

  const saltA = randomSalt();
  let saltB = randomSalt();

  while (hex(saltA) === hex(saltB)) {
    saltB = randomSalt();
  }

  const bytes = encoder.encode(sample);

  return {
    sample,
    saltA: hex(saltA),
    saltB: hex(saltB),
    hashA: digest(hasher, saltA, bytes),
    hashB: digest(hasher, saltB, bytes),
  };
}

// ========================================
// 측정 설정 검증
// ========================================

function settingsFrom(raw) {
  ensure(
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw),
    "실험 설정이 필요합니다."
  );

  const {
    candidateCount,
    bcryptCost,
    argonMemory,
    argonIterations,
  } = raw;

  ensure(
    [8, 16, 32].includes(candidateCount),
    "후보 수는 8·16·32 중에서 선택해 주세요."
  );

  ensure(
    [10, 12].includes(bcryptCost),
    "bcrypt cost는 10 또는 12로 선택해 주세요."
  );

  ensure(
    [19456, 32768, 65536].includes(argonMemory),
    "Argon2id 메모리 설정을 확인해 주세요."
  );

  ensure(
    [2, 3].includes(argonIterations),
    "Argon2id 반복 횟수를 확인해 주세요."
  );

  return {
    candidateCount,
    bcryptCost,
    argonMemory,
    argonIterations,
    argonParallelism: 1,
  };
}

// ========================================
// 측정 결과 생성
// ========================================

function measurement(
  algorithm,
  checks,
  elapsedMs,
  matches,
  expectedMatches,
  parameters
) {
  ensure(
    checks > 0 &&
    Number.isFinite(elapsedMs) &&
    elapsedMs > 0,
    "측정 시간이 너무 짧거나 올바르지 않아 결과를 만들지 못했습니다."
  );

  ensure(
    matches === expectedMatches,
    "가상 후보 검증 결과가 예상과 달라 측정을 중단했습니다."
  );

  return {
    algorithm,
    checks,
    elapsedMs,
    perCandidateMs: elapsedMs / checks,
    checksPerSecond: checks * 1000 / elapsedMs,
    matches,
    expectedMatches,
    parameters,
  };
}

// ========================================
// 세 방식 측정
// ========================================

async function benchmark(raw, requestId) {
  const settings = settingsFrom(raw);
  const count = settings.candidateCount;

  const candidates = Array.from(
    { length: count },
    (_, index) => (
      `LabOnly-${String(index + 1).padStart(4, "0")}-Example!`
    )
  );

  const candidateBytes = candidates.map(
    (value) => encoder.encode(value)
  );

  const targetIndex = Math.floor(count / 2);
  const target = candidates[targetIndex];

  const deadline = performance.now() + 90000;
  const measurements = [];

  progress(
    requestId,
    5,
    "목표 해시를 준비합니다. 준비 시간은 검증 시간에서 제외합니다."
  );

  // ----------------------------------------
  // SHA-256 준비
  // ----------------------------------------

  const sha = await hashwasm.createSHA256();

  const shaSalt = randomSalt();

  const shaTarget = digest(
    sha,
    shaSalt,
    candidateBytes[targetIndex]
  );

  ensure(
    digest(
      sha,
      shaSalt,
      encoder.encode("Wrong-Lab-Only!")
    ) !== shaTarget,
    "SHA-256 검증 준비에 실패했습니다."
  );

  // 준비 실행은 측정에 포함하지 않습니다.
  digest(sha, shaSalt, candidateBytes[targetIndex]);

  // ----------------------------------------
  // bcrypt 준비
  // ----------------------------------------

  const bcryptSalt = randomSalt();

  const bcryptTarget = await hashwasm.bcrypt({
    password: target,
    salt: bcryptSalt,
    costFactor: settings.bcryptCost,
    outputType: "encoded",
  });

  ensure(
    await hashwasm.bcryptVerify({
      password: target,
      hash: bcryptTarget,
    }),
    "bcrypt 정상 후보 검증에 실패했습니다."
  );

  ensure(
    !(
      await hashwasm.bcryptVerify({
        password: "Wrong-Lab-Only!",
        hash: bcryptTarget,
      })
    ),
    "bcrypt 불일치 후보 검증에 실패했습니다."
  );

  checkTime(deadline);

  // ----------------------------------------
  // Argon2id 준비
  // ----------------------------------------

  const argonSalt = randomSalt();

  const argonTarget = await hashwasm.argon2id({
    password: target,
    salt: argonSalt,
    iterations: settings.argonIterations,
    parallelism: 1,
    memorySize: settings.argonMemory,
    hashLength: 32,
    outputType: "encoded",
  });

  ensure(
    await hashwasm.argon2Verify({
      password: target,
      hash: argonTarget,
    }),
    "Argon2id 정상 후보 검증에 실패했습니다."
  );

  ensure(
    !(
      await hashwasm.argon2Verify({
        password: "Wrong-Lab-Only!",
        hash: argonTarget,
      })
    ),
    "Argon2id 불일치 후보 검증에 실패했습니다."
  );

  checkTime(deadline);

  // ----------------------------------------
  // SHA-256 측정
  // ----------------------------------------

  progress(
    requestId,
    15,
    "salted SHA-256을 측정합니다."
  );

  let loops = 0;
  let shaMatches = 0;
  let shaElapsed = 0;

  const shaStart = performance.now();

  do {
    for (const bytes of candidateBytes) {
      if (digest(sha, shaSalt, bytes) === shaTarget) {
        shaMatches += 1;
      }
    }

    loops += 1;
    shaElapsed = performance.now() - shaStart;

    if (loops % 256 === 0) {
      checkTime(deadline);
    }
  } while (
    shaElapsed < 250 &&
    loops * count < 1000000
  );

  measurements.push(
    measurement(
      "salted_sha256",
      loops * count,
      shaElapsed,
      shaMatches,
      loops,
      {
        saltBytes: 16,
        construction: "SHA256(salt || UTF8(candidate))",
        listPasses: loops,
      }
    )
  );

  checkTime(deadline);

  // ----------------------------------------
  // bcrypt 측정
  // ----------------------------------------

  progress(
    requestId,
    25,
    "bcrypt를 측정합니다."
  );

  let bcryptElapsed = 0;
  let bcryptMatches = 0;

  for (let i = 0; i < count; i += 1) {
    checkTime(deadline);

    const start = performance.now();

    const match = await hashwasm.bcryptVerify({
      password: candidates[i],
      hash: bcryptTarget,
    });

    bcryptElapsed += performance.now() - start;

    if (match) {
      bcryptMatches += 1;
    }

    progress(
      requestId,
      25 + (i + 1) / count * 35,
      `bcrypt 후보 ${i + 1}/${count} 검증`
    );
  }

  measurements.push(
    measurement(
      "bcrypt",
      count,
      bcryptElapsed,
      bcryptMatches,
      1,
      {
        cost: settings.bcryptCost,
        saltBytes: 16,
        listPasses: 1,
      }
    )
  );

  // ----------------------------------------
  // Argon2id 측정
  // ----------------------------------------

  progress(
    requestId,
    60,
    "Argon2id를 측정합니다."
  );

  let argonElapsed = 0;
  let argonMatches = 0;

  for (let i = 0; i < count; i += 1) {
    checkTime(deadline);

    const start = performance.now();

    const match = await hashwasm.argon2Verify({
      password: candidates[i],
      hash: argonTarget,
    });

    argonElapsed += performance.now() - start;

    if (match) {
      argonMatches += 1;
    }

    progress(
      requestId,
      60 + (i + 1) / count * 35,
      `Argon2id 후보 ${i + 1}/${count} 검증`
    );
  }

  measurements.push(
    measurement(
      "argon2id",
      count,
      argonElapsed,
      argonMatches,
      1,
      {
        memoryKiB: settings.argonMemory,
        iterations: settings.argonIterations,
        parallelism: 1,
        hashLength: 32,
        saltBytes: 16,
        listPasses: 1,
      }
    )
  );

  checkTime(deadline);

  progress(
    requestId,
    100,
    "세 방식의 검증을 완료했습니다."
  );

  // ----------------------------------------
  // 최종 결과
  // ----------------------------------------

  return {
    schemaVersion: 1,
    kind: "browser-extension-experiment",

    library: {
      name: "hash-wasm",
      version: LIBRARY_VERSION,
    },

    settings,
    measurements,

    protocol: {
      dataset: "앱이 생성한 가상 후보 목록",
      candidatePattern: "LabOnly-NNNN-Example!",
      targetPosition: targetIndex + 1,

      targetHashPreparationIncluded: false,
      warmupIncluded: false,
      earlyExitOnMatch: false,

      order: [
        "salted_sha256",
        "bcrypt",
        "argon2id",
      ],

      shaMeasurement: (
        "약 250ms 이상을 목표로 전체 목록 반복, 최대 100만 검증"
      ),

      slowMeasurement: (
        "각 검증 호출의 벽시계 시간을 합산, 진행 알림은 측정 구간 밖"
      ),

      repetitions: (
        "SHA-256 목록 반복 외에 독립적인 반복 실험은 하지 않음"
      ),

      clock: "performance.now",
    },

    limitations: [
      "브라우저 WebAssembly 구현이며 기존 Python 논문의 측정값과 구분합니다.",
      "코드 호출·비교 등의 비용과 브라우저 일정 처리 영향이 포함됩니다.",
      "실행 순서를 고정한 체험 측정으로 통계적 성능 평가가 아닙니다.",
      "Argon2id 메모리는 설정값이며 전체 메모리 사용량을 측정하지 않습니다.",
      "실제 해독 시간이나 방식별 보안 순위를 뜻하지 않습니다.",
    ],
  };
}

// ========================================
// 화면에서 보내는 요청 처리
// 취소는 app.js에서 Worker를 종료하는 방식으로 연결합니다.
// ========================================

self.addEventListener("message", async (event) => {
  const data = event.data;

  if (!data || typeof data !== "object") {
    return;
  }

  const { type, requestId } = data;

  if (
    !Number.isSafeInteger(requestId) ||
    requestId < 1
  ) {
    return;
  }

  if (!libraryReady) {
    send("error", requestId, {
      message: (
        "계산 라이브러리를 준비하지 못했습니다. 파일 경로를 확인해 주세요."
      ),
    });

    return;
  }

  if (busy) {
    send("error", requestId, {
      message: (
        "이미 계산 중입니다. 완료하거나 취소한 뒤 다시 실행해 주세요."
      ),
    });

    return;
  }

  busy = true;

  try {
    let result;

    if (type === "salt") {
      result = await saltExperiment(data.sample);
    } else if (type === "benchmark") {
      result = await benchmark(
        data.settings,
        requestId
      );
    } else {
      throw new Error(
        "지원하지 않는 실습 요청입니다."
      );
    }

    send("result", requestId, {
      kind: type,
      result,
    });
  } catch (error) {
    const message = (
      error instanceof Error &&
      /[가-힣]/.test(error.message)
    )
      ? error.message
      : (
          "계산 중 오류가 발생했습니다. " +
          "설정을 낮추거나 페이지를 새로고침해 주세요."
        );

    send("error", requestId, {
      message,
    });
  } finally {
    busy = false;
  }
});

// ========================================
// 라이브러리 준비 및 기본 검사
// ========================================

(async () => {
  try {
    importScripts(
      "./vendor/hash-wasm.umd.min.js"
    );

    ensure(
      typeof hashwasm !== "undefined",
      "계산 라이브러리가 없습니다."
    );

    const actual = await hashwasm.sha256("abc");

    const expected = (
      "ba7816bf8f01cfea414140de5dae2223" +
      "b00361a396177a9cb410ff61f20015ad"
    );

    ensure(
      actual === expected,
      "SHA-256 기본 검사가 실패했습니다."
    );

    libraryReady = true;

    send("ready", null, {
      libraryVersion: LIBRARY_VERSION,
    });
  } catch {
    send("boot-error", null, {
      message: (
        "계산 모듈 초기화에 실패했습니다. " +
        "vendor 파일과 WebAssembly 지원을 확인해 주세요."
      ),
    });
  }
})();