// 화면 전환 및 전체 흐름 오케스트레이션

import { analyzePhotos, buildPalette } from './analysis/photoAnalyzer.js';
import { Game } from './game/game.js';
import { generateDemoPhotos } from './ui/demoPhotos.js';
import { processImageFile } from './utils/imageProcess.js';
import { loadGameAssets } from './utils/assets.js';

const MIN_PHOTOS = 5;   // MVP 최소 장수 (정식 명세 2.2.5는 10장)
const MAX_PHOTOS = 50;  // 명세 2.1.3
const MAX_FILE_MB = 10; // 명세 2.1.5
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const $ = (sel) => document.querySelector(sel);

const state = {
  photos: [],        // {id, thumbUrl, textureUrl, width, height, name, memo, selected, analysis?}
  palette: null,
  game: null,
  photoSeq: 0,
};

// ---------- 화면 전환 ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ---------- 업로드 / 갤러리 ----------
async function addFiles(fileList) {
  const files = [...fileList];
  const errors = [];

  for (const file of files) {
    if (state.photos.length >= MAX_PHOTOS) {
      errors.push(`최대 ${MAX_PHOTOS}장까지 업로드할 수 있어요.`);
      break;
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      errors.push(`${file.name}: 지원하지 않는 형식 (JPG/PNG/WEBP만 가능)`);
      continue;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      errors.push(`${file.name}: ${MAX_FILE_MB}MB를 초과합니다.`);
      continue;
    }
    // 원본은 버리고 리사이즈본만 보관 (팝업 렉·메모리 사용 방지)
    const processed = await processImageFile(file);
    state.photos.push({
      id: `p-${state.photoSeq++}`,
      ...processed,
      name: file.name,
      memo: '',
      selected: true,
    });
  }

  if (errors.length) alert(errors.join('\n'));
  renderGallery();
}

function renderGallery() {
  const gallery = $('#gallery');
  gallery.innerHTML = '';

  for (const photo of state.photos) {
    const card = document.createElement('div');
    card.className = 'photo-card' + (photo.selected ? ' selected' : '');

    const img = document.createElement('img');
    img.src = photo.thumbUrl;
    img.alt = photo.name;
    img.addEventListener('click', () => {
      photo.selected = !photo.selected;
      renderGallery();
    });

    const check = document.createElement('div');
    check.className = 'check';
    check.textContent = photo.selected ? '✓' : '';

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '삭제';
    del.addEventListener('click', () => {
      if (confirm('이 사진을 삭제하시겠습니까?')) {
        state.photos = state.photos.filter((p) => p.id !== photo.id);
        renderGallery();
      }
    });

    const memo = document.createElement('input');
    memo.className = 'memo-input';
    memo.placeholder = '추억 메모 (게임에서 팝업으로 표시)';
    memo.value = photo.memo;
    memo.addEventListener('input', () => (photo.memo = memo.value));

    card.append(img, check, del, memo);
    gallery.appendChild(card);
  }

  $('#gallery-section').classList.toggle('hidden', state.photos.length === 0);
  updateToolbar();
}

function updateToolbar() {
  const selected = state.photos.filter((p) => p.selected);
  $('#select-count').textContent = `${selected.length} / ${state.photos.length}장 선택됨`;

  const consentsOk = [...document.querySelectorAll('.consent')].every((c) => c.checked);
  const canGenerate = selected.length >= MIN_PHOTOS && consentsOk;
  $('#btn-generate').disabled = !canGenerate;
  $('#generate-hint').textContent = canGenerate
    ? `${selected.length}장의 사진으로 맵을 생성합니다.`
    : `최소 ${MIN_PHOTOS}장 이상 선택하고 약관에 모두 동의하면 시작할 수 있어요.`;
}

// ---------- 맵 생성 흐름 (명세 1.3 진행 모니터링) ----------
async function setGenStep(label, from, to, detail = '') {
  $('#gen-status').textContent = label;
  $('#gen-detail').textContent = detail;
  $('#gen-progress').style.width = `${from}%`;
  await new Promise((r) => setTimeout(r, 60));
  $('#gen-progress').style.width = `${to}%`;
}

async function generateAndPlay(reuseSeedSuffix) {
  const selected = state.photos.filter((p) => p.selected);
  showScreen('#screen-generating');

  // 1) 사진 분석 (실제 색상 추출)
  await setGenStep('사진 분석 중…', 0, 5, `${selected.length}장의 색감과 분위기를 읽는 중`);
  const analyses = await analyzePhotos(selected, (ratio) => {
    $('#gen-progress').style.width = `${5 + ratio * 45}%`;
  });
  selected.forEach((p, i) => (p.analysis = analyses[i]));
  state.palette = buildPalette(analyses);

  // 2) 지형/배경/오브젝트 (Three.js 씬 구성은 빠르므로 연출을 겸한 단계 표시)
  await setGenStep('지형 생성 중…', 50, 68, '사진의 분위기로 트랙 곡선을 그리는 중');
  await loadGameAssets(); // Blender 제작 GLB (최초 1회만 실제 로드)
  await new Promise((r) => setTimeout(r, 450));
  await setGenStep('배경 생성 중…', 68, 84, '하늘과 지평선을 칠하는 중');
  await new Promise((r) => setTimeout(r, 450));
  await setGenStep('추억 오브젝트 배치 중…', 84, 100, '액자와 홀로그램을 세우는 중');
  await new Promise((r) => setTimeout(r, 450));

  // 3) 게임 시작 — 시드에 시각을 섞어 같은 사진이어도 매번 다른 맵 (명세 1.2.4)
  const seed =
    selected.map((p) => p.id).join('|') + '::' + (reuseSeedSuffix ?? Date.now());
  startGame(selected, seed);
}

// ---------- 게임 ----------
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function startGame(photos, seed) {
  showScreen('#screen-game');
  $('#hud').classList.remove('hidden');

  state.game?.dispose();

  const ui = {
    onHud({ speed, lap, totalLaps, time, score, boosting, memoriesSeen, totalMemories }) {
      $('#hud-speed').textContent = speed;
      $('#hud-lap').textContent = `${lap}/${totalLaps}`;
      $('#hud-time').textContent = formatTime(time);
      $('#hud-score').textContent = score;
      $('#hud-memories').textContent = `${memoriesSeen}/${totalMemories}`;
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
      $('#result-memories').textContent = `${result.memoriesSeen} / ${result.totalMemories}개`;
      setTimeout(() => showScreen('#screen-result'), 1200);
    },
  };

  const game = new Game($('#game-container'), photos, state.palette, ui);
  state.game = game;
  game.build(seed);
  game.start();
}

// ---------- 이벤트 바인딩 ----------
function bindUploadScreen() {
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');

  $('#btn-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    })
  );
  dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  $('#btn-demo').addEventListener('click', () => {
    state.photos = [...state.photos, ...generateDemoPhotos(8)];
    document.querySelectorAll('.consent').forEach((c) => (c.checked = true));
    renderGallery();
  });

  $('#btn-select-all').addEventListener('click', () => {
    state.photos.forEach((p) => (p.selected = true));
    renderGallery();
  });
  $('#btn-deselect-all').addEventListener('click', () => {
    state.photos.forEach((p) => (p.selected = false));
    renderGallery();
  });
  $('#btn-delete-selected').addEventListener('click', () => {
    const selected = state.photos.filter((p) => p.selected);
    if (!selected.length) return;
    if (confirm(`선택한 ${selected.length}장을 삭제하시겠습니까?`)) {
      state.photos = state.photos.filter((p) => !p.selected);
      renderGallery();
    }
  });

  document.querySelectorAll('.consent').forEach((c) =>
    c.addEventListener('change', updateToolbar)
  );

  $('#btn-generate').addEventListener('click', () => generateAndPlay());
}

function bindResultScreen() {
  $('#btn-regenerate').addEventListener('click', () => generateAndPlay());
  $('#btn-back-upload').addEventListener('click', () => {
    state.game?.dispose();
    state.game = null;
    showScreen('#screen-upload');
    renderGallery();
  });
}

bindUploadScreen();
bindResultScreen();

// 데모/자동 실행: ?demo=1 샘플 사진 로드, &auto=1 즉시 맵 생성 (개발·검증용)
const params = new URLSearchParams(location.search);
if (params.get('demo') === '1') {
  state.photos = generateDemoPhotos(8);
  document.querySelectorAll('.consent').forEach((c) => (c.checked = true));
  renderGallery();
  if (params.get('auto') === '1') generateAndPlay();
}
