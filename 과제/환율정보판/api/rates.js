"use strict";

const {
  getDailyRecords,
  publicError,
} = require("./_lib/exchange.js");

module.exports = async function handler(req, res) {
  // 저장된 기록을 매번 조회하도록 캐시 방지
  res.setHeader("Cache-Control", "no-store");

  // GET 요청만 허용
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: {
        code: "method-not-allowed",
        message: "GET 요청만 사용할 수 있습니다.",
      },
    });
  }

  try {
    const records = await getDailyRecords();

    return res.status(200).json({
      records,
      lastNormal: records.at(-1) || null,
      timeZone: "Asia/Seoul",
      storage: "server",
    });
  } catch (error) {
    // 비밀키나 DB의 내부 오류 내용은 반환하지 않음
    const result = publicError(error);

    return res.status(result.status).json(result.body);
  }
};