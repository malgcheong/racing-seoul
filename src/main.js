// 화면 전환 및 전체 흐름 오케스트레이션:
// 시작 → 차량 선택 → 맵 선택 → 맵 생성(시드) → 주행(봇 대결) → 결과(순위표)

import { Game } from './game/game.js';
import { loadGameAssets } from './utils/assets.js';
import { nightCityPalette, duskCityPalette } from './map/palette.js';
import { createRng } from './utils/rng.js';
import { createCarPreview } from './game/carPreview.js';

const $ = (sel) => document.querySelector(sel);

// 선택 가능한 차량 목록 (model = GLB 에셋 이름). 전부 Sketchfab CC-BY 실사 모델.
const CARS = [
  {
    id: 'car7',
    model: 'car7',
    name: '918 스파이더',
    tag: '하이브리드 하이퍼카 · 실사 모델 (CC-BY)',
    color: '#c8ccd4',
  },
  {
    id: 'car10',
    model: 'car10',
    name: 'S63 쿠페 브라부스',
    tag: '럭셔리 GT 쿠페 · 브라부스 800 · 실사 모델 (CC-BY)',
    color: '#20242a',
  },
  {
    id: 'car11',
    model: 'car11',
    name: 'SL63 AMG',
    tag: 'AMG 로드스터 · 실사 모델 (CC-BY)',
    color: '#3a3f48',
  },
  {
    id: 'car12',
    model: 'car12',
    name: 'M4 CSL',
    tag: 'BMW M 트랙 스페셜 · 실사 모델 (CC-BY)',
    color: '#c8ccd4',
  },
];

const state = {
  game: null,
  selectedCar: 'car7',
  selectedMap: 'night', // 맵 선택 화면: 'night' | 'dusk'
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

// seedOverride: "같은 맵 다시"(시드 재사용 — 고스트 대결)
async function generateAndPlay(seedOverride = null) {
  disposePreviews(); // 선택 화면 프리뷰 컨텍스트 정리
  showScreen('#screen-generating');

  await setGenStep('에셋 불러오는 중…', 0, 40, '도시를 짓는 중');
  await loadGameAssets(); // Blender 제작 GLB (최초 1회만 실제 로드)

  await setGenStep('트랙 생성 중…', 40, 70, '야경 고가도로 곡선을 그리는 중');
  await new Promise((r) => setTimeout(r, 350));
  await setGenStep('야경 배치 중…', 70, 100, '강 건너 도시에 불을 켜는 중');
  await new Promise((r) => setTimeout(r, 350));

  // 시드 결정: "같은 맵 다시" 재사용 → 개발용 ?seed= 최초 진입 → 그 외엔 매번 새 도시
  const q = new URLSearchParams(location.search);
  let seed;
  if (seedOverride) seed = seedOverride;
  else if (!state.lastSeed && q.get('seed')) seed = q.get('seed');
  else seed = String(Date.now());
  state.lastSeed = seed;
  // 시간대: 맵 선택 화면의 선택(노을/밤)을 따른다. ?tod=dusk|night 로 강제 가능
  const prng = createRng(seed + '::palette');
  const todParam = q.get('tod');
  const dusk = todParam ? todParam === 'dusk' : state.selectedMap === 'dusk';
  const palette = dusk ? duskCityPalette(prng) : nightCityPalette(prng);
  startGame(seed, palette);
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

// 봇 대결 순위표: 완주(기록순) → 미완주(사고/주행중, 진행률순). 라이브 갱신됨
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

// 봇 대결이었으면 결과 화면에 순위표 표시
function renderResultStandings(standings) {
  $('#result-ranks').classList.toggle('hidden', !standings);
  if (standings) renderStandings(standings);
}

function startGame(seed, palette) {
  showScreen('#screen-game');
  $('#hud').classList.remove('hidden');

  state.game?.dispose();

  const ui = {
    onHud({ speed, progress, time, avg, boosting, boostGauge, flash, rank, racers }) {
      $('#hud-speed').textContent = speed;
      $('#hud-progress').textContent = `${Math.round((progress || 0) * 100)}%`;
      // 순위 (봇 대결일 때만 표시)
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
      renderResultStandings(result.standings);
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
      renderResultStandings(result.standings);
      setTimeout(() => {
        cd.classList.add('hidden');
        showScreen('#screen-result');
      }, 1500);
    },
    // 결과 화면 순위표 라이브 갱신(봇 완주/사고/진행률이 계속 변한다)
    onStandings(rows) {
      renderStandings(rows);
    },
  };

  const game = new Game($('#game-container'), palette, ui, {
    carModel: state.selectedCar,
    hardMode: $('#opt-hard').checked,
    traffic: $('#opt-traffic').checked,
    npr: $('#opt-npr').checked, // 만화 렌더(셀셰이딩)
    bots: parseInt($('#opt-bots').value, 10), // 봇 대결 상대 수(0=없음)
    quality: $('#opt-quality').value, // low|medium|high|auto
  });
  state.game = game;
  window.__game = game; // 개발·검증용 콘솔 훅 (자동 테스트가 내부 상태 점검에 사용)
  game.build(seed);
  game.start();
}

// ---------- 게임 설정 토글 (localStorage 유지) ----------
for (const [id, key] of [
  ['#opt-hard', 'nd_hard'], ['#opt-traffic', 'nd_traffic'], ['#opt-npr', 'nd_npr'],
]) {
  const el = $(id);
  const saved = localStorage.getItem(key);
  if (saved !== null) el.checked = saved === '1';
  el.addEventListener('change', () => localStorage.setItem(key, el.checked ? '1' : '0'));
}
// 드롭다운(품질·봇 수) — localStorage 유지
for (const [id, key, def] of [['#opt-quality', 'nd_quality', 'auto'], ['#opt-bots', 'nd_bots', '3']]) {
  const el = $(id);
  el.value = localStorage.getItem(key) || def;
  el.addEventListener('change', () => localStorage.setItem(key, el.value));
}

// ---------- 이벤트 바인딩 ----------
$('#btn-start').addEventListener('click', () => showCarSelect());
$('#btn-select-back').addEventListener('click', () => {
  disposePreviews();
  showScreen('#screen-start');
});
// 차량 확정 → 맵(하늘) 선택 → 주행 시작
$('#btn-select-confirm').addEventListener('click', () => showScreen('#screen-map'));
$('#btn-map-back').addEventListener('click', () => showScreen('#screen-select'));
$('#btn-map-confirm').addEventListener('click', () => generateAndPlay());
document.querySelectorAll('.map-card').forEach((el) => {
  el.addEventListener('click', () => {
    state.selectedMap = el.dataset.map;
    document.querySelectorAll('.map-card')
      .forEach((c) => c.classList.toggle('selected', c === el));
  });
});
$('#btn-restart').addEventListener('click', () => generateAndPlay()); // 새 시드 = 새로운 도시
$('#btn-same').addEventListener('click', () => generateAndPlay(state.lastSeed)); // 시드 재사용
$('#btn-menu').addEventListener('click', () => {
  state.game?.dispose();
  state.game = null;
  disposePreviews();
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
