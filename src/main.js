// 화면 전환 및 전체 흐름 오케스트레이션:
// 시작(싱글/멀티 로비) → 차량 선택 → 맵 생성(시드) → 주행 → 결과(순위표/재대결)

import { Game } from './game/game.js';
import { loadGameAssets } from './utils/assets.js';
import { nightCityPalette, duskCityPalette } from './map/palette.js';
import { createRng } from './utils/rng.js';
import { createCarPreview } from './game/carPreview.js';

const $ = (sel) => document.querySelector(sel);

// 선택 가능한 차량 목록 (model = GLB 에셋 이름).
// 사용자 결정(2026-07-15): 당분간 918 스파이더 단일 차량 — 구 차량(car2~6)과
// 엘란트라N/코나(car8/9)는 라인업에서 제외(자체제작 GLB는 저장소에 보존).
const CARS = [
  {
    id: 'car7',
    model: 'car7',
    name: '918 스파이더',
    tag: '하이브리드 하이퍼카 · 실사 모델 (CC-BY)',
    color: '#c8ccd4',
  },
];

const state = {
  game: null,
  selectedCar: 'car7',
  previews: [],
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ---------- 차량 선택 흐름 ----------
function disposePreviews() {
  state.previews.forEach((p) => p.dispose());
  state.previews = [];
}

function highlightSelected() {
  document.querySelectorAll('.car-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.carId === state.selectedCar);
  });
}

async function showCarSelect() {
  showScreen('#screen-select');
  const wrap = $('#car-cards');
  disposePreviews();

  // 카드 골격 먼저 그리고(로딩 표시), 에셋 로드 후 3D 프리뷰 붙이기
  wrap.innerHTML = CARS.map(
    (c) => `
    <div class="car-card" data-car-id="${c.id}">
      <div class="car-loading">불러오는 중…</div>
      <div class="car-info">
        <div class="car-name"><span class="car-swatch" style="color:${c.color};background:${c.color}"></span>${c.name}</div>
        <div class="car-tag">${c.tag}</div>
      </div>
    </div>`
  ).join('');

  wrap.querySelectorAll('.car-card').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedCar = el.dataset.carId;
      highlightSelected();
    });
  });
  highlightSelected();

  await loadGameAssets();

  // 로딩 자리표시를 캔버스로 교체하고 회전 프리뷰 시작
  CARS.forEach((c) => {
    const card = wrap.querySelector(`.car-card[data-car-id="${c.id}"]`);
    if (!card) return;
    const holder = card.querySelector('.car-loading');
    const canvas = document.createElement('canvas');
    canvas.className = 'preview';
    holder.replaceWith(canvas);
    try {
      state.previews.push(createCarPreview(canvas, c.model));
    } catch (e) {
      console.error('프리뷰 생성 실패', c.id, e);
    }
  });
}

// ---------- 맵 생성 흐름 ----------
async function setGenStep(label, from, to, detail = '') {
  $('#gen-status').textContent = label;
  $('#gen-detail').textContent = detail;
  $('#gen-progress').style.width = `${from}%`;
  await new Promise((r) => setTimeout(r, 60));
  $('#gen-progress').style.width = `${to}%`;
}

// seedOverride: "같은 맵 다시"(시드 재사용) / rematchInfo: 재대결 소켓 인계 { net, ids, host }
async function generateAndPlay(seedOverride = null, rematchInfo = null) {
  disposePreviews(); // 선택 화면 프리뷰 컨텍스트 정리
  showScreen('#screen-generating');

  await setGenStep('에셋 불러오는 중…', 0, 40, '도시를 짓는 중');
  await loadGameAssets(); // Blender 제작 GLB (최초 1회만 실제 로드)

  await setGenStep('트랙 생성 중…', 40, 70, '야경 고가도로 곡선을 그리는 중');
  await new Promise((r) => setTimeout(r, 350));
  await setGenStep('야경 배치 중…', 70, 100, '강 건너 도시에 불을 켜는 중');
  await new Promise((r) => setTimeout(r, 350));

  // 시드 결정: 멀티는 방 코드가 곧 시드(재대결 포함), 싱글은 "같은 맵 다시" 재사용 →
  // 개발용 ?seed= 최초 진입 → 그 외엔 매번 새 도시
  const q = new URLSearchParams(location.search);
  let seed;
  if (q.get('room')) seed = q.get('seed');
  else if (seedOverride) seed = seedOverride;
  else if (!state.lastSeed && q.get('seed')) seed = q.get('seed');
  else seed = String(Date.now());
  state.lastSeed = seed;
  // 시간대: 시드 기반으로 밤/노을이 섞여 나온다 (?tod=dusk|night 로 강제 가능) —
  // 같은 시드 = 같은 시간대라 "같은 맵 다시"에서도 분위기가 그대로 재현된다
  const prng = createRng(seed + '::palette');
  const todParam = q.get('tod');
  const dusk = todParam ? todParam === 'dusk' : prng() < 0.45;
  const palette = dusk ? duskCityPalette(prng) : nightCityPalette(prng);
  // 비 날씨: 밤에만 시드 확률 ~25% (?wx=rain|clear 강제). 팔레트 난수 소비 뒤에
  // 뽑아야 기존 시드들의 색감이 안 바뀐다. 같은 시드 = 같은 날씨(멀티 동기화)
  const wxParam = q.get('wx');
  palette.rain = !dusk && (wxParam ? wxParam === 'rain' : prng() < 0.25);
  startGame(seed, palette, rematchInfo);
}

// ---------- 게임 ----------
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// XSS 방지: 닉네임 등 사용자 입력을 innerHTML에 넣기 전 이스케이프
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 멀티 순위표: 완주(기록순) → 미완주(사고/주행중, 진행률순). 라이브 갱신됨
function renderStandings(rows) {
  const el = $('#result-ranks');
  el.innerHTML = rows.map((r, i) => {
    const rec = r.time !== null ? formatTime(r.time)
      : r.crashed ? `사고 (${Math.round(r.progress * 100)}%)`
      : `주행중 ${Math.round(r.progress * 100)}%`;
    return `<div class="rr-row${r.me ? ' rr-me' : ''}">
      <span class="rr-rank">${i + 1}</span>
      <span class="rr-name">${escapeHtml(r.name)}${r.me ? ' <em>(나)</em>' : ''}</span>
      <span class="rr-rec">${rec}</span>
    </div>`;
  }).join('');
}

// 결과 화면 버튼 구성: 싱글=같은 맵/새 도시, 멀티=재대결
function configureResultButtons(isMulti) {
  $('#btn-rematch').classList.toggle('hidden', !isMulti);
  $('#btn-same').classList.toggle('hidden', isMulti);
  $('#btn-restart').classList.toggle('hidden', isMulti);
  $('#result-ranks').classList.toggle('hidden', !isMulti);
  const b = $('#btn-rematch');
  b.disabled = false;
  b.textContent = '재대결';
}

function startGame(seed, palette, rematchInfo = null) {
  showScreen('#screen-game');
  $('#hud').classList.remove('hidden');

  state.game?.dispose();

  const ui = {
    onHud({ speed, progress, time, avg, boosting, boostGauge, flash, rank, racers }) {
      $('#hud-speed').textContent = speed;
      $('#hud-progress').textContent = `${Math.round((progress || 0) * 100)}%`;
      // 멀티 순위 (피어가 있을 때만 표시)
      const ri = $('#hud-rank-item');
      if (rank) {
        ri.style.display = '';
        $('#hud-rank').textContent = `${rank}/${racers}`;
      } else {
        ri.style.display = 'none';
      }
      $('#hud-time').textContent = formatTime(time);
      $('#hud-score').textContent = Math.round(avg || 0);
      $('#boost-indicator').classList.toggle('hidden', !boosting);
      $('#boost-fill').style.width = `${Math.round((boostGauge || 0) * 100)}%`;
      // 중앙 팝업 (니어미스)
      const nm = $('#nearmiss');
      if (flash) {
        nm.classList.remove('hidden');
        nm.style.opacity = Math.min(1, flash.t * 2.2);
        nm.innerHTML =
          `<div class="nm-label${flash.close ? ' close' : ''}">${flash.label}</div>` +
          (flash.sub ? `<div class="nm-sub">${flash.sub}</div>` : '');
      } else {
        nm.classList.add('hidden');
      }
    },
    onCountdown(text) {
      const el = $('#countdown');
      if (text === null) {
        el.classList.add('hidden');
      } else {
        el.classList.remove('hidden');
        el.textContent = text;
      }
    },
    onFinish(result) {
      $('#result-title').textContent = '목적지 도착! 🏁';
      $('#result-progress').textContent = '100%';
      $('#result-time').textContent = formatTime(result.totalTime);
      $('#result-best').textContent = `${Math.round(result.maxSpeed)} km/h`;
      $('#result-score').textContent = `${result.avgSpeed.toFixed(1)} km/h`;
      const isMulti = !!state.game?.net;
      configureResultButtons(isMulti);
      if (isMulti) {
        renderStandings(state.game.getStandings());
        state.game.checkRematch(); // 상대가 먼저 재대결을 눌렀으면 카운터 표시
      }
      setTimeout(() => showScreen('#screen-result'), 1200);
    },
    // 충돌 1회 = 사고 → 즉시 실패 (현실성)
    onFail(result) {
      const cd = $('#countdown');
      cd.classList.remove('hidden');
      cd.textContent = '🚨 사고!';
      $('#result-title').textContent = '사고 발생… 🚨';
      $('#result-progress').textContent = `${Math.round((result.progress || 0) * 100)}%`;
      $('#result-time').textContent = formatTime(result.totalTime);
      $('#result-best').textContent = `${Math.round(result.maxSpeed)} km/h`;
      $('#result-score').textContent = `${result.avgSpeed.toFixed(1)} km/h`;
      const isMulti = !!state.game?.net;
      configureResultButtons(isMulti);
      if (isMulti) {
        renderStandings(state.game.getStandings());
        state.game.checkRematch(); // 상대가 먼저 재대결을 눌렀으면 카운터 표시
      }
      setTimeout(() => {
        cd.classList.add('hidden');
        showScreen('#screen-result');
      }, 1500);
    },
    // 결과 화면 순위표 라이브 갱신(상대 완주/사고/진행률이 계속 들어온다)
    onStandings(rows) {
      renderStandings(rows);
    },
    // 재대결 준비 인원 변동 → 버튼 라벨로 표시
    onRematch({ ready, total }) {
      const b = $('#btn-rematch');
      if (b.disabled) b.textContent = `재대결 대기중 (${ready}/${total})`;
      else if (ready > 0) b.textContent = `재대결 (${ready}/${total} 준비됨)`;
    },
    // 전원 준비 완료 → 소켓을 인계해 같은 방·시드로 재시작.
    // 리빌드 창(구 게임 dispose ~ 새 setupNet)에 오는 host 승계/go는 여기 브릿지가 담아둔다
    onRematchGo(info) {
      info.net.on('host', (m) => { info.host = m.id === info.net.id; });
      info.net.on('go', (m) => { info.goAt = m.at; });
      info.net.on('left', (m) => { info.ids = info.ids.filter((id) => id !== m.id); });
      generateAndPlay(null, info);
    },
  };

  const game = new Game($('#game-container'), palette, ui, {
    carModel: state.selectedCar,
    hardMode: $('#opt-hard').checked,
    traffic: $('#opt-traffic').checked,
    quality: $('#opt-quality').value, // low|medium|high|auto
    rematch: rematchInfo,
  });
  state.game = game;
  game.build(seed);
  game.start();
}

// ---------- 게임 설정 토글 (localStorage 유지) ----------
for (const [id, key] of [['#opt-hard', 'nd_hard'], ['#opt-traffic', 'nd_traffic']]) {
  const el = $(id);
  const saved = localStorage.getItem(key);
  if (saved !== null) el.checked = saved === '1';
  el.addEventListener('change', () => localStorage.setItem(key, el.checked ? '1' : '0'));
}
// 품질 프리셋 드롭다운 (localStorage 유지, 기본 auto)
{
  const el = $('#opt-quality');
  el.value = localStorage.getItem('nd_quality') || 'auto';
  el.addEventListener('change', () => localStorage.setItem('nd_quality', el.value));
}

// ---------- 멀티플레이 로비 ----------
// 방 코드 = 맵 시드: 같은 코드로 접속하면 같은 맵·시간대가 결정적으로 재현된다.
// URL 파라미터(room/host/seed/name)를 리로드 없이 심고 기존 흐름(차량 선택→주행)을 탄다.
function enterMultiplayer(code, isHost) {
  const nick = ($('#mp-name').value || '').trim().slice(0, 8);
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  url.searchParams.set('seed', code);
  if (isHost) url.searchParams.set('host', '1');
  else url.searchParams.delete('host');
  if (nick) url.searchParams.set('name', nick);
  history.replaceState(null, '', url);
  showCarSelect();
}

function newRoomCode() {
  // 헷갈리는 글자(0/O, 1/I) 제외한 5자리 코드
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// 로비 조회: 짧은 일회성 소켓으로 방 목록을 받아온다 (실패 시 null)
function fetchRooms() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch { /* noop */ } resolve(v); } };
    let ws;
    try { ws = new WebSocket(`ws://${location.hostname}:8787`); } catch { resolve(null); return; }
    const to = setTimeout(() => finish(null), 2500);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'lobby' }));
    ws.onerror = () => { clearTimeout(to); finish(null); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'rooms') { clearTimeout(to); finish(m.list); }
    };
  });
}

async function loadRoomList() {
  const box = $('#mp-rooms');
  box.innerHTML = '<div class="mp-empty">불러오는 중…</div>';
  const list = await fetchRooms();
  if (list === null) {
    box.innerHTML = '<div class="mp-empty">서버 연결 실패 — relay 서버(npm run relay)를 확인하세요</div>';
    return null;
  }
  const waiting = list.filter((r) => !r.racing && r.n > 0);
  if (!waiting.length) {
    box.innerHTML = '<div class="mp-empty">대기 중인 방이 없습니다 — 방을 만들어보세요</div>';
  } else {
    box.innerHTML = waiting.map((r) =>
      `<button class="mp-room" data-code="${r.code}" type="button">
        <span class="mp-room-code">${r.code}</span><span class="mp-room-n">${r.n}명 대기중</span>
      </button>`).join('');
    box.querySelectorAll('.mp-room').forEach((el) => {
      el.addEventListener('click', () => enterMultiplayer(el.dataset.code, false));
    });
  }
  return waiting;
}

$('#btn-multi').addEventListener('click', () => {
  // 모드 선택 버튼을 멀티 패널로 교체 (뒤로가기로 복귀)
  document.querySelector('.start-btns').classList.add('hidden');
  $('#mp-panel').classList.remove('hidden');
  loadRoomList();
});
$('#btn-mp-back').addEventListener('click', () => {
  $('#mp-panel').classList.add('hidden');
  document.querySelector('.start-btns').classList.remove('hidden');
});
$('#btn-mp-refresh').addEventListener('click', () => loadRoomList());
$('#btn-mp-create').addEventListener('click', () => enterMultiplayer(newRoomCode(), true));
$('#btn-mp-quick').addEventListener('click', async () => {
  // 빠른 모드: 대기 중인 방이 있으면 첫 방에 참가, 없으면 방장으로 새 방 개설
  const waiting = await loadRoomList();
  if (waiting === null) return; // 서버 연결 실패
  if (waiting.length) enterMultiplayer(waiting[0].code, false);
  else enterMultiplayer(newRoomCode(), true);
});

// 싱글 시작·메뉴 복귀 시 멀티 파라미터 제거(잔류하면 다음 판이 멀티로 붙는다)
function clearMpParams() {
  const url = new URL(location.href);
  // 방 코드 시드가 남으면 이후 싱글이 계속 같은 맵으로 고정된다
  if (url.searchParams.has('room')) url.searchParams.delete('seed');
  url.searchParams.delete('room');
  url.searchParams.delete('host');
  url.searchParams.delete('name');
  history.replaceState(null, '', url);
}

// ---------- 이벤트 바인딩 ----------
$('#btn-start').addEventListener('click', () => { clearMpParams(); showCarSelect(); });
$('#btn-select-back').addEventListener('click', () => {
  disposePreviews();
  showScreen('#screen-start');
});
$('#btn-select-confirm').addEventListener('click', () => generateAndPlay());
$('#btn-restart').addEventListener('click', () => generateAndPlay()); // 새 시드 = 새로운 도시
$('#btn-same').addEventListener('click', () => generateAndPlay(state.lastSeed)); // 시드 재사용
$('#btn-rematch').addEventListener('click', () => {
  const g = state.game;
  if (!g?.net) return;
  const b = $('#btn-rematch');
  b.disabled = true;
  b.textContent = '상대 대기중…';
  g.requestRematch(); // 전원 준비되면 ui.onRematchGo로 재시작
});
$('#btn-menu').addEventListener('click', () => {
  state.game?.dispose();
  state.game = null;
  disposePreviews();
  clearMpParams();
  showScreen('#screen-start');
});

// 개발·검증: ?auto=1 즉시 시작, ?car=car7 로 차량 지정
const params = new URLSearchParams(location.search);
const carParam = params.get('car');
if (carParam && CARS.some((c) => c.id === carParam)) state.selectedCar = carParam;
if (params.get('auto') === '1') {
  generateAndPlay().catch((e) => console.error(e));
} else if (params.get('select') === '1') {
  showCarSelect().catch((e) => console.error(e));
}
