
// 관리자 계정은 Firebase Authentication에 있다. 비밀번호는 코드에 없고 Firebase가 보관한다.
// 관리자 전용 쓰기(곡 변경, 참여 열기, 삭제 등)는 database.rules.json에서 이 계정의 UID로만 허용한다.
const ADMIN_EMAIL = "admin@ignition-f1bbe.web.app";

// 설정은 Hosting의 /__/firebase/init.js 가 initializeApp까지 해 둔다. 없으면 안내만 띄우고 멈춘다.
if (!firebase.apps.length) {
    document.getElementById('config-banner').classList.add('visible');
    throw new Error('Firebase 설정이 없습니다. Hosting 또는 hosting 에뮬레이터로 여세요.');
}
const database = firebase.database();
const auth = firebase.auth();

let currentTeam = '';
let currentSong = '';
let isAdmin = false;
let interactionEnabled = false; // 관객 참여 기능 활성화 여부 (하트, 채팅, 추첨)

// 배포 주소 (무대 화면 QR)
const SITE_URL = 'https://ignition-f1bbe.web.app/';

// 셋리스트 기본값. DB의 setlist 경로에 값이 있으면 그것을 쓴다 (관리자 편집).
const DEFAULT_PLAYLIST = [
    {
        team: "피버스 Phoebus",
        members: [
            { part: "Vocal", names: "방준혁 우지성 박한음" },
            { part: "Guitar", names: "김세진 김아인 김유리 오민호" },
            { part: "Keyboard", names: "백다인" },
            { part: "Bass", names: "김남휘 김재석 박진원 최원호" },
            { part: "Drum", names: "김동욱 강화윤 이도헌" }
        ],
        songs: ["빨간 피터", "wish", "KIDS", "우리의 밤은 당신의 낮보다 아름답다", "rengoku.", "담배가게 아가씨"]
    },
    {
        team: "피터스앤진스 Peters and Jeans",
        members: [
            { part: "Vocal", names: "박시현" },
            { part: "Guitar", names: "박지원" },
            { part: "Keyboard", names: "박민석" },
            { part: "Bass", names: "한지우" },
            { part: "Drum", names: "안승환" }
        ],
        songs: ["Drive It Like You Stole It", "Cigarettes & Alcohol", "곁에", "연못", "Radio", "Supernatural"]
    },
    {
        team: "히포루 Hipporu",
        members: [
            { part: "Vocal", names: "이해인" },
            { part: "Guitar", names: "한재민 장재윤" },
            { part: "Keyboard", names: "박이랑" },
            { part: "Bass", names: "정서현" },
            { part: "Drum", names: "엄지훈" }
        ],
        songs: ["Last Day", "새벽별", "오리날다", "Blue Bird", "네버엔딩스토리", "몽유병"]
    },
    {
        team: "인스페이즈 In Spades",
        members: [
            { part: "Vocal", names: "배지원 고준영" },
            { part: "Guitar", names: "한성민 홍지호" },
            { part: "Bass", names: "황수정" },
            { part: "Drum", names: "송하민" }
        ],
        songs: ["폭포", "Mikael", "악어모자", "무리무리!", "녹슬지 않을 날", "Not a Dream"]
    }
];

let playlist = DEFAULT_PLAYLIST;
let heartRefs = []; // 셋리스트 재구성 시 해제할 하트 리스너

// DB 셋리스트 감시. 형식이 맞으면 교체하고 화면을 다시 만든다.
let setlistLoaded = false;
database.ref('setlist').on('value', (snapshot) => {
    const val = snapshot.val();
    const next = validateSetlist(val) ? val : DEFAULT_PLAYLIST;
    const changed = JSON.stringify(next) !== JSON.stringify(playlist);
    playlist = next;
    if (changed || !setlistLoaded) rebuildSetlist();
    setlistLoaded = true;
});

function validateSetlist(val) {
    if (!Array.isArray(val) || val.length === 0) return false;
    return val.every(t => t && typeof t.team === 'string' && t.team.trim()
        && Array.isArray(t.songs) && t.songs.length > 0 && t.songs.every(s => typeof s === 'string' && s.trim())
        && Array.isArray(t.members || []) && (t.members || []).every(m => m && typeof m.part === 'string' && typeof m.names === 'string'));
}

function rebuildSetlist() {
    heartRefs.forEach(ref => ref.off());
    heartRefs = [];
    generateSetlist();
    setupHeartListeners();
    updateDisplay();
    updateInteractionUI();
}

// 곡 순서 헬퍼
function flatPlaylist() {
    const out = [];
    playlist.forEach(t => t.songs.forEach(s => out.push({ team: t.team, song: s })));
    return out;
}
function currentIndex() {
    return flatPlaylist().findIndex(x => x.team === currentTeam && x.song === currentSong);
}

// ========== 접속 상태와 접속자 수 ==========
// 기기마다 고정 ID를 두고 presence/{id}에 접속 여부를 남긴다. 연결이 끊기면 서버가 지운다.
const clientId = (() => {
    let id = localStorage.getItem('ignition_client_id');
    if (!id) {
        id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('ignition_client_id', id);
    }
    return id;
})();
let presenceCount = 0;
let hasConnectedOnce = false;

database.ref('.info/connected').on('value', (snapshot) => {
    const connected = snapshot.val() === true;
    // 첫 연결 전에는 배너를 띄우지 않는다 (로딩 중 깜빡임 방지)
    document.getElementById('conn-banner').classList.toggle('visible', hasConnectedOnce && !connected);
    if (connected) {
        hasConnectedOnce = true;
        const ref = database.ref('presence/' + clientId);
        ref.onDisconnect().remove();
        ref.set(true);
    }
});

database.ref('presence').on('value', (snapshot) => {
    presenceCount = Object.keys(snapshot.val() || {}).length;
    updatePresenceUI();
    updateHypeUI(); // 자동 목표는 접속자 수를 따른다
});

function updatePresenceUI() {
    document.getElementById('presence-count').innerText = presenceCount > 0 ? `🟢 지금 ${presenceCount}명 접속 중` : '';
    const adminEl = document.getElementById('admin-presence');
    if (adminEl) adminEl.innerText = `접속 ${presenceCount}명`;
    renderScreen();
}

// 하트 순위 (리더보드, 베스트 곡 발표, 무대 화면 공용)
function rankedSongs() {
    const songs = [];
    playlist.forEach(team => {
        team.songs.forEach(song => {
            const hearts = localHeartCounts[generateSongId(team.team, song)] || 0;
            if (hearts > 0) songs.push({ song, team: team.team.split(' ')[0], hearts });
        });
    });
    return songs.sort((a, b) => b.hearts - a.hearts);
}
function formatHearts(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

// ========== 무대 화면 모드 (?screen) ==========
const isScreenMode = new URLSearchParams(window.location.search).has('screen');
let screenRaf = null;
function initScreenMode() {
    if (!isScreenMode) return;
    document.body.classList.add('screen-mode');
    document.getElementById('screen-url').innerText = SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (window.QRCode) new QRCode(document.getElementById('screen-qr'), { text: SITE_URL, width: 104, height: 104, correctLevel: QRCode.CorrectLevel.M });
    renderScreen();
}
// 여러 리스너가 연달아 호출해도 프레임당 한 번만 그린다
function renderScreen() {
    if (!isScreenMode || screenRaf) return;
    screenRaf = requestAnimationFrame(() => { screenRaf = null; renderScreenNow(); });
}
function renderScreenNow() {
    const playing = !!(currentTeam && currentSong && currentTeam !== '🎉');
    const now = document.querySelector('.screen-now');
    now.classList.toggle('idle', !playing);
    document.getElementById('screen-label').innerText = playing ? '● NOW PLAYING' : (currentTeam === '🎉' ? '● THANK YOU' : '● STAND BY');
    document.getElementById('screen-team').innerText = playing ? currentTeam : '';
    document.getElementById('screen-song').innerText = playing ? currentSong : (currentTeam === '🎉' ? currentSong : '공연 준비 중');
    document.getElementById('screen-next').innerText = playing ? document.getElementById('now-next').innerText : '';

    document.getElementById('screen-hype').classList.toggle('hidden', !playing);
    document.getElementById('screen-hype-percent').innerText = document.getElementById('hype-percent').innerText;
    const fill = document.getElementById('screen-hype-fill');
    const srcFill = document.getElementById('hype-fill');
    fill.style.width = srcFill.style.width;
    fill.className = srcFill.className;

    const top3 = rankedSongs().slice(0, 3);
    document.getElementById('screen-top3').innerHTML = top3.length
        ? top3.map((s, i) => `<div class="screen-top3-item"><span class="medal">${['🥇', '🥈', '🥉'][i]}</span><span class="song">${escapeHtml(s.song)} <span style="color:#888;font-size:0.8em;">${escapeHtml(s.team)}</span></span><span class="hearts">❤️ ${formatHearts(s.hearts)}</span></div>`).join('')
        : '<div class="screen-top3-empty">하트를 눌러 응원해 주세요</div>';

    const pinned = document.getElementById('chat-pinned');
    const sp = document.getElementById('screen-pinned');
    sp.innerText = pinned.innerText;
    sp.classList.toggle('visible', pinned.classList.contains('visible'));
    const recent = chatMessages.filter(m => !m.hidden).slice(-6);
    document.getElementById('screen-chat').innerHTML = recent.map(m => {
        if (m.type === 'notice') return `<div class="screen-chat-item notice">${escapeHtml(m.text)}</div>`;
        if (m.type === 'donate') return `<div class="screen-chat-item donate">💸 ${m.amount.toLocaleString()}원 후원!</div>`;
        return `<div class="screen-chat-item"><span class="name">${escapeHtml(nicknameOf(m.chatId))}</span>${escapeHtml(m.text)}</div>`;
    }).join('');

    document.getElementById('screen-presence').innerText = presenceCount > 0 ? `🟢 ${presenceCount}명 참여 중` : '';
}

// ========== 베스트 곡 발표 ==========
let currentBestAt = 0;
database.ref('announcement').on('value', (snapshot) => {
    const data = snapshot.val();
    const statusEl = document.getElementById('admin-best-status');
    if (statusEl) statusEl.innerText = data && data.type === 'best' ? '(발표 중)' : '';
    if (!data || data.type !== 'best' || !Array.isArray(data.items)) {
        document.getElementById('best-overlay').classList.remove('visible');
        return;
    }
    if (localStorage.getItem('ignition_seen_best') === String(data.at)) return;
    if (Date.now() - (data.at || 0) > 2 * 60 * 60 * 1000) return;
    currentBestAt = data.at || 0;
    document.getElementById('best-list').innerHTML = data.items.slice(0, 3).map((s, i) =>
        `<div class="best-item rank-${i + 1}"><span class="best-rank">${['🥇', '🥈', '🥉'][i]}</span><div><div class="best-song">${escapeHtml(s.song)}</div><div class="best-team">${escapeHtml(s.team)}</div></div><span class="best-hearts">❤️ ${formatHearts(s.hearts)}</span></div>`
    ).join('');
    document.getElementById('best-overlay').classList.add('visible');
});
function announceBest() {
    const top = rankedSongs().slice(0, 3);
    if (top.length === 0) { alert('아직 하트가 없습니다.'); return; }
    if (!confirm(`베스트 곡 TOP ${top.length}을 모든 화면에 발표할까요?\n1위: ${top[0].song} (❤️ ${top[0].hearts})`)) return;
    database.ref('announcement').set({ type: 'best', items: top, at: Date.now() });
}
function clearBest() {
    database.ref('announcement').remove();
}
function closeBest() {
    if (currentBestAt) localStorage.setItem('ignition_seen_best', String(currentBestAt));
    document.getElementById('best-overlay').classList.remove('visible');
}

// ========== 셋리스트 편집 (관리자) ==========
function openSetlistEditor() {
    document.getElementById('editor-text').value = JSON.stringify(playlist, null, 2);
    document.getElementById('editor-error').innerText = '';
    document.getElementById('editor-overlay').classList.add('visible');
}
function closeSetlistEditor(event) {
    if (!event || event.target === event.currentTarget) document.getElementById('editor-overlay').classList.remove('visible');
}
function loadDefaultSetlist() {
    document.getElementById('editor-text').value = JSON.stringify(DEFAULT_PLAYLIST, null, 2);
    document.getElementById('editor-error').innerText = '';
}
function saveSetlist() {
    const errorEl = document.getElementById('editor-error');
    let parsed;
    try {
        parsed = JSON.parse(document.getElementById('editor-text').value);
    } catch (e) {
        errorEl.innerText = 'JSON 형식 오류: ' + e.message;
        return;
    }
    if (!validateSetlist(parsed)) {
        errorEl.innerText = '형식이 맞지 않습니다. 각 팀은 team(문자열), members([{part, names}]), songs([문자열]) 을 가져야 합니다.';
        return;
    }
    if (!confirm('셋리스트를 저장하면 모든 화면이 즉시 바뀝니다. 저장할까요?')) return;
    database.ref('setlist').set(parsed).then(() => {
        closeSetlistEditor();
        alert('셋리스트가 저장되었습니다.');
    }).catch(e => { errorEl.innerText = '저장 실패: ' + e.message; });
}

// 페이지 로드 시 셋리스트 생성
function generateSetlist() {
    const setlistDiv = document.getElementById('setlist');
    setlistDiv.innerHTML = '';

    playlist.forEach(item => {
        const block = document.createElement('div');
        block.className = 'team-block';
        block.dataset.team = item.team;

        let songsHTML = '';
        item.songs.forEach((song, index) => {
            const songId = generateSongId(item.team, song);
            songsHTML += `
                <div class="song-item" data-team="${item.team}" data-song="${song}" data-song-id="${songId}" onclick="handleSongClick('${item.team}', '${song.replace(/'/g, "\\'")}')">
                    <div class="song-number">${index + 1}</div>
                    <div class="song-title">${song}</div>
                    <div class="playing-icon">🎵</div>
                    <button class="heart-btn" onclick="event.stopPropagation(); addHeart('${songId}', this)">
                        ❤️ <span class="heart-count" id="heart-${songId}">0</span>
                    </button>
                </div>
            `;
        });

        block.innerHTML = `
            <div class="team-header">
                <span class="team-name">${item.team}</span>
                <span class="team-badge">NOW</span>
            </div>
            <div class="team-members">
                ${(item.members || []).map(m => {
                    const nameList = m.names.split(' ');
                    const formatted = nameList.length >= 3
                        ? nameList.map((n, i) => (i > 0 && i % 2 === 0) ? '<br>' + n : n).join(' ').replace(/ <br>/g, '<br>')
                        : m.names;
                    return `<div class="member-item"><span class="part">${m.part}</span><span class="names">${formatted}</span></div>`;
                }).join('')}
            </div>
            <div class="song-list">${songsHTML}</div>
        `;

        setlistDiv.appendChild(block);
    });
}

// 곡 클릭 핸들러 (관리자만)
function handleSongClick(team, song) {
    if (isAdmin) {
        updateLive(team, song);
    }
}

// Firebase 실시간 업데이트 감시
let liveUpdatedAt = 0;
database.ref('liveStatus').on('value', (snapshot) => {
    const data = snapshot.val();
    const prevTeam = currentTeam;
    liveUpdatedAt = data && data.updatedAt ? data.updatedAt : 0;

    if (data) {
        currentTeam = data.team || '';
        currentSong = data.song || '';
    } else {
        currentTeam = '';
        currentSong = '';
    }
    if (currentTeam !== prevTeam) {
        watchTeamHype(currentTeam && currentTeam !== '🎉' ? currentTeam : null);
    }
    updateDisplay();
});

// 화면 업데이트
function updateDisplay() {
    const nowPlaying = document.getElementById('now-playing');
    const currentTeamEl = document.getElementById('current-team');
    const currentSongEl = document.getElementById('current-song');

    // 현재 재생 중 표시
    if (currentTeam && currentSong && currentTeam !== '🎉') {
        nowPlaying.classList.add('visible');
        document.body.classList.add('has-now-playing');
        currentTeamEl.innerText = currentTeam;
        currentSongEl.innerText = currentSong;
    } else if (currentTeam === '🎉') {
        nowPlaying.classList.add('visible');
        document.body.classList.add('has-now-playing');
        currentTeamEl.innerText = '';
        currentSongEl.innerText = currentSong;
    } else {
        nowPlaying.classList.remove('visible');
        document.body.classList.remove('has-now-playing');
    }

    // 모든 곡 초기화
    document.querySelectorAll('.song-item').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelectorAll('.team-block').forEach(block => {
        block.classList.remove('has-active');
    });

    // 현재 곡 강조
    if (currentTeam && currentSong) {
        const activeItem = document.querySelector(`.song-item[data-team="${currentTeam}"][data-song="${currentSong}"]`);
        if (activeItem) {
            activeItem.classList.add('active');
            activeItem.closest('.team-block').classList.add('has-active');

            // 현재 곡으로 스크롤 (부드럽게)
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // 피버 타임 게이지는 곡이 연주 중일 때만
    const playing = !!(currentTeam && currentSong && currentTeam !== '🎉');
    document.getElementById('hype-gauge').style.display = playing ? '' : 'none';

    // 다음 곡 안내
    const nextEl = document.getElementById('now-next');
    if (playing) {
        const flat = flatPlaylist();
        const next = flat[currentIndex() + 1];
        if (!next) nextEl.innerText = '마지막 곡';
        else if (next.team === currentTeam) nextEl.innerText = `다음: ${next.song}`;
        else nextEl.innerText = `다음: ${next.team.split(' ')[0]} - ${next.song}`;
    } else {
        nextEl.innerText = '';
    }
    updateElapsed();

    // 관리자 조작바의 현재 곡
    const barNow = document.getElementById('admin-bar-now');
    if (currentTeam === '🎉') barNow.innerText = '공연 종료';
    else if (playing) barNow.innerText = `${currentTeam.split(' ')[0]} - ${currentSong}`;
    else barNow.innerText = '대기 중';

    syncNowPlayingPadding();
    renderScreen();
}

// 현재 곡 경과 시간 (mm:ss)
function updateElapsed() {
    const el = document.getElementById('now-elapsed');
    if (!(currentTeam && currentSong && currentTeam !== '🎉') || !liveUpdatedAt) { el.innerText = ''; return; }
    const sec = Math.max(0, Math.floor((Date.now() - liveUpdatedAt) / 1000));
    el.innerText = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')} 경과`;
}
setInterval(updateElapsed, 1000);

// 상단 고정 바 높이만큼 본문 여백을 맞춘다 (게이지 접기/펼치기로 높이가 변함)
function syncNowPlayingPadding() {
    const bar = document.getElementById('now-playing');
    document.body.style.paddingTop = bar.classList.contains('visible') ? (bar.offsetHeight + 20) + 'px' : '';
}
window.addEventListener('resize', syncNowPlayingPadding);

// URL 파라미터 확인
const urlParams = new URLSearchParams(window.location.search);
const isAdminMode = urlParams.has('admin');

if (isAdminMode) {
    document.getElementById('admin-password').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') adminLogin();
    });
}

// 관리자 로그인 (Firebase Authentication 이메일+비밀번호)
async function adminLogin() {
    const input = document.getElementById('admin-password');
    const errorMsg = document.getElementById('error-msg');
    try {
        await auth.signInWithEmailAndPassword(ADMIN_EMAIL, input.value);
        // 성공 처리는 onAuthStateChanged에서
    } catch (e) {
        const messages = {
            'auth/network-request-failed': '네트워크 오류입니다. 다시 시도하세요.',
            'auth/too-many-requests': '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
            'auth/operation-not-allowed': '관리자 로그인이 아직 설정되지 않았습니다.',
            'auth/configuration-not-found': '관리자 로그인이 아직 설정되지 않았습니다.',
        };
        errorMsg.innerText = messages[e.code] || '비밀번호가 올바르지 않습니다.';
        errorMsg.style.display = 'block';
        input.value = '';
        setTimeout(() => { errorMsg.style.display = 'none'; }, 2000);
    }
}

function adminLogout() {
    auth.signOut();
}

// 로그인 상태에 따라 관리자 UI를 켜고 끈다. 새로고침해도 로그인이 유지된다.
auth.onAuthStateChanged((user) => {
    isAdmin = !!user;
    if (isAdminMode) {
        document.getElementById('password-section').style.display = isAdmin ? 'none' : 'block';
    }
    document.getElementById('admin-controls').classList.toggle('visible', isAdmin);
    document.getElementById('setlist').classList.toggle('admin-mode', isAdmin);
    document.body.classList.toggle('is-admin', isAdmin);
    syncNowPlayingPadding();
    renderChatMessages(); // 관리자 여부에 따라 채팅 숨김 버튼 표시가 달라진다
});

// Firebase 업데이트 (관리자). 곡 변경 알림은 곡을 바꾼 관리자만 한 번 올린다.
let lastLiveStatus = null; // 되돌리기용 (직전 상태)
function updateLive(teamName, songName) {
    const changed = teamName !== currentTeam || songName !== currentSong;
    lastLiveStatus = { team: currentTeam, song: currentSong };
    document.getElementById('admin-bar-undo').disabled = false;
    database.ref('liveStatus').set({
        team: teamName,
        song: songName,
        updatedAt: Date.now()
    });
    if (changed && teamName && songName && teamName !== '🎉') {
        addSongChangeNotice(teamName, songName);
    }
}

// 관리자 조작바: 이전 곡, 다음 곡, 되돌리기
function adminNextSong() {
    if (currentTeam === '🎉') return;
    const flat = flatPlaylist();
    const next = flat[currentIndex() + 1];
    if (next) updateLive(next.team, next.song);
    else if (confirm('마지막 곡입니다. 공연 종료로 전환할까요?')) updateLive('🎉', '공연이 종료되었습니다');
}
function adminPrevSong() {
    const flat = flatPlaylist();
    if (currentTeam === '🎉') { const last = flat[flat.length - 1]; updateLive(last.team, last.song); return; }
    const i = currentIndex();
    if (i > 0) updateLive(flat[i - 1].team, flat[i - 1].song);
    else if (i === 0) updateLive('', '');
}
function adminUndoLive() {
    if (!lastLiveStatus) return;
    updateLive(lastLiveStatus.team, lastLiveStatus.song); // 되돌린 뒤에는 다시 되돌릴 수 있다
}

// 곡 ID 생성 (Firebase 키로 사용)
function generateSongId(team, song) {
    return btoa(encodeURIComponent(team + '_' + song)).replace(/[^a-zA-Z0-9]/g, '');
}

// 하트 로컬 버퍼 (디바운싱용)
const heartBuffer = {};
const localHeartCounts = {};
let flushTimeout = null;

// 하트 추가 (최적화 버전)
function addHeart(songId, btnElement) {
    // 참여 기능이 닫혀있으면 무시
    if (!interactionEnabled) return;

    // 버튼 애니메이션
    btnElement.classList.add('clicked');
    setTimeout(() => btnElement.classList.remove('clicked'), 300);

    // 플로팅 하트 효과
    createFloatingHeart(btnElement);

    // 로컬 카운트 즉시 증가 (UI 반응성)
    localHeartCounts[songId] = (localHeartCounts[songId] || 0) + 1;
    updateHeartDisplay(songId);

    // 버퍼에 추가
    heartBuffer[songId] = (heartBuffer[songId] || 0) + 1;

    // 디바운싱: 500ms 후에 한번에 전송
    clearTimeout(flushTimeout);
    flushTimeout = setTimeout(flushHearts, 500);
}

// 버퍼된 하트를 Firebase에 전송
function flushHearts() {
    const updates = {};
    Object.keys(heartBuffer).forEach(songId => {
        if (heartBuffer[songId] > 0) {
            // 각 곡별로 transaction
            const count = heartBuffer[songId];
            database.ref('hearts/' + songId).transaction(current => (current || 0) + count);
        }
    });
    // 버퍼 초기화
    Object.keys(heartBuffer).forEach(k => heartBuffer[k] = 0);
}

// 하트 표시 업데이트
function updateHeartDisplay(songId) {
    const countEl = document.getElementById('heart-' + songId);
    if (countEl) {
        const count = localHeartCounts[songId] || 0;
        countEl.innerText = count >= 1000 ? (count / 1000).toFixed(1) + 'k' : count;
    }
}

// 플로팅 하트 생성
function createFloatingHeart(btnElement) {
    const rect = btnElement.getBoundingClientRect();
    const heart = document.createElement('div');
    heart.className = 'floating-heart';
    heart.innerText = '❤️';
    heart.style.left = rect.left + rect.width / 2 - 12 + 'px';
    heart.style.top = rect.top + 'px';
    document.body.appendChild(heart);
    setTimeout(() => heart.remove(), 1000);
}

// 하트 수 실시간 감시 (곡별로 개별 리스너 - 최적화)
function setupHeartListeners() {
    playlist.forEach(item => {
        item.songs.forEach(song => {
            const songId = generateSongId(item.team, song);
            const ref = database.ref('hearts/' + songId);
            heartRefs.push(ref);
            ref.on('value', (snapshot) => {
                const serverCount = snapshot.val();
                // 서버 값이 로컬보다 크면 서버 값 사용 (다른 사용자의 하트 반영).
                // 값이 지워졌으면(관리자 초기화) 0으로 되돌린다.
                if (serverCount === null || serverCount > (localHeartCounts[songId] || 0)) {
                    localHeartCounts[songId] = serverCount || 0;
                    updateHeartDisplay(songId);
                    if (document.getElementById('leaderboard-overlay').classList.contains('visible')) updateLeaderboard();
                    renderScreen();
                }
            });
        });
    });
}

// 하트 전체 초기화
function resetHearts() {
    if (!confirm('정말 모든 하트를 초기화할까요? 이 작업은 되돌릴 수 없습니다.')) return;

    // 버퍼에 남아있는 하트 전송 취소
    clearTimeout(flushTimeout);
    Object.keys(heartBuffer).forEach(k => heartBuffer[k] = 0);

    // Firebase 삭제
    database.ref('hearts').remove();

    // 로컬 카운트 초기화
    Object.keys(localHeartCounts).forEach(k => localHeartCounts[k] = 0);
    document.querySelectorAll('.heart-count').forEach(el => el.innerText = '0');
    alert('하트가 초기화되었습니다.');
}

// 리더보드 열기
function openLeaderboard() {
    updateLeaderboard();
    document.getElementById('leaderboard-overlay').classList.add('visible');
}

// 리더보드 닫기
function closeLeaderboard(event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById('leaderboard-overlay').classList.remove('visible');
    }
}

// 곡 정보 찾기
function findSongInfo(songId) {
    for (const team of playlist) {
        for (const song of team.songs) {
            if (generateSongId(team.team, song) === songId) {
                return { song, team: team.team.split(' ')[0] }; // 팀명 첫 단어만
            }
        }
    }
    return null;
}

// 리더보드 업데이트
function updateLeaderboard() {
    const content = document.getElementById('leaderboard-content');

    const songs = rankedSongs();

    if (songs.length === 0) {
        content.innerHTML = '<div class="leaderboard-empty">아직 하트가 없습니다</div>';
        return;
    }

    // TOP 10만 표시
    const top10 = songs.slice(0, 10);
    content.innerHTML = top10.map((item, index) => {
        const rankClass = index < 3 ? `rank-${index + 1}` : '';
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        return `
            <div class="leaderboard-item ${rankClass}">
                <div class="leaderboard-rank">${medal || (index + 1)}</div>
                <div class="leaderboard-info">
                    <div class="leaderboard-song">${item.song}</div>
                    <div class="leaderboard-team">${item.team}</div>
                </div>
                <div class="leaderboard-hearts">❤️ ${item.hearts >= 1000 ? (item.hearts/1000).toFixed(1) + 'k' : item.hearts}</div>
            </div>
        `;
    }).join('');
}

// ========== 추첨 기능 ==========
let myRaffleNumber = localStorage.getItem('ignition_raffle_number');
let raffleParticipants = {};

// 추첨 모달 열기
function openRaffle() {
    updateRaffleUI();
    document.getElementById('raffle-overlay').classList.add('visible');
    // 관리자면 관리자 패널 표시
    if (isAdmin) {
        document.getElementById('raffle-admin').style.display = 'block';
    }
}

// 추첨 모달 닫기
function closeRaffle(event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById('raffle-overlay').classList.remove('visible');
    }
}

// 추첨 참여
function joinRaffle() {
    // 참여 기능이 닫혀있으면 무시
    if (!interactionEnabled) {
        alert('아직 추첨에 참여할 수 없습니다.');
        return;
    }

    if (myRaffleNumber) return; // 이미 참여함

    // 새 번호 발급 (001~999)
    database.ref('raffle/nextNumber').transaction(current => {
        return (current || 0) + 1;
    }, (error, committed, snapshot) => {
        if (committed) {
            const number = snapshot.val();
            const paddedNumber = String(number).padStart(3, '0');
            myRaffleNumber = paddedNumber;
            localStorage.setItem('ignition_raffle_number', paddedNumber);

            // Firebase에 참여자 등록
            database.ref('raffle/participants/' + paddedNumber).set({
                joinedAt: Date.now()
            });

            updateRaffleUI();
        }
    });
}

// 추첨 UI 업데이트
function updateRaffleUI() {
    const fab = document.getElementById('raffle-fab');
    const header = document.getElementById('raffle-header');
    const status = document.getElementById('raffle-status');
    const numberEl = document.getElementById('raffle-number');
    const joinBtn = document.getElementById('raffle-join-btn');
    const countEl = document.getElementById('raffle-participant-count');

    if (myRaffleNumber) {
        fab.classList.add('joined');
        fab.innerText = '✓';
        header.classList.add('joined');
        header.querySelector('h2').innerText = '🎟️ 참여 완료!';
        header.querySelector('p').innerText = '당첨을 기다려주세요';
        status.innerText = '내 번호';
        numberEl.innerText = myRaffleNumber;
        joinBtn.disabled = true;
        joinBtn.classList.remove('interaction-disabled');
        joinBtn.innerText = '참여 완료!';
    } else if (!interactionEnabled) {
        // 참여 기능이 닫혀있는 경우
        fab.classList.remove('joined');
        fab.innerText = '🎟️';
        header.classList.remove('joined');
        status.innerText = '관리자가 열면 참여할 수 있어요';
        numberEl.innerText = '-';
        joinBtn.disabled = true;
        joinBtn.classList.add('interaction-disabled');
        joinBtn.innerText = '아직 참여할 수 없습니다';
    } else {
        fab.classList.remove('joined');
        fab.innerText = '🎟️';
        header.classList.remove('joined');
        status.innerText = '참여하면 번호를 받아요';
        numberEl.innerText = '-';
        joinBtn.disabled = false;
        joinBtn.classList.remove('interaction-disabled');
        joinBtn.innerText = '추첨 참여하기';
    }

    // 내 번호가 이미 당첨된 경우
    if (myRaffleNumber && raffleDrawn[myRaffleNumber]) {
        status.innerText = '🎊 당첨된 번호입니다';
    }

    // 참여자 수 표시
    const count = Object.keys(raffleParticipants).length;
    countEl.innerText = `현재 참여자: ${count}명`;

    // 관리자: 당첨 목록
    const drawnEl = document.getElementById('admin-raffle-drawn');
    if (drawnEl) {
        const drawn = Object.keys(raffleDrawn).sort();
        drawnEl.innerText = drawn.length ? `🏆 당첨: ${drawn.join(', ')} (남은 참여자 ${count - drawn.length}명)` : '';
    }

    // 관리자 컨트롤의 참여자 수도 업데이트
    const adminCountEl = document.getElementById('admin-raffle-count');
    if (adminCountEl) {
        adminCountEl.innerText = `(${count}명 참여중)`;
    }
}

// 참여자 실시간 감시
database.ref('raffle/participants').on('value', (snapshot) => {
    raffleParticipants = snapshot.val() || {};
    updateRaffleUI();
});

// 당첨자 추첨 (관리자)
// 이미 당첨된 번호 (raffle/drawn/{번호}: 시각). 경품이 여러 개면 추첨을 반복한다.
let raffleDrawn = {};
database.ref('raffle/drawn').on('value', (snapshot) => {
    raffleDrawn = snapshot.val() || {};
    updateRaffleUI();
});

function drawWinner() {
    const numbers = Object.keys(raffleParticipants).filter(n => !raffleDrawn[n]);
    if (numbers.length === 0) {
        alert(Object.keys(raffleParticipants).length === 0 ? '참여자가 없습니다.' : '남은 참여자가 없습니다. 모두 당첨되었습니다.');
        return;
    }

    // 랜덤 추첨
    const winnerNumber = numbers[Math.floor(Math.random() * numbers.length)];
    const drawnAt = Date.now();

    // 당첨 기록과 최신 당첨 번호 저장 (모든 접속자에게 알림)
    database.ref('raffle/drawn/' + winnerNumber).set(drawnAt);
    database.ref('raffle/winner').set({
        number: winnerNumber,
        drawnAt: drawnAt
    });
}

// 당첨 결과 감시
// 당첨 결과 감시. 이미 닫은 결과나 2시간 지난 결과는 다시 띄우지 않는다.
let currentWinnerDrawnAt = 0;
database.ref('raffle/winner').on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data || !data.number) return;
    if (localStorage.getItem('ignition_seen_winner') === String(data.drawnAt)) return;
    if (Date.now() - (data.drawnAt || 0) > 2 * 60 * 60 * 1000) return;
    currentWinnerDrawnAt = data.drawnAt || 0;
    showWinner(data.number);
});

// 당첨 결과 표시
function showWinner(number) {
    const winnerModal = document.querySelector('.winner-modal');
    const winnerIcon = document.getElementById('winner-icon');
    const myNumberDisplay = document.getElementById('my-number-display');
    const winnerResult = document.getElementById('winner-result');

    // 당첨 번호 표시
    document.getElementById('winner-number').innerText = number;

    // 내 번호 표시
    if (myRaffleNumber) {
        myNumberDisplay.innerText = myRaffleNumber;

        // 당첨 여부 확인
        if (myRaffleNumber === number) {
            winnerModal.classList.add('is-winner');
            winnerIcon.innerText = '🎉';
            winnerResult.className = 'winner-result is-winner';
            winnerResult.innerText = '🎊 축하합니다! 당첨되셨습니다! 🎊';
        } else {
            winnerModal.classList.remove('is-winner');
            winnerIcon.innerText = '🎊';
            winnerResult.className = 'winner-result';
            winnerResult.innerText = '';
        }
    } else {
        myNumberDisplay.innerText = '미참여';
        winnerModal.classList.remove('is-winner');
        winnerIcon.innerText = '🎊';
        winnerResult.className = 'winner-result';
        winnerResult.innerText = '';
    }

    document.getElementById('winner-overlay').classList.add('visible');
    closeRaffle();
}

// 당첨 모달 닫기
function closeWinner() {
    if (currentWinnerDrawnAt) localStorage.setItem('ignition_seen_winner', String(currentWinnerDrawnAt));
    document.getElementById('winner-overlay').classList.remove('visible');
    // 다음 추첨을 위해 상태 초기화
    document.querySelector('.winner-modal').classList.remove('is-winner');
}

// 참여자 초기화 (관리자)
function resetRaffle() {
    if (!confirm('모든 참여자를 초기화할까요? 이 작업은 되돌릴 수 없습니다.')) return;

    database.ref('raffle').remove();
    localStorage.removeItem('ignition_raffle_number');
    myRaffleNumber = null;
    updateRaffleUI();
    alert('초기화되었습니다.');
}

// ========== 채팅 기능 ==========
let chatMessages = [];
let lastReadTimestamp = parseInt(localStorage.getItem('ignition_chat_last_read') || '0');
let chatCooldown = false;
let myChatId = localStorage.getItem('ignition_chat_id');
let isChatOpen = false;
let chatEnabled = true;
let chatVisible = true;

// 고유 채팅 ID 생성 (처음 한번만)
if (!myChatId) {
    myChatId = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem('ignition_chat_id', myChatId);
}

// chatId에서 만드는 익명 닉네임 (같은 기기는 항상 같은 이름)
const NICK_ADJ = ['붉은', '푸른', '노란', '보라', '하얀', '검은', '초록', '은빛', '금빛', '반짝이는', '조용한', '신나는', '졸린', '용감한', '수줍은', '날쌘'];
const NICK_ANIMAL = ['여우', '고래', '토끼', '호랑이', '펭귄', '수달', '고양이', '늑대', '부엉이', '돌고래', '판다', '사슴', '햄스터', '독수리', '거북이', '다람쥐'];
function nicknameOf(chatId) {
    if (!chatId) return '';
    let h = 0;
    for (let i = 0; i < chatId.length; i++) h = (h * 31 + chatId.charCodeAt(i)) >>> 0;
    return NICK_ADJ[h % NICK_ADJ.length] + ' ' + NICK_ANIMAL[Math.floor(h / NICK_ADJ.length) % NICK_ANIMAL.length];
}
const myNickname = nicknameOf(myChatId);

// 고정 공지 (관리자)
database.ref('pinnedNotice').on('value', (snapshot) => {
    const data = snapshot.val();
    const text = data && data.text ? data.text : '';
    const strip = document.getElementById('pinned-strip');
    const inChat = document.getElementById('chat-pinned');
    strip.innerText = text ? '📌 ' + text : '';
    strip.classList.toggle('visible', !!text);
    inChat.innerText = text ? '📌 ' + text : '';
    inChat.classList.toggle('visible', !!text);
    const input = document.getElementById('pinned-input');
    if (input && document.activeElement !== input) input.value = text;
    renderScreen();
});
function setPinnedNotice() {
    const text = document.getElementById('pinned-input').value.trim();
    if (!text) { alert('공지 내용을 입력하세요.'); return; }
    database.ref('pinnedNotice').set({ text: text, timestamp: Date.now() });
}
function clearPinnedNotice() {
    database.ref('pinnedNotice').remove();
}

// 서버 측 속도 제한: 메시지를 쓰기 전에 chatRate/{chatId}에 서버 시각을 남긴다.
// 규칙이 10초 안의 재기록을 거부하고, 메시지는 5초 안에 남긴 도장이 있어야 받아준다.
function stampChatRate() {
    return database.ref('chatRate/' + myChatId).set(firebase.database.ServerValue.TIMESTAMP);
}

// 채팅 활성화 상태 감시
database.ref('chatEnabled').on('value', (snapshot) => {
    chatEnabled = snapshot.val() !== false; // 기본값 true
    updateChatEnabledUI();
});

// 채팅 표시 상태 감시
database.ref('chatVisible').on('value', (snapshot) => {
    chatVisible = snapshot.val() !== false; // 기본값 true
    updateChatVisibleUI();
});

// 채팅 활성화 UI 업데이트
function updateChatEnabledUI() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const statusEl = document.getElementById('admin-chat-status');
    const toggleBtn = document.getElementById('chat-toggle-btn');

    // 참여 기능이 닫혀있으면 채팅도 비활성화
    if (!interactionEnabled) {
        input.disabled = true;
        input.placeholder = '관리자가 열면 채팅할 수 있어요';
        sendBtn.disabled = true;
    } else if (chatEnabled) {
        input.disabled = false;
        input.placeholder = `${myNickname}(으)로 메시지 입력 (최대 30자)`;
        if (!chatCooldown) sendBtn.disabled = false;
    } else {
        input.disabled = true;
        input.placeholder = '채팅이 비활성화되었습니다';
        sendBtn.disabled = true;
    }

    // 관리자 패널 상태 표시
    if (statusEl) statusEl.innerText = chatEnabled ? '(활성화)' : '(비활성화)';
    if (statusEl) statusEl.style.color = chatEnabled ? '#27ae60' : '#e74c3c';
    if (toggleBtn) toggleBtn.innerText = chatEnabled ? '🔒 채팅 비활성화' : '🔓 채팅 활성화';
}

// 채팅 활성화/비활성화 토글 (관리자)
function toggleChatEnabled() {
    const newState = !chatEnabled;
    database.ref('chatEnabled').set(newState);
    alert(newState ? '채팅이 활성화되었습니다.' : '채팅이 비활성화되었습니다.');
}

// 채팅 표시/숨김 토글 (관리자)
function toggleChatVisible() {
    const newState = !chatVisible;
    database.ref('chatVisible').set(newState);
    alert(newState ? '채팅 아이콘이 표시됩니다.' : '채팅 아이콘이 숨겨집니다.');
}

// 채팅 표시 UI 업데이트
function updateChatVisibleUI() {
    const chatFab = document.getElementById('chat-fab');
    const visibleBtn = document.getElementById('chat-visible-btn');

    if (chatVisible) {
        chatFab.style.display = 'flex';
        if (visibleBtn) visibleBtn.innerText = '👁️ 채팅 숨기기';
    } else {
        chatFab.style.display = 'none';
        // 채팅창 열려있으면 닫기
        if (isChatOpen) closeChat();
        if (visibleBtn) visibleBtn.innerText = '👁️ 채팅 보이기';
    }
}

// 채팅 모달 열기
function openChat() {
    isChatOpen = true;
    document.getElementById('chat-overlay').classList.add('visible');
    document.getElementById('chat-input').focus();
    // 읽음 처리
    if (chatMessages.length > 0) {
        lastReadTimestamp = chatMessages[chatMessages.length - 1].timestamp;
        localStorage.setItem('ignition_chat_last_read', lastReadTimestamp.toString());
    }
    updateUnreadBadge();
    scrollChatToBottom();
}

// 채팅 모달 닫기
function closeChat(event) {
    if (!event || event.target === event.currentTarget) {
        isChatOpen = false;
        document.getElementById('chat-overlay').classList.remove('visible');
    }
}

// 곡 변경 알림을 채팅에 추가
function addSongChangeNotice(team, song) {
    // 팀명에서 영문명 제거 (예: "피버스 Phoebus" -> "피버스")
    const teamShort = team.split(' ')[0];
    database.ref('chat').push({
        type: 'notice',
        text: `🎵 ${teamShort} - ${song}`,
        timestamp: Date.now()
    });
}

// ========== 후원 기능 ==========
function openDonateModal() {
    document.getElementById('donate-overlay').classList.add('visible');
}

function closeDonateModal(event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById('donate-overlay').classList.remove('visible');
    }
}

function sendDonation(amount) {
    if (!interactionEnabled) { alert('아직 참여할 수 없습니다.'); return; }
    if (chatCooldown) { alert('잠시 후에 다시 보낼 수 있습니다.'); return; }
    stampChatRate().then(() => {
        database.ref('chat').push({
            type: 'donate',
            amount: amount,
            chatId: myChatId,
            timestamp: Date.now()
        });
        closeDonateModal();
        startCooldown();
        alert(`${amount.toLocaleString()}원 후원 감사합니다! 💸`);
    }).catch(() => alert('잠시 후에 다시 보낼 수 있습니다.'));
}

// 채팅 전송
function sendChat() {
    // 참여 기능이 닫혀있으면 무시
    if (!interactionEnabled) {
        alert('아직 채팅에 참여할 수 없습니다.');
        return;
    }

    if (!chatEnabled) {
        alert('채팅이 비활성화되었습니다.');
        return;
    }

    const input = document.getElementById('chat-input');
    const message = input.value.trim();

    if (!message || chatCooldown) return;
    if (message.length > 30) {
        alert('메시지는 30자까지 입력 가능합니다.');
        return;
    }

    // 속도 제한 도장을 찍은 뒤 메시지 저장
    stampChatRate().then(() => {
        database.ref('chat').push({
            text: message,
            chatId: myChatId,
            timestamp: Date.now()
        });
        input.value = '';
        startCooldown();
    }).catch(() => {
        alert('메시지는 10초에 한 번 보낼 수 있습니다.');
        startCooldown();
    });
}

// 엔터키 처리
function handleChatKeypress(event) {
    if (event.key === 'Enter') {
        sendChat();
    }
}

// 쿨타임 시작
function startCooldown() {
    chatCooldown = true;
    const sendBtn = document.getElementById('chat-send-btn');
    const cooldownEl = document.getElementById('chat-cooldown');
    sendBtn.disabled = true;
    cooldownEl.classList.add('visible');

    let remaining = 10;
    cooldownEl.innerText = `${remaining}초 후에 다시 보낼 수 있습니다`;

    const interval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(interval);
            chatCooldown = false;
            sendBtn.disabled = false;
            cooldownEl.classList.remove('visible');
        } else {
            cooldownEl.innerText = `${remaining}초 후에 다시 보낼 수 있습니다`;
        }
    }, 1000);
}

// 채팅 메시지 렌더링
function renderChatMessages() {
    const container = document.getElementById('chat-messages');

    // 숨겨지지 않은 메시지만 필터 (관리자는 전부 볼 수 있음)
    const visibleMessages = isAdmin
        ? chatMessages
        : chatMessages.filter(msg => !msg.hidden);

    if (visibleMessages.length === 0) {
        container.innerHTML = '<div class="chat-empty">아직 메시지가 없습니다</div>';
        return;
    }

    container.innerHTML = visibleMessages.map(msg => {
        // 시스템 알림 (곡 변경)
        if (msg.type === 'notice') {
            return `<div class="chat-system-notice">${escapeHtml(msg.text)}</div>`;
        }

        // 후원 알림
        if (msg.type === 'donate') {
            return `<div class="chat-donate-notice">💸 ${msg.amount.toLocaleString()}원 후원!</div>`;
        }

        const isMine = msg.chatId === myChatId;
        const time = new Date(msg.timestamp);
        const timeStr = time.getHours().toString().padStart(2, '0') + ':' + time.getMinutes().toString().padStart(2, '0');
        const isHidden = msg.hidden;

        // 관리자면 숨김 버튼 표시
        const hideBtn = isAdmin
            ? `<button class="chat-hide-btn" onclick="toggleHideChat('${msg.key}', ${!isHidden})">${isHidden ? '↩' : '×'}</button>`
            : '';

        return `
            <div class="chat-message-wrapper ${isMine ? 'mine' : ''}">
                ${hideBtn}
                <div class="chat-message ${isMine ? 'mine' : ''} ${isHidden ? 'hidden' : ''}">
                    <div class="chat-message-name">${escapeHtml(nicknameOf(msg.chatId))}</div>
                    <div class="chat-message-text">${escapeHtml(msg.text)}</div>
                    <div class="chat-message-time">${timeStr}</div>
                </div>
            </div>
        `;
    }).join('');

    scrollChatToBottom();
}

// 메시지 숨김/복원 토글 (관리자)
function toggleHideChat(msgKey, hide) {
    if (!isAdmin) return;
    database.ref('chat/' + msgKey + '/hidden').set(hide);
}

// 전체 채팅 열기
function openAllChat() {
    document.getElementById('all-chat-overlay').classList.add('visible');
    loadAllChat();
}

// 전체 채팅 닫기
function closeAllChat(event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById('all-chat-overlay').classList.remove('visible');
    }
}

// 전체 채팅 불러오기
function loadAllChat() {
    const container = document.getElementById('all-chat-messages');
    const countEl = document.getElementById('all-chat-count');

    container.innerHTML = '<div class="all-chat-loading">불러오는 중...</div>';

    database.ref('chat').orderByChild('timestamp').once('value', (snapshot) => {
        const data = snapshot.val();

        if (!data) {
            container.innerHTML = '<div class="all-chat-loading">채팅 기록이 없습니다</div>';
            countEl.innerText = '0개의 메시지';
            return;
        }

        const allMessages = Object.entries(data).map(([key, value]) => ({
            ...value,
            key: key
        })).sort((a, b) => a.timestamp - b.timestamp);

        // 관리자가 아니면 숨겨진 메시지 필터
        const visibleMessages = isAdmin
            ? allMessages
            : allMessages.filter(msg => !msg.hidden);

        countEl.innerText = `${visibleMessages.length}개의 메시지`;

        if (visibleMessages.length === 0) {
            container.innerHTML = '<div class="all-chat-loading">채팅 기록이 없습니다</div>';
            return;
        }

        container.innerHTML = visibleMessages.map(msg => {
            // 시스템 알림
            if (msg.type === 'notice') {
                return `<div class="chat-system-notice">${escapeHtml(msg.text)}</div>`;
            }

            // 후원 알림
            if (msg.type === 'donate') {
                return `<div class="chat-donate-notice">💸 ${msg.amount.toLocaleString()}원 후원!</div>`;
            }

            const isMine = msg.chatId === myChatId;
            const time = new Date(msg.timestamp);
            const timeStr = time.getHours().toString().padStart(2, '0') + ':' + time.getMinutes().toString().padStart(2, '0');
            const isHidden = msg.hidden;

            return `
                <div class="all-chat-item ${isMine ? 'mine' : ''} ${isHidden ? 'hidden-msg' : ''}">
                    <div class="all-chat-name">${escapeHtml(isMine ? '나 (' + myNickname + ')' : nicknameOf(msg.chatId))}</div>
                    <div class="all-chat-text">${escapeHtml(msg.text)}</div>
                    <div class="all-chat-time">${timeStr}${isHidden ? ' (숨김)' : ''}</div>
                </div>
            `;
        }).join('');

        // 맨 아래로 스크롤
        container.scrollTop = container.scrollHeight;
    });
}

// 채팅 전체 삭제 (관리자)
function resetChat() {
    if (!confirm('모든 채팅을 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
    database.ref('chat').remove();
    alert('채팅이 삭제되었습니다.');
}

// HTML 이스케이프 (XSS 방지)
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 스크롤 맨 아래로
function scrollChatToBottom() {
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
}

// 읽지 않은 메시지 배지 업데이트
function updateUnreadBadge() {
    const badge = document.getElementById('unread-badge');
    const unreadCount = chatMessages.filter(msg => msg.timestamp > lastReadTimestamp && msg.chatId !== myChatId).length;

    if (unreadCount > 0 && !isChatOpen) {
        badge.innerText = unreadCount > 9 ? '9+' : unreadCount;
        badge.classList.add('visible');
    } else {
        badge.classList.remove('visible');
    }
}

// 채팅 실시간 감시 (최근 20개만)
database.ref('chat').orderByChild('timestamp').limitToLast(20).on('value', (snapshot) => {
    const data = snapshot.val();
    if (data) {
        // key를 메시지에 포함시켜서 저장
        chatMessages = Object.entries(data).map(([key, value]) => ({
            ...value,
            key: key
        })).sort((a, b) => a.timestamp - b.timestamp);
    } else {
        chatMessages = [];
    }
    renderChatMessages();
    updateUnreadBadge();
    renderScreen();

    // 채팅창 열려있으면 읽음 처리
    if (isChatOpen && chatMessages.length > 0) {
        lastReadTimestamp = chatMessages[chatMessages.length - 1].timestamp;
        localStorage.setItem('ignition_chat_last_read', lastReadTimestamp.toString());
    }
});

// ========== 피버 타임 (열기 게이지) ==========
// 관객이 버튼을 연타해 현재 팀의 게이지를 채우고, 목표에 닿으면 전 관객 화면에
// 폭발 이펙트가 한 번 터진다. 팀당 한 번만 터지며 기록은 hypeExplodedTeams에 남는다.
const HYPE_DEFAULT_TARGET = 300;
const HYPE_PER_PERSON = 5;   // 자동 목표: 접속자 1명당 클릭 수
const HYPE_MIN_TARGET = 20;
let hypeAuto = true;         // 자동 목표 사용 여부 (DB hypeAuto)
let hypeManualTarget = HYPE_DEFAULT_TARGET;
let hypeTarget = HYPE_DEFAULT_TARGET; // 현재 유효 목표 (자동이면 접속자 수 기반)
function effectiveHypeTarget() {
    return hypeAuto ? Math.max(HYPE_MIN_TARGET, presenceCount * HYPE_PER_PERSON) : hypeManualTarget;
}
let hypeCount = 0;              // 현재 팀 게이지 (로컬 즉시 반영 포함)
let hypeBuffer = 0;
let hypeFlushTimeout = null;
let hypeExplosionTimer = null;
let hypeExplodedTeams = {};
let hypeExplodedLoaded = false; // 첫 스냅샷에서는 이펙트를 재생하지 않는다 (늦게 접속한 관객 보호)
let hypeListenerTeam = null;
let hypeGaugeCollapsed = false;

database.ref('hypeTarget').on('value', (snapshot) => {
    hypeManualTarget = snapshot.val() || HYPE_DEFAULT_TARGET;
    updateHypeUI();
});
database.ref('hypeAuto').on('value', (snapshot) => {
    hypeAuto = snapshot.val() !== false; // 기본값 자동
    updateHypeUI();
});

database.ref('hypeExplodedTeams').on('value', (snapshot) => {
    const prev = hypeExplodedTeams;
    hypeExplodedTeams = snapshot.val() || {};
    if (hypeExplodedLoaded && currentTeam && hypeExplodedTeams[currentTeam] && !prev[currentTeam]) {
        showHypeExplosion();
    }
    // MAX 채팅 알림은 알림 쓰기 권한이 있는 관리자 클라이언트가 올린다.
    // 관리자 기기가 여러 대여도 hypeNoticed/{팀}을 transaction으로 선점한 한 대만 올린다.
    if (hypeExplodedLoaded && isAdmin) {
        Object.keys(hypeExplodedTeams).filter(team => !prev[team]).forEach(team => {
            database.ref('hypeNoticed/' + team).transaction(current => current ? undefined : true, (error, committed) => {
                if (!committed) return;
                database.ref('chat').push({
                    type: 'notice',
                    text: `🔥🔥🔥 ${team.split(' ')[0]} 피버 타임 MAX! 🔥🔥🔥`,
                    timestamp: Date.now()
                });
            });
        });
    }
    hypeExplodedLoaded = true;
    updateHypeUI();
});

// 팀이 바뀌면 그 팀의 게이지만 구독한다
function watchTeamHype(team) {
    if (hypeListenerTeam) database.ref('hypeCount/' + hypeListenerTeam).off();
    hypeListenerTeam = team;
    hypeCount = 0;
    hypeBuffer = 0;
    clearTimeout(hypeFlushTimeout);
    updateHypeUI();
    if (!team) return;

    database.ref('hypeCount/' + team).on('value', (snapshot) => {
        const serverCount = snapshot.val();
        // 하트와 같은 규칙: 서버 값이 로컬보다 클 때만 반영해 숫자가 뒤로 튀지 않게 한다.
        // 값이 지워졌으면(관리자 초기화) 0으로 되돌린다.
        if (serverCount === null || serverCount > hypeCount) hypeCount = serverCount || 0;
        updateHypeUI();
        // 서버가 확인한 값으로만 MAX를 판정한다
        if (serverCount >= effectiveHypeTarget() && !hypeExplodedTeams[team]) markHypeMax(team);
    });
}

// MAX 기록은 transaction으로 한 클라이언트만 남긴다 (이미 있으면 중단). 알림은 관리자 리스너가 올린다.
function markHypeMax(team) {
    database.ref('hypeExplodedTeams/' + team).transaction(current => current ? undefined : true);
}

function updateHypeUI() {
    hypeTarget = effectiveHypeTarget();
    const maxed = !!(currentTeam && hypeExplodedTeams[currentTeam]);
    const percent = maxed ? 100 : (hypeTarget > 0 ? Math.min(100, Math.round(hypeCount / hypeTarget * 100)) : 0);
    const fill = document.getElementById('hype-fill');
    const btn = document.getElementById('hype-btn');
    const label = maxed ? '✓ 피버 타임 MAX 달성!' : '🔥 열기 올리기!';

    document.getElementById('hype-percent').innerText = percent + '%';
    fill.style.width = percent + '%';
    fill.classList.toggle('hot', !maxed && percent >= 80);
    fill.classList.toggle('maxed', maxed);
    btn.disabled = maxed;
    if (btn.innerText !== label) btn.innerText = label;

    const adminTarget = document.getElementById('admin-hype-target');
    if (adminTarget) adminTarget.innerText = hypeAuto ? `(자동 목표 ${hypeTarget}, 접속 ${presenceCount}명 × ${HYPE_PER_PERSON})` : `(목표: ${hypeTarget})`;
    const autoBtn = document.getElementById('hype-auto-btn');
    if (autoBtn) autoBtn.innerText = hypeAuto ? '🤖 자동 목표 켜짐' : '🤖 자동 목표 꺼짐';
    syncNowPlayingPadding();
    renderScreen();
}

function toggleHypeGauge() {
    hypeGaugeCollapsed = !hypeGaugeCollapsed;
    document.getElementById('hype-gauge-content').classList.toggle('collapsed', hypeGaugeCollapsed);
    document.getElementById('hype-toggle-btn').textContent = hypeGaugeCollapsed ? '▼ 펼치기' : '▲ 접기';
    syncNowPlayingPadding();
    setTimeout(syncNowPlayingPadding, 350); // 접힘 애니메이션이 끝난 뒤 한 번 더
}

// 열기 올리기 (연타 가능, 300ms 모아서 전송)
function addHype() {
    if (!interactionEnabled) return;
    if (!hypeListenerTeam || hypeExplodedTeams[hypeListenerTeam]) return;

    hypeCount++;
    hypeBuffer++;
    updateHypeUI();

    clearTimeout(hypeFlushTimeout);
    hypeFlushTimeout = setTimeout(flushHype, 300);
}

function flushHype() {
    if (hypeBuffer > 0 && hypeListenerTeam) {
        const count = hypeBuffer;
        hypeBuffer = 0;
        database.ref('hypeCount/' + hypeListenerTeam).transaction(current => (current || 0) + count);
    }
}

function showHypeExplosion() {
    const el = document.getElementById('hype-explosion');
    el.classList.remove('visible');
    void el.offsetWidth; // 애니메이션 재시작
    el.classList.add('visible');
    if (navigator.vibrate) navigator.vibrate([100, 50, 200]);
    clearTimeout(hypeExplosionTimer);
    hypeExplosionTimer = setTimeout(() => el.classList.remove('visible'), 4000);
}

// 관리자: 목표값 설정
function setHypeTarget() {
    const input = prompt('피버 타임 목표값을 입력하세요 (현재: ' + hypeTarget + '):', hypeTarget);
    const target = parseInt(input, 10);
    if (input === null || isNaN(target) || target <= 0) return;
    database.ref('hypeTarget').set(target);
    database.ref('hypeAuto').set(false);
    alert('목표값이 ' + target + '(으)로 설정되었습니다. 자동 목표는 꺼집니다.');
}

// 관리자: 자동 목표 켜기/끄기
function toggleHypeAuto() {
    database.ref('hypeAuto').set(!hypeAuto);
}

// 관리자: 모든 팀 게이지와 MAX 기록 초기화
function resetHype() {
    if (!confirm('모든 팀의 게이지와 피버 타임 MAX 기록을 초기화할까요?')) return;
    database.ref('hypeExplodedTeams').remove();
    database.ref('hypeNoticed').remove();
    database.ref('hypeCount').remove();
    alert('피버 타임이 초기화되었습니다.');
}

// 관리자: 현재 팀을 강제로 MAX (전 관객 화면에 이펙트)
function forceHypeMax() {
    if (!hypeListenerTeam) { alert('먼저 연주 중인 곡을 선택하세요.'); return; }
    if (hypeExplodedTeams[hypeListenerTeam]) { alert('이미 MAX인 팀입니다.'); return; }
    markHypeMax(hypeListenerTeam);
}

// 관리자: 현재 팀 MAX 해제와 게이지 0 (다시 올릴 수 있게)
function clearHypeTeam() {
    if (!hypeListenerTeam) { alert('먼저 연주 중인 곡을 선택하세요.'); return; }
    database.ref('hypeExplodedTeams/' + hypeListenerTeam).remove();
    database.ref('hypeNoticed/' + hypeListenerTeam).remove();
    database.ref('hypeCount/' + hypeListenerTeam).remove();
}

// ========== 관객 참여 기능 일괄 관리 ==========
// 관객 참여 기능 상태 감시
database.ref('interactionEnabled').on('value', (snapshot) => {
    interactionEnabled = snapshot.val() === true; // 기본값 false (닫힘)
    updateInteractionUI();
});

// 관객 참여 기능 열기/닫기 (관리자)
function setInteractionEnabled(enabled) {
    database.ref('interactionEnabled').set(enabled);
}

// 관객 참여 기능 UI 업데이트
function updateInteractionUI() {
    // 관리자 패널 상태 표시
    const statusEl = document.getElementById('interaction-status');
    if (statusEl) {
        if (interactionEnabled) {
            statusEl.innerText = '현재: 열림 🔓';
            statusEl.style.color = '#27ae60';
        } else {
            statusEl.innerText = '현재: 닫힘 🔒';
            statusEl.style.color = '#e74c3c';
        }
    }

    // 하트 버튼 상태
    updateHeartButtonsState();

    // 피버 타임 버튼 상태
    document.getElementById('hype-btn').classList.toggle('disabled', !interactionEnabled);

    // 채팅 상태
    updateChatInteractionState();

    // 추첨 참여 버튼 상태
    updateRaffleInteractionState();
}

// 하트 버튼 상태 업데이트
function updateHeartButtonsState() {
    const heartBtns = document.querySelectorAll('.heart-btn');
    heartBtns.forEach(btn => {
        if (interactionEnabled) {
            btn.classList.remove('disabled');
        } else {
            btn.classList.add('disabled');
        }
    });
}

// 채팅 참여 상태 업데이트
function updateChatInteractionState() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');

    if (!interactionEnabled) {
        input.disabled = true;
        input.placeholder = '관리자가 열면 채팅할 수 있어요';
        sendBtn.disabled = true;
    } else if (chatEnabled) {
        input.disabled = false;
        input.placeholder = `${myNickname}(으)로 메시지 입력 (최대 30자)`;
        if (!chatCooldown) sendBtn.disabled = false;
    }
}

// 추첨 참여 상태 업데이트 (참여 전/후, 열림/닫힘 분기는 updateRaffleUI가 담당)
function updateRaffleInteractionState() {
    updateRaffleUI();
}

// 초기화
rebuildSetlist(); // 기본 셋리스트로 먼저 그리고, DB 값이 오면 교체한다
updateInteractionUI(); // DB 응답 전에도 참여 버튼을 닫힘 상태로 표시
initScreenMode();
