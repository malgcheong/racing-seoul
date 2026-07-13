// 화면 전환 및 전체 흐름 오케스트레이션
// (사진 기능 제거됨 — 야간 도심 팔레트를 시드 난수로 생성. 퀴즈 기능은 추후 추가)

import { Game } from './game/game.js';
import { loadGameAssets } from './utils/assets.js';
import { nightCityPalette, duskCityPalette } from './map/palette.js';
import { createRng } from './utils/rng.js';
import { createCarPreview } from './game/carPreview.js';

const $ = (sel) => document.querySelector(sel);

// 선택 가능한 차량 목록 (model = GLB 에셋 이름)
const CARS = [
  {
    id: 'car2',
    model: 'car2',
    name: '타우로스 SV',
    tag: '각진 웨지 슈퍼카 · 공격적인 실루엣',
    color: '#e6b400',
  },
  {
    id: 'car3',
    model: 'car3',
    name: '노마드 XT',
    tag: '오프로드 4X4 · 대형 노비타이어 + 루프 라이트바',
    color: '#5f6f38',
  },
  {
    id: 'car4',
    model: 'car4',
    name: '버그 클래식',
    tag: '레트로 라운드 쿠페 · 크롬 범퍼 + 원형 헤드라이트',
    color: '#4d8ccc',
  },
  {
    id: 'car5',
    model: 'car5',
    name: '박스밴 550',
    tag: '경상용 하이루프 밴 · 캡오버 + 슬라이딩 도어',
    color: '#dfe2e8',
  },
  {
    id: 'car6',
    model: 'car6',
    name: '팬텀 570',
    tag: '미드십 슈퍼카 · 대형 리어윙 에어로킷',
    color: '#7a7e85',
  },
];

const state = {
  game: null,
  selectedCar: 'car2',
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

async function generateAndPlay() {
  disposePreviews(); // 선택 화면 프리뷰 컨텍스트 정리
  showScreen('#screen-generating');

  await setGenStep('에셋 불러오는 중…', 0, 40, '도시를 짓는 중');
  await loadGameAssets(); // Blender 제작 GLB (최초 1회만 실제 로드)

  await setGenStep('트랙 생성 중…', 40, 70, '야경 고가도로 곡선을 그리는 중');
  await new Promise((r) => setTimeout(r, 350));
  await setGenStep('야경 배치 중…', 70, 100, '강 건너 도시에 불을 켜는 중');
  await new Promise((r) => setTimeout(r, 350));

  const seed = new URLSearchParams(location.search).get('seed') || String(Date.now());
  // 시간대: 시드 기반으로 밤/노을이 섞여 나온다 (?tod=dusk|night 로 강제 가능)
  const prng = createRng(seed + '::palette');
  const todParam = new URLSearchParams(location.search).get('tod');
  const dusk = todParam ? todParam === 'dusk' : prng() < 0.45;
  const palette = dusk ? duskCityPalette(prng) : nightCityPalette(prng);
  startGame(seed, palette);
}

// ---------- 게임 ----------
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function startGame(seed, palette) {
  showScreen('#screen-game');
  $('#hud').classList.remove('hidden');

  state.game?.dispose();

  const ui = {
    onHud({ speed, progress, time, avg, boosting, boostGauge, flash }) {
      $('#hud-speed').textContent = speed;
      $('#hud-lap').textContent = `${Math.round((progress || 0) * 100)}%`;
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
    onLap() {},
    onBoost() {},
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
      setTimeout(() => {
        cd.classList.add('hidden');
        showScreen('#screen-result');
      }, 1500);
    },
  };

  const game = new Game($('#game-container'), palette, ui, { carModel: state.selectedCar });
  state.game = game;
  game.build(seed);
  game.start();
}

// ---------- 이벤트 바인딩 ----------
$('#btn-start').addEventListener('click', () => showCarSelect());
$('#btn-select-back').addEventListener('click', () => {
  disposePreviews();
  showScreen('#screen-start');
});
$('#btn-select-confirm').addEventListener('click', () => generateAndPlay());
$('#btn-restart').addEventListener('click', () => generateAndPlay()); // 같은 차량으로 재시작
$('#btn-menu').addEventListener('click', () => {
  state.game?.dispose();
  state.game = null;
  disposePreviews();
  showScreen('#screen-start');
});

// 개발·검증: ?auto=1 즉시 시작, ?car=car2 로 차량 지정
const params = new URLSearchParams(location.search);
const carParam = params.get('car');
if (carParam && CARS.some((c) => c.id === carParam)) state.selectedCar = carParam;
if (params.get('auto') === '1') {
  generateAndPlay().catch((e) => console.error(e));
} else if (params.get('select') === '1') {
  showCarSelect().catch((e) => console.error(e));
}
