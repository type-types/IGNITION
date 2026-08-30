#!/usr/bin/env python3
"""배포된 사이트에 관리자, 관객, 무대 화면 브라우저를 붙여 전 기능을 검증한다.

사용법:
  ADMIN_PASSWORD='관리자 비밀번호' python3 tests/e2e.py [사이트 주소]

  사이트 주소를 생략하면 https://ignition-f1bbe.web.app/ 을 쓴다.
  로컬 파일도 된다: python3 tests/e2e.py file:///절대경로/setlist.html

주의: 실제 DB에 테스트 데이터를 쓰고 끝나면 지운다. 공연 중에는 돌리지 않는다.
필요: python3 -m pip install playwright && python3 -m playwright install chromium
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright

URL = (sys.argv[1] if len(sys.argv) > 1 else "https://ignition-f1bbe.web.app/").rstrip("?")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
results = []
errors = []
VP = {"width": 390, "height": 844}


def ok(cond, label):
    results.append((bool(cond), label))
    print(("PASS " if cond else "FAIL ") + label)


async def wipe(page):
    await page.evaluate("""() => {
        ['hearts','chat','chatRate','raffle','hypeCount','hypeExplodedTeams','hypeNoticed','hypeTarget','hypeAuto','pinnedNotice','announcement','setlist'].forEach(p => database.ref(p).remove());
        database.ref('interactionEnabled').set(false);
        database.ref('liveStatus').set({ team: '', song: '', updatedAt: Date.now() });
    }""")
    await page.wait_for_timeout(1500)


async def main():
    if not PASSWORD:
        print("ADMIN_PASSWORD 환경변수가 필요합니다.")
        sys.exit(2)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        admin = await (await b.new_context(viewport=VP, is_mobile=True)).new_page()
        aud = await (await b.new_context(viewport=VP, is_mobile=True)).new_page()
        screen = await (await b.new_context(viewport={"width": 1280, "height": 720})).new_page()
        for name, pg in (("admin", admin), ("aud", aud), ("screen", screen)):
            pg.on("pageerror", lambda e, n=name: errors.append(f"{n}: {e}"))
            # 틀린 비밀번호 시도의 400 응답은 정상이라 제외
            pg.on("console", lambda m, n=name: errors.append(f"{n} console: {m.text}") if m.type == "error" and "status of 400" not in m.text else None)
            pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

        # 관리자 로그인 (Firebase Authentication)
        await admin.goto(URL + "?admin"); await admin.wait_for_timeout(3000)
        await admin.evaluate("window.alert = () => {}; window.confirm = () => true; closeWinner(); closeBest();")
        await admin.fill("#admin-password", "wrong-password"); await admin.press("#admin-password", "Enter"); await admin.wait_for_timeout(2500)
        ok(await admin.is_visible("#error-msg") and not await admin.evaluate("isAdmin"), "[관리자] 틀린 비밀번호 거부")
        await admin.fill("#admin-password", PASSWORD); await admin.click("#password-section button"); await admin.wait_for_timeout(2500)
        ok(await admin.evaluate("isAdmin"), "[관리자] 로그인")
        ok(await admin.evaluate("getComputedStyle(document.getElementById('admin-bar')).display") == "flex", "[관리자] 하단 조작바 표시")
        await wipe(admin)

        await aud.goto(URL); await screen.goto(URL + "?screen"); await aud.wait_for_timeout(3500)
        await aud.evaluate("window.alert = () => {};")

        # 권한: 관객은 관리자 경로에 쓸 수 없다
        denied = await aud.evaluate("""async () => {
            const t = async (fn) => { try { await fn(); return 'ALLOWED'; } catch (e) { return 'DENIED'; } };
            return {
                liveStatus: await t(() => database.ref('liveStatus').set({team:'x', song:'y', updatedAt: Date.now()})),
                interaction: await t(() => database.ref('interactionEnabled').set(true)),
                chatRemove: await t(() => database.ref('chat').remove()),
                winner: await t(() => database.ref('raffle/winner').set({number:'001', drawnAt: Date.now()})),
                setlist: await t(() => database.ref('setlist').set([{team:'x', songs:['a']}])),
                chatNoStamp: await t(() => database.ref('chat').push({text:'x', chatId:'nobody', timestamp: Date.now()})),
                heartJump: await t(() => database.ref('hearts/zzz').set(500)),
            }; }""")
        ok(all(v == "DENIED" for v in denied.values()), f"[권한] 관객의 관리자 경로 쓰기 전부 거부 {denied}")
        # 거부된 쓰기도 SDK가 로컬에 먼저 반영해 자기 화면에만 오버레이가 잠깐 뜬다. 정리한다.
        await aud.wait_for_timeout(1000); await aud.evaluate("closeWinner(); closeBest(); currentWinnerDrawnAt = 0;")

        # 참여 열기, 곡 진행
        await admin.click("#interaction-open-btn"); await aud.wait_for_timeout(1500)
        ok(await aud.evaluate("interactionEnabled"), "[관객] 참여 열림 동기화")
        await admin.evaluate("adminNextSong()"); await aud.wait_for_timeout(1500)
        ok(await aud.inner_text("#current-song") == "빨간 피터", "[관객] 다음 곡 버튼 → 첫 곡 동기화")
        ok(await screen.inner_text("#screen-song") == "빨간 피터", "[무대] Now Playing 동기화")
        ok(await aud.inner_text("#now-next") == "다음: wish", "[관객] 다음 곡 안내")
        ok(await aud.evaluate("presenceCount") >= 3, f"[접속자] {await aud.evaluate('presenceCount')}명")

        # 하트, 리더보드
        for _ in range(3):
            await aud.click(".song-item.active .heart-btn")
        await admin.wait_for_timeout(2000)
        ok(await admin.evaluate("document.querySelector('.song-item.active .heart-count').innerText") == "3", "[관리자] 하트 3개 동기화")
        ok("빨간 피터" in await screen.inner_text("#screen-top3"), "[무대] 하트 TOP 3")

        # 채팅: 곡 알림 1건, 닉네임, 속도 제한, 공지
        n = await aud.evaluate("chatMessages.filter(m => m.type === 'notice').length")
        ok(n == 1, f"[채팅] 곡 변경 알림 정확히 1건 (실제 {n})")
        await aud.evaluate("openChat()"); await aud.fill("#chat-input", "e2e 메시지"); await aud.click("#chat-send-btn"); await admin.wait_for_timeout(1500)
        ok("e2e 메시지" in await admin.evaluate("chatMessages.map(m => m.text).join('|')"), "[관리자] 관객 채팅 수신")
        ok(await aud.evaluate("myNickname") in await admin.inner_text("#chat-messages") if await admin.evaluate("(openChat(), true)") else False, "[채팅] 닉네임 표시")
        await admin.evaluate("closeChat()")
        ok(await aud.evaluate("stampChatRate().then(() => 'ALLOWED').catch(() => 'DENIED')") == "DENIED", "[채팅] 10초 내 재전송 서버 거부")
        await admin.fill("#pinned-input", "e2e 공지"); await admin.evaluate("setPinnedNotice()"); await aud.wait_for_timeout(1500)
        ok("e2e 공지" in await aud.inner_text("#pinned-strip") and "e2e 공지" in await screen.inner_text("#screen-pinned"), "[공지] 관객과 무대에 표시")
        await admin.evaluate("clearPinnedNotice()")
        await aud.evaluate("closeChat()")

        # 추첨
        await aud.evaluate("openRaffle()"); await aud.click("#raffle-join-btn"); await aud.wait_for_timeout(1500)
        ok(await aud.inner_text("#raffle-number") == "001", "[추첨] 번호 001 발급")
        await admin.evaluate("drawWinner()"); await aud.wait_for_timeout(1500)
        ok(await aud.evaluate("document.getElementById('winner-overlay').classList.contains('visible')") and await aud.inner_text("#winner-number") == "001", "[추첨] 당첨 오버레이")
        await aud.evaluate("closeWinner()"); await admin.evaluate("closeWinner()")
        ok("001" in await admin.inner_text("#admin-raffle-drawn"), "[추첨] 관리자 당첨 목록")

        # 피버 타임 (자동 목표 끄고 5로)
        await admin.evaluate("window.prompt = () => '5';"); await admin.evaluate("setHypeTarget()"); await aud.wait_for_timeout(1500)
        ok(await aud.evaluate("hypeTarget") == 5 and not await aud.evaluate("hypeAuto"), "[피버] 수동 목표 5 동기화")
        for _ in range(5):
            await aud.click("#hype-btn")
        await aud.wait_for_timeout(2500)
        ok(await aud.evaluate("document.getElementById('hype-explosion').classList.contains('visible')"), "[관객] MAX 폭발")
        ok(await screen.evaluate("document.getElementById('hype-explosion').classList.contains('visible')"), "[무대] MAX 폭발 동기화")
        for _ in range(16):  # 관객 도달 → 서버 → 관리자 리스너 → 알림 → 채팅 수신까지 왕복이 많아 최대 8초 기다린다
            if await admin.evaluate("chatMessages.filter(m => m.type === 'notice' && m.text.includes('MAX')).length") >= 1:
                break
            await admin.wait_for_timeout(500)
        max_n = await admin.evaluate("chatMessages.filter(m => m.type === 'notice' && m.text.includes('MAX')).length")
        ok(max_n == 1, f"[피버] MAX 알림 정확히 1건 (실제 {max_n})")
        await admin.evaluate("toggleHypeAuto()"); await aud.wait_for_timeout(1200)
        ok(await aud.evaluate("hypeAuto"), "[피버] 자동 목표 복귀")

        # 베스트 곡 발표
        await admin.evaluate("announceBest()"); await aud.wait_for_timeout(1500)
        ok(await aud.evaluate("document.getElementById('best-overlay').classList.contains('visible')"), "[베스트] 관객 오버레이")
        await aud.evaluate("closeBest()"); await admin.evaluate("clearBest()")

        # 셋리스트 편집
        await admin.evaluate("openSetlistEditor()")
        await admin.fill("#editor-text", '[{"team":"e2e팀","members":[],"songs":["곡1","곡2"]}]'); await admin.evaluate("saveSetlist()"); await aud.wait_for_timeout(2000)
        ok(await aud.evaluate("document.querySelectorAll('.song-item').length") == 2, "[편집] 셋리스트 교체 전파")
        await admin.evaluate("database.ref('setlist').remove()"); await aud.wait_for_timeout(2000)
        ok(await aud.evaluate("document.querySelectorAll('.song-item').length") == 24, "[편집] 기본값 복귀")

        # 닫기, 종료, 초기화
        await admin.click("#interaction-close-btn"); await aud.wait_for_timeout(1500)
        ok(await aud.evaluate("document.querySelector('.heart-btn').classList.contains('disabled')"), "[관객] 참여 닫힘")
        await admin.evaluate("updateLive('🎉', '공연이 종료되었습니다')"); await aud.wait_for_timeout(1500)
        ok(await screen.inner_text("#screen-label") == "● THANK YOU", "[무대] 공연 종료")
        await admin.evaluate("resetHearts(); resetRaffle(); resetChat(); resetHype();"); await aud.wait_for_timeout(2000)
        ok(await aud.evaluate("[...document.querySelectorAll('.heart-count')].every(e => e.innerText === '0') && chatMessages.length === 0"), "[관객] 초기화 전파")
        await wipe(admin)
        await admin.evaluate("adminLogout()"); await admin.wait_for_timeout(1000)
        ok(not await admin.evaluate("isAdmin"), "[관리자] 로그아웃")
        await b.close()

    passed = sum(1 for r, _ in results if r)
    print(f"\n{passed}/{len(results)} 통과")
    print("오류:", errors if errors else "없음")
    sys.exit(0 if passed == len(results) and not errors else 1)


asyncio.run(main())
