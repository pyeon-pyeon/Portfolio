# -*- coding: utf-8 -*-

"""
포트폴리오 기록 갱신 장치

입력:
    input/rituals.json
    input/attendance.json
    input/tasks.json

출력:
    output/metrics.json
    output/candidates.json
    output/result.md

실행:
    python update.py

같은 소스와 입력 파일이면 같은 결과를 생성합니다.
사이트의 approved.json은 수정하지 않습니다.
"""

import argparse
import hashlib
import json
import re
import sys
import unicodedata

from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent

SCHEMA_VERSION = 1
RULE_VERSION = "2.0.0"

MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_CANDIDATES_PER_ABILITY = 5

MASK_MARKER = re.compile(r"\(\s*이름\s*가림\s*\)")

ABILITY_RULES = [
    {
        "ability": "자기조절력",
        "keywords": (
            "알림", "핸드폰", "휴대폰", "집중", "계획",
            "나누", "조급", "차분", "감정",
        ),
    },
    {
        "ability": "대인관계력",
        "keywords": (
            "대화", "경청", "상대", "설명", "질문",
            "의견", "도와", "알려", "팀원", "함께",
        ),
    },
    {
        "ability": "자기동기력",
        "keywords": (
            "시도", "도전", "포기", "끝까지", "계속",
            "시작", "문제", "원인", "오류", "공부",
            "기출", "해결",
        ),
    },
]

PRIVACY_PATTERNS = [
    (
        "이메일 형태",
        re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ),
    (
        "휴대전화 번호 형태",
        re.compile(r"(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)"),
    ),
    (
        "주민등록번호 형태",
        re.compile(r"(?<!\d)\d{6}[ -]?[1-4]\d{6}(?!\d)"),
    ),
    (
        "비밀키 형태",
        re.compile(
            r"(?:sb_secret_[A-Za-z0-9_-]+"
            r"|sk-[A-Za-z0-9_-]{16,}"
            r"|ghp_[A-Za-z0-9]{20,})"
        ),
    ),
    (
        "토큰 형태",
        re.compile(
            r"\beyJ[A-Za-z0-9_-]+\."
            r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"
        ),
    ),
]


class InputError(Exception):
    """입력 내용을 확인해야 할 때 사용합니다."""


def require(condition, message):
    if not condition:
        raise InputError(message)


def is_count(value):
    return type(value) is int and value >= 0


def read_text(value, location):
    require(
        isinstance(value, str) and bool(value.strip()),
        f"{location}에 비어 있지 않은 문자열이 필요합니다.",
    )
    return unicodedata.normalize("NFC", value).strip()


def read_date(value, location):
    require(
        isinstance(value, str)
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value),
        f"{location}은 YYYY-MM-DD 형식이어야 합니다.",
    )

    try:
        return date.fromisoformat(value)
    except ValueError:
        raise InputError(
            f"{location}에 존재하지 않는 날짜가 있습니다."
        ) from None


def reject_duplicate_keys(pairs):
    result = {}

    for key, value in pairs:
        require(
            key not in result,
            "JSON에 중복된 항목 이름이 있습니다.",
        )
        result[key] = value

    return result


def reject_constant(_value):
    raise InputError("JSON에 유효하지 않은 숫자가 있습니다.")


def read_json(path):
    require(
        path.is_file(),
        f"입력 파일이 없습니다: {path.name}",
    )

    raw = path.read_bytes()

    require(
        len(raw) <= MAX_INPUT_BYTES,
        f"{path.name} 파일이 10MB를 넘습니다.",
    )

    try:
        value = json.loads(
            raw.decode("utf-8-sig"),
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise InputError(
            f"{path.name}의 UTF-8 인코딩과 JSON 문법을 확인해 주세요."
        ) from None

    require(
        isinstance(value, dict),
        f"{path.name} 최상위 값은 객체여야 합니다.",
    )

    return value, hashlib.sha256(raw).hexdigest()


def read_lines(value, location):
    if value is None:
        return []

    require(
        isinstance(value, list),
        f"{location}은 문자열 목록이어야 합니다.",
    )

    result = []

    for line in value:
        require(
            isinstance(line, str),
            f"{location}에 문자열이 아닌 값이 있습니다.",
        )

        normalized = unicodedata.normalize("NFC", line).strip()

        if normalized:
            result.append(normalized)

    return result


def split_field(line):
    label, separator, value = line.partition(":")

    if not separator:
        return None

    return label.strip(), value.strip()


# ========================================
# 리추얼 기록
# ========================================

def read_rituals(data):
    read_text(data.get("student"), "리추얼 본인 이름")

    source_days = data.get("days")

    require(
        isinstance(source_days, list) and bool(source_days),
        "리추얼 days에 날짜별 기록이 필요합니다.",
    )

    days = []
    seen = set()

    for entry in source_days:
        require(
            isinstance(entry, dict),
            "날짜별 리추얼은 객체여야 합니다.",
        )

        day = read_date(entry.get("date"), "리추얼 날짜")
        day_text = day.isoformat()

        require(
            day_text not in seen,
            f"{day_text} 리추얼 날짜가 중복됩니다.",
        )
        seen.add(day_text)

        require(
            "open" in entry and "close" in entry,
            f"{day_text}에 open과 close 항목이 필요합니다.",
        )

        days.append({
            "date": day_text,
            "open": read_lines(
                entry["open"], f"{day_text} 아침"
            ),
            "close": read_lines(
                entry["close"], f"{day_text} 마무리"
            ),
        })

    days.sort(key=lambda item: item["date"])

    require(
        any(day["open"] or day["close"] for day in days),
        "내용이 있는 리추얼 기록이 없습니다.",
    )

    return days


def classify_action(lines, day_text):
    values = []

    for line in lines:
        field = split_field(line)

        if field and field[0] == "강점 행동":
            values.append(field[1])

    require(
        len(values) == 1,
        f"{day_text} 강점 행동 응답은 정확히 하나여야 합니다.",
    )

    value = MASK_MARKER.sub("", values[0])
    value = re.sub(r"\s+", "", value)

    if value == "실천":
        return "practiced"

    if value == "일부실천":
        return "partial"

    if value in {"못", "못함", "못했음", "미실천", "실천못함"}:
        return "notPracticed"

    raise InputError(
        f"{day_text} 강점 행동 응답의 분류를 확인해 주세요."
    )


def build_ritual_metrics(days):
    active = [
        day for day in days
        if day["open"] or day["close"]
    ]

    counts = Counter()

    for day in active:
        if day["close"]:
            counts[classify_action(day["close"], day["date"])] += 1

    return {
        "source": "내 리추얼 기록 · input/rituals.json",
        "startDate": active[0]["date"],
        "endDate": active[-1]["date"],
        "recordDays": len(active),
        "openCount": sum(bool(day["open"]) for day in active),
        "closeCount": sum(bool(day["close"]) for day in active),
        "practiced": counts["practiced"],
        "partial": counts["partial"],
        "notPracticed": counts["notPracticed"],
    }


def build_candidates(days):
    matches = {
        rule["ability"]: []
        for rule in ABILITY_RULES
    }

    warnings = []

    for day in days:
        for index, line in enumerate(day["close"]):
            field = split_field(line)

            if not field:
                continue

            label, text = field

            if label != "강점을 위해 노력하고 생각한 것" or not text:
                continue

            privacy_flags = [
                name
                for name, pattern in PRIVACY_PATTERNS
                if pattern.search(text)
            ]

            if privacy_flags:
                warnings.append({
                    "date": day["date"],
                    "field": label,
                    "reason": "개인정보 또는 비밀값 형태로 후보에서 제외",
                    "types": privacy_flags,
                })
                continue

            for rule in ABILITY_RULES:
                keywords = [
                    keyword
                    for keyword in rule["keywords"]
                    if keyword in text
                ]

                if not keywords:
                    continue

                matches[rule["ability"]].append({
                    "id": (
                        f"{rule['ability']}-"
                        f"{day['date']}-close-{index + 1}"
                    ),
                    "approved": False,
                    "ability": rule["ability"],
                    "date": day["date"],
                    "text": (
                        f"{day['date']} 마무리 기록에 "
                        f"“{text}”라고 남겼습니다."
                    ),
                    "evidence": (
                        f"{day['date']} 마무리 리추얼 "
                        f"「{label}」"
                    ),
                    "sourcePointer": (
                        f"days[date={day['date']}].close[{index}]"
                    ),
                    "sourceText": text,
                    "matchedKeywords": keywords,
                    "reviewNotes": [
                        "키워드 일치는 능력 입증 판정이 아닙니다.",
                        "실제 행동과 날짜를 원문에서 확인해 주세요.",
                        "다른 사람 이름·연락처·비밀값을 확인해 주세요.",
                        "익명화로 뜻이 흐려진 부분을 검토해 주세요.",
                    ],
                })

    result = []

    for rule in ABILITY_RULES:
        ordered = sorted(
            matches[rule["ability"]],
            key=lambda item: item["date"],
            reverse=True,
        )

        result.extend(
            ordered[:MAX_CANDIDATES_PER_ABILITY]
        )

    return result, warnings


# ========================================
# 출석 집계
# ========================================

def build_attendance(data):
    require(
        data.get("schemaVersion") == 1,
        "출석 자료의 schemaVersion을 확인해 주세요.",
    )
    require(
        data.get("timezone") == "Asia/Seoul",
        "출석 자료의 시간대는 Asia/Seoul이어야 합니다.",
    )

    captured = read_date(
        data.get("capturedOn"), "출석 조회일"
    )

    period = data.get("period")
    summary = data.get("summary")

    require(isinstance(period, dict), "출석 기간이 필요합니다.")
    require(isinstance(summary, dict), "출석 집계가 필요합니다.")

    start = read_date(period.get("startDate"), "출석 시작일")
    end = read_date(period.get("endDate"), "출석 종료일")

    require(
        start <= end <= captured,
        "출석 기간과 조회일의 순서를 확인해 주세요.",
    )

    count_keys = [
        "trainingDays",
        "enrolledDays",
        "presentDays",
        "absentDays",
        "pendingDays",
    ]

    for key in count_keys:
        require(
            is_count(summary.get(key)),
            f"출석 {key}는 0 이상의 정수여야 합니다.",
        )

    require(
        summary["enrolledDays"] <= summary["trainingDays"],
        "재적일이 훈련일보다 많습니다.",
    )

    known_days = (
        summary["presentDays"]
        + summary["absentDays"]
        + summary["pendingDays"]
    )

    # 기타 출석 상태가 있을 수 있어 강제로 합계 일치를 요구하지 않습니다.
    require(
        known_days <= summary["enrolledDays"],
        "출석·결석·미확정 합계가 재적일보다 많습니다.",
    )

    rate = summary.get("displayedAttendanceRate")

    require(
        type(rate) in (int, float) and 0 <= rate <= 100,
        "화면 표시 출석률은 0~100 사이 숫자여야 합니다.",
    )

    pending_dates = data.get("pendingDates")

    require(
        isinstance(pending_dates, list),
        "미확정 날짜 목록이 필요합니다.",
    )

    parsed_pending = [
        read_date(value, "미확정 날짜")
        for value in pending_dates
    ]

    require(
        len(set(parsed_pending)) == len(parsed_pending),
        "미확정 날짜가 중복됩니다.",
    )

    require(
        len(parsed_pending) == summary["pendingDays"],
        "미확정 날짜 수와 집계가 다릅니다.",
    )

    require(
        all(start <= day <= end for day in parsed_pending),
        "미확정 날짜가 집계 기간 밖에 있습니다.",
    )

    return {
        "source": read_text(data.get("source"), "출석 출처"),
        "sourceFile": read_text(
            data.get("sourceFile"), "출석 근거 파일"
        ),
        "capturedOn": captured.isoformat(),
        "timezone": "Asia/Seoul",
        "period": {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "scope": read_text(period.get("scope"), "출석 집계 범위"),
        },
        "summary": {
            key: summary[key]
            for key in count_keys
        } | {
            "displayedAttendanceRate": rate,
        },
        "pendingDates": sorted(pending_dates),
        "rateBasis": "원천 화면 표시값을 사용하며 재계산하지 않음",
        "notes": read_lines(data.get("notes"), "출석 안내"),
    }


# ========================================
# 과제 제출·승인
# ========================================

def build_tasks(data):
    require(
        data.get("schemaVersion") == 1,
        "과제 자료의 schemaVersion을 확인해 주세요.",
    )
    require(
        data.get("timezone") == "Asia/Seoul",
        "과제 자료의 시간대는 Asia/Seoul이어야 합니다.",
    )

    captured = read_date(
        data.get("capturedOn"), "과제 확인일"
    )

    entries = data.get("tasks")

    require(
        isinstance(entries, list),
        "과제 tasks 목록이 필요합니다.",
    )

    seen = set()
    tasks = []

    for entry in entries:
        require(
            isinstance(entry, dict),
            "과제 항목은 객체여야 합니다.",
        )

        task_id = read_text(entry.get("id"), "과제 ID")

        require(
            re.fullmatch(r"T\d{2}", task_id) is not None,
            "과제 ID는 T01 같은 형식이어야 합니다.",
        )
        require(
            task_id not in seen,
            f"{task_id} 과제 ID가 중복됩니다.",
        )
        seen.add(task_id)

        require(
            entry.get("status") == "submitted",
            f"{task_id}는 현재 submitted 상태만 처리합니다.",
        )

        submitted_text = read_text(
            entry.get("submittedAt"), f"{task_id} 제출 시각"
        )

        try:
            submitted = datetime.fromisoformat(submitted_text)
        except ValueError:
            raise InputError(
                f"{task_id} 제출 시각 형식을 확인해 주세요."
            ) from None

        require(
            submitted.utcoffset() == timedelta(hours=9),
            f"{task_id} 제출 시각에 KST 오프셋 +09:00이 필요합니다.",
        )
        require(
            submitted.date() <= captured,
            f"{task_id} 제출일이 확인일보다 늦습니다.",
        )

        review_status = entry.get("reviewStatus")

        require(
            review_status is None or review_status == "approved",
            f"{task_id} 승인 상태를 확인해 주세요.",
        )

        tasks.append({
            "id": task_id,
            "title": read_text(entry.get("title"), f"{task_id} 제목"),
            "status": "submitted",
            "submittedAt": submitted.isoformat(),
            "sourceFile": read_text(
                entry.get("sourceFile"), f"{task_id} 출처 파일"
            ),
            "reviewStatus": review_status,
        })

    tasks.sort(key=lambda item: item["id"])

    approved_count = sum(
        item["reviewStatus"] == "approved"
        for item in tasks
    )

    notes = read_lines(data.get("notes"), "과제 안내")

    if approved_count:
        require(
            bool(notes),
            "승인 상태의 확인 근거를 notes에 적어 주세요.",
        )

    return {
        "source": read_text(data.get("source"), "과제 출처"),
        "capturedOn": captured.isoformat(),
        "timezone": "Asia/Seoul",
        "scope": read_text(data.get("scope"), "과제 집계 범위"),
        "submittedCount": len(tasks),
        "approvedCount": approved_count,
        "reviewUnknownCount": len(tasks) - approved_count,
        "approvalBasis": (
            "본인 확인에 따른 입력 상태이며 승인 시각·점수는 집계하지 않음"
            if approved_count
            else "승인 상태 확인 자료 없음"
        ),
        "items": tasks,
        "notes": notes,
    }


# ========================================
# 결과 파일
# ========================================

def write_json(path, data):
    text = json.dumps(
        data,
        ensure_ascii=False,
        indent=2,
        allow_nan=False,
    ) + "\n"

    write_text(path, text)


def write_text(path, text):
    with path.open("w", encoding="utf-8", newline="\n") as file:
        file.write(text)


def make_report(metrics, attendance, tasks, candidates, warnings, hashes):
    close_count = metrics["closeCount"]

    rate = (
        f"{(metrics['practiced'] + metrics['partial']) / close_count * 100:.1f}%"
        if close_count
        else "기록이 없어 계산하지 않음"
    )

    summary = attendance["summary"]
    candidate_counts = Counter(
        candidate["ability"] for candidate in candidates
    )

    lines = [
        "# 포트폴리오 기록 갱신 결과",
        "",
        f"- 규칙 버전: {RULE_VERSION}",
        "- 모든 결과는 검토 전 자료입니다.",
        "- 사이트의 approved.json은 수정하지 않았습니다.",
        "",
        "## 1. 입력 파일 확인",
        "",
    ]

    for name, digest in hashes.items():
        lines.append(f"- `{name}` SHA-256: `{digest}`")

    lines.extend([
        "",
        "## 2. 리추얼",
        "",
        f"- 출처: {metrics['source']}",
        f"- 기간: {metrics['startDate']}–{metrics['endDate']}",
        f"- 기록 날짜: {metrics['recordDays']}일",
        f"- 아침: {metrics['openCount']}건",
        f"- 마무리: {close_count}건",
        f"- 실천: {metrics['practiced']}건",
        f"- 일부 실천: {metrics['partial']}건",
        f"- 미실천: {metrics['notPracticed']}건",
        f"- 실천 또는 일부 실천 비율: {rate}",
        "",
        "분모는 마무리 기록 수입니다.",
        "마무리가 없는 날짜를 미실천으로 계산하지 않습니다.",
        "자기보고 실천 비율이며 출석률·과제 완료율이 아닙니다.",
        "",
        "## 3. 출석",
        "",
        f"- 출처: {attendance['source']}",
        f"- 근거 파일: {attendance['sourceFile']}",
        f"- 조회일: {attendance['capturedOn']} KST",
        (
            f"- 기간: {attendance['period']['startDate']}"
            f"–{attendance['period']['endDate']}"
        ),
        f"- 훈련일: {summary['trainingDays']}일",
        f"- 재적일: {summary['enrolledDays']}일",
        f"- 출석: {summary['presentDays']}일",
        f"- 결석: {summary['absentDays']}일",
        f"- 미확정: {summary['pendingDays']}일",
        f"- 화면 표시 출석률: {summary['displayedAttendanceRate']}%",
        "",
        "출석률은 원천 화면의 표시값이며 재계산하지 않았습니다.",
        "미확정 날짜: " + (
            ", ".join(attendance["pendingDates"]) or "없음"
        ),
        "",
    ])

    lines.extend(f"- {note}" for note in attendance["notes"])

    lines.extend([
        "",
        "## 4. 과제 제출·승인",
        "",
        f"- 출처: {tasks['source']}",
        f"- 확인일: {tasks['capturedOn']} KST",
        f"- 범위: {tasks['scope']}",
        f"- 제출: {tasks['submittedCount']}건",
        f"- 승인: {tasks['approvedCount']}건",
        f"- 승인 상태 미확인: {tasks['reviewUnknownCount']}건",
        f"- 승인 근거: {tasks['approvalBasis']}",
        "",
        "### 과제별 날짜",
        "",
    ])

    for task in tasks["items"]:
        review_label = (
            "승인"
            if task["reviewStatus"] == "approved"
            else "승인 상태 미확인"
        )

        lines.append(
            f"- {task['id']} · {task['title']} · "
            f"{task['submittedAt']} · {review_label} · "
            f"출처: {task['sourceFile']}"
        )

    lines.append("")
    lines.extend(f"- {note}" for note in tasks["notes"])

    lines.extend([
        "",
        "## 5. 능력별 문단 후보",
        "",
    ])

    for rule in ABILITY_RULES:
        ability = rule["ability"]

        lines.append(
            f"- {ability}: {candidate_counts[ability]}건"
        )

    lines.extend([
        "",
        "최신 날짜부터 능력별 최대 5건을 고릅니다.",
        "같은 장면이 여러 능력의 후보가 될 수 있습니다.",
        "후보가 없으면 내용을 만들어 채우지 않습니다.",
        "키워드 일치는 능력 입증이나 객관적 평가가 아닙니다.",
        "",
        "## 6. 공개 전 확인",
        "",
        "- 모든 후보의 approved는 false입니다.",
        "- 문장과 날짜를 원문 근거와 대조해 주세요.",
        "- 본인 외의 실명·연락처와 비밀값을 직접 확인해 주세요.",
        "- 자동 검사는 일반적인 사람 이름을 완전히 찾지 못합니다.",
        "- 검토하지 않은 입력·출력을 그대로 공개하지 마세요.",
        "- 승인한 내용만 사이트의 approved.json에 옮겨 주세요.",
        "",
        f"개인정보 형태로 후보에서 제외한 항목: {len(warnings)}건",
        "",
        "## 7. 해석의 한계",
        "",
        "- 리추얼 실천, 출석, 과제 승인은 서로 다른 지표입니다.",
        "- 승인 여부는 본인이 확인해 입력한 상태입니다.",
        "- 입력에 없는 승인 시각·점수·작업 시간은 추정하지 않습니다.",
        "- 출석 원천 화면과 제출 기록 서버에 실시간 접속하지 않습니다.",
        "- 입력을 갱신한 뒤 실행하고, 사람이 검토해야 합니다.",
        "",
    ])

    return "\n".join(lines)


def run(input_dir, output_dir):
    require(
        input_dir.resolve() != output_dir.resolve(),
        "입력 폴더와 출력 폴더는 다르게 지정해 주세요.",
    )

    rituals_raw, rituals_hash = read_json(
        input_dir / "rituals.json"
    )
    attendance_raw, attendance_hash = read_json(
        input_dir / "attendance.json"
    )
    tasks_raw, tasks_hash = read_json(
        input_dir / "tasks.json"
    )

    # 세 입력을 모두 검증한 뒤 결과를 씁니다.
    days = read_rituals(rituals_raw)
    metrics = build_ritual_metrics(days)
    attendance = build_attendance(attendance_raw)
    tasks = build_tasks(tasks_raw)
    candidates, warnings = build_candidates(days)

    hashes = {
        "rituals.json": rituals_hash,
        "attendance.json": attendance_hash,
        "tasks.json": tasks_hash,
    }

    metadata = {
        "schemaVersion": SCHEMA_VERSION,
        "ruleVersion": RULE_VERSION,
        "inputHashes": hashes,
    }

    metrics_output = {
        **metadata,
        "approved": False,
        "metrics": metrics,
        "attendance": attendance,
        "tasks": tasks,
    }

    candidates_output = {
        **metadata,
        "approved": False,
        "selection": {
            "order": "날짜 내림차순",
            "maxPerAbility": MAX_CANDIDATES_PER_ABILITY,
        },
        "paragraphs": candidates,
        "warnings": warnings,
    }

    report = make_report(
        metrics,
        attendance,
        tasks,
        candidates,
        warnings,
        hashes,
    )

    output_dir.mkdir(parents=True, exist_ok=True)

    write_json(output_dir / "metrics.json", metrics_output)
    write_json(output_dir / "candidates.json", candidates_output)
    write_text(output_dir / "result.md", report)

    print("리추얼 집계 완료")
    print(
        f"기록 {metrics['recordDays']}일 / "
        f"아침 {metrics['openCount']}건 / "
        f"마무리 {metrics['closeCount']}건"
    )
    print(
        f"실천 {metrics['practiced']}건 / "
        f"일부 실천 {metrics['partial']}건 / "
        f"미실천 {metrics['notPracticed']}건"
    )

    attendance_summary = attendance["summary"]

    print("출석 집계 완료")
    print(
        f"출석 {attendance_summary['presentDays']}일 / "
        f"결석 {attendance_summary['absentDays']}일 / "
        f"미확정 {attendance_summary['pendingDays']}일"
    )
    print(
        "화면 표시 출석률: "
        f"{attendance_summary['displayedAttendanceRate']}%"
    )

    print("과제 집계 완료")
    print(
        f"제출 {tasks['submittedCount']}건 / "
        f"승인 {tasks['approvedCount']}건 / "
        f"승인 상태 미확인 {tasks['reviewUnknownCount']}건"
    )

    print(f"검토할 문단 후보: {len(candidates)}건")
    print(f"개인정보 형태로 제외한 항목: {len(warnings)}건")

    print("생성: metrics.json")
    print("생성: candidates.json")
    print("생성: result.md")
    print("approved.json은 수정하지 않았습니다.")


def main():
    parser = argparse.ArgumentParser(
        description="리추얼·출석·제출 기록에서 갱신 후보를 만듭니다."
    )

    parser.add_argument(
        "--input",
        type=Path,
        default=SCRIPT_DIR / "input",
        help="입력 JSON 파일 3개가 들어 있는 폴더",
    )

    parser.add_argument(
        "--output",
        type=Path,
        default=SCRIPT_DIR / "output",
        help="결과를 저장할 폴더",
    )

    args = parser.parse_args()

    try:
        run(args.input, args.output)
    except InputError as error:
        print(f"입력 확인 필요: {error}", file=sys.stderr)
        return 1
    except OSError:
        print(
            "파일을 읽거나 쓰지 못했습니다. 경로와 권한을 확인해 주세요.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())