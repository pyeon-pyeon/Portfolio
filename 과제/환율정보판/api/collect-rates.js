"use strict";

const {
  collectRates,
  saveDailyRecord,
  publicError,
} = require("./_lib/exchange.js");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // 데이터 저장이 발생하므로 POST만 허용
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: {
        code: "method-not-allowed",
        message: "POST 요청만 사용할 수 있습니다.",
      },
    });
  }

  let currentNormal = null;

  try {
    // 브라우저가 보낸 환율 숫자를 사용하지 않고
    // 서버가 직접 공개 원천에서 조회
    currentNormal = await collectRates();

    // 다섯 통화의 검증이 끝난 정상 기록만 저장
    // 같은 KST 날짜는 갱신, 다른 날짜는 추가
    const savedRecord = await saveDailyRecord(currentNormal);

    return res.status(200).json({
      record: savedRecord,
      timeZone: "Asia/Seoul",
      storage: "server",
      saved: true,
    });
  } catch (error) {
    const result = publicError(error);

    // 조회는 성공했지만 저장에 실패한 경우,
    // 정상 조회값과 저장 여부를 구분해서 반환
    return res.status(result.status).json({
      ...result.body,
      saved: false,
      currentNormal,
    });
  }
};