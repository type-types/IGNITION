#!/usr/bin/env python3
"""공연 DB 백업(JSON)으로 공연 리포트(Markdown)를 만든다.

사용법: python3 tools/report.py backup/2026-01-17-ignition-db.json > docs/report-2026-01-17.md

집계만 출력하고 채팅 원문은 싣지 않는다.
"""
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))


def ts(ms):
    return datetime.fromtimestamp(ms / 1000, KST)


def main(path):
    d = json.load(open(path, encoding="utf-8"))
    chat = d.get("chat", {}) or {}
    hearts = d.get("hearts", {}) or {}
    raffle = d.get("raffle", {}) or {}
    hype = d.get("hypeCount", {}) or {}
    exploded = d.get("hypeExplodedTeams", {}) or {}

    msgs = sorted(chat.values(), key=lambda m: m.get("timestamp", 0))
    notices = [m for m in msgs if m.get("type") == "notice"]
    donates = [m for m in msgs if m.get("type") == "donate"]
    users = [m for m in msgs if not m.get("type")]
    devices = {m.get("chatId") for m in users if m.get("chatId")}

    # 곡 타임라인: 같은 곡 알림은 첫 시각만 (당시 코드는 접속자마다 알림을 올렸다)
    timeline = []
    seen = set()
    for m in notices:
        text = m.get("text", "")
        if text.startswith("🎵") and text not in seen:
            seen.add(text)
            timeline.append((ts(m["timestamp"]), text[2:].strip()))

    first = ts(msgs[0]["timestamp"]) if msgs else None
    last = ts(msgs[-1]["timestamp"]) if msgs else None

    out = []
    out.append(f"# IGNITION 공연 리포트 ({first.strftime('%Y-%m-%d') if first else '날짜 미상'})")
    out.append("")
    out.append("백업된 Realtime Database 기록을 집계한 결과입니다. 채팅 원문은 싣지 않습니다.")
    out.append("")
    out.append("## 요약")
    out.append("")
    if first and last:
        out.append(f"- 기록 구간: {first.strftime('%H:%M')} 부터 {last.strftime('%H:%M')} 까지")
    out.append(f"- 채팅 메시지: 관객 {len(users)}건 (기기 {len(devices)}대), 곡 변경 알림 {len(notices)}건, 후원 알림 {len(donates)}건")
    out.append(f"- 추첨 참여자: {len((raffle.get('participants') or {}))}명, 당첨 번호: {(raffle.get('winner') or {}).get('number', '없음')}")
    out.append(f"- 피버 타임 MAX 달성 팀: {', '.join(exploded.keys()) if exploded else '없음'}")
    out.append("")

    out.append("## 곡 타임라인")
    out.append("")
    if timeline:
        out.append("| 시각 | 곡 |")
        out.append("|---|---|")
        for t, text in timeline:
            out.append(f"| {t.strftime('%H:%M:%S')} | {text} |")
    else:
        out.append("기록 없음")
    out.append("")

    out.append("## 곡별 하트")
    out.append("")
    if hearts:
        out.append("| 곡 ID | 하트 |")
        out.append("|---|---|")
        for k, v in sorted(hearts.items(), key=lambda kv: -kv[1]):
            out.append(f"| {k} | {v} |")
        out.append("")
        out.append("곡 ID는 팀명과 곡명을 base64로 만든 키입니다. 현재 코드 형식과 다른 키는 이전 버전의 기록입니다.")
    else:
        out.append("기록 없음")
    out.append("")

    out.append("## 시간대별 채팅량 (10분 단위, 관객 메시지만)")
    out.append("")
    buckets = Counter()
    for m in users:
        t = ts(m["timestamp"])
        buckets[t.replace(minute=t.minute // 10 * 10, second=0, microsecond=0)] += 1
    if buckets:
        out.append("| 시각 | 메시지 수 |")
        out.append("|---|---|")
        for t in sorted(buckets):
            out.append(f"| {t.strftime('%H:%M')} | {buckets[t]} |")
    else:
        out.append("기록 없음")
    out.append("")

    out.append("## 팀별 피버 게이지")
    out.append("")
    if hype:
        out.append("| 팀 | 게이지 | MAX |")
        out.append("|---|---|---|")
        for team, v in hype.items():
            out.append(f"| {team} | {v} | {'달성' if exploded.get(team) else '미달성'} |")
    else:
        out.append("기록 없음")
    out.append("")

    out.append("## 관찰")
    out.append("")
    dup = Counter(m.get("text") for m in notices)
    worst = dup.most_common(1)[0] if dup else None
    if worst and worst[1] > 1:
        out.append(f"- 곡 변경 알림이 같은 곡에 대해 최대 {worst[1]}건 중복되었습니다 ({worst[0]}). 당시 코드가 접속자마다 알림을 올렸기 때문이며, 이후 곡을 바꾼 관리자만 1건 올리도록 수정했습니다.")
    if hype and all(v == 20 for v in hype.values()):
        out.append("- 모든 팀의 피버 게이지가 20에서 멈춰 있습니다. 당시 기본 목표값이 테스트용 20으로 배포되어 곧바로 MAX가 터졌기 때문입니다. 이후 접속자 수 기반 자동 목표로 바꿨습니다.")
    if len(devices) <= 2 and len(notices) > 50:
        out.append(f"- 관객 채팅 기기가 {len(devices)}대에 그친 반면 알림은 {len(notices)}건이었습니다. 알림이 채팅창을 가려 대화가 어려웠던 것으로 보입니다.")
    print("\n".join(out))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
