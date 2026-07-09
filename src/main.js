// 화면 전환 및 전체 흐름 오케스트레이션
// (사진 기능 제거됨 — 야간 도심 팔레트를 시드 난수로 생성. 퀴즈 기능은 추후 추가)

import { Game } from './game/game.js';
import { loadGameAssets } from './utils/assets.js';
import { nightCityPalette } from './map/palette.js';
import { createRng } from './utils/rng.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  game: null,
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
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
  showScreen('#screen-generating');

  await setGenStep('에셋 불러오는 중…', 0, 40, '도시를 짓는 중');
  await loadGameAssets(); // Blender 제작 GLB (최초 1회만 실제 로드)

  await setGenStep('트랙 생성 중…', 40, 70, '야경 고가도로 곡선을 그리는 중');
  await new Promise((r) => setTimeout(r, 350));
  await setGenStep('야경 배치 중…', 70, 100, '강 건너 도시에 불을 켜는 중');
  await new Promise((r) => setTimeout(r, 350));

  const seed = String(Date.now());
  const palette = nightCityPalette(createRng(seed + '::palette'));
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
    onHud({ speed, lap, totalLaps, time, score, boosting }) {
      $('#hud-speed').textContent = speed;
      $('#hud-lap').textContent = `${lap}/${totalLaps}`;
      $('#hud-time').textContent = formatTime(time);
      $('#hud-score').textContent = score;
      $('#boost-indicator').classList.toggle('hidden', !boosting);
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
      $('#result-time').textContent = formatTime(result.totalTime);
      $('#result-best').textContent = formatTime(result.bestLap);
      $('#result-score').textContent = `${result.score}점`;
      setTimeout(() => showScreen('#screen-result'), 1200);
    },
  };

  const game = new Game($('#game-container'), palette, ui);
  state.game = game;
  game.build(seed);
  game.start();
}

// ---------- 이벤트 바인딩 ----------
$('#btn-start').addEventListener('click', () => generateAndPlay());
$('#btn-restart').addEventListener('click', () => generateAndPlay());
$('#btn-menu').addEventListener('click', () => {
  state.game?.dispose();
  state.game = null;
  showScreen('#screen-start');
});

// 개발·검증: ?auto=1 즉시 시작
if (new URLSearchParams(location.search).get('auto') === '1') {
  generateAndPlay().catch((e) => console.error(e));
}
