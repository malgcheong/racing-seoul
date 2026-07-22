// 고스트(베스트 기록) — 싱글플레이 전용.
// 시드가 곧 맵이므로 시드별 베스트 주행(위치·헤딩 0.1s 그리드)을 localStorage에
// 저장했다가, 같은 시드 재도전 시 반투명 고스트로 재생한다.
// 물리 바디 없음(충돌·차단 없음) — 순수 시각 재생기.

import * as THREE from 'three';
import { instantiate } from '../utils/assets.js';

const INDEX_KEY = 'nd_ghosts';          // [{seed, time, at}] — LRU 인덱스
const KEY = (seed) => `nd_ghost:${seed}`;
const MAX_GHOSTS = 8;                   // 보관 시드 수 상한(초과 시 오래된 것부터 삭제)
export const GHOST_HZ = 10;             // 녹화 샘플링 주기(고정 그리드)

// 시드의 베스트 레코드 {time, car, hz, x[], y[], z[], h[]} — 없거나 깨졌으면 null
export function loadGhost(seed) {
  try {
    const raw = localStorage.getItem(KEY(seed));
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (!g || !Array.isArray(g.x) || g.x.length < 2 || !(g.time > 0)) return null;
    return g;
  } catch {
    return null;
  }
}

export function saveGhost(seed, rec) {
  try {
    let idx;
    try { idx = JSON.parse(localStorage.getItem(INDEX_KEY)) || []; } catch { idx = []; }
    idx = idx.filter((e) => e && e.seed && e.seed !== seed);
    idx.push({ seed, time: rec.time, at: Date.now() });
    idx.sort((a, b) => a.at - b.at);
    while (idx.length > MAX_GHOSTS) {
      localStorage.removeItem(KEY(idx[0].seed));
      idx.shift();
    }
    localStorage.setItem(KEY(seed), JSON.stringify(rec));
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch { /* 저장소 초과 등 — 기록만 못 남길 뿐 게임 진행엔 영향 없음 */ }
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
}

// 차 위에 떠 있는 라벨 스프라이트 (RemoteCar 이름표와 동일 방식)
function makeLabel(text) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(30, 40, 90, 0.55)';
  ctx.beginPath();
  ctx.roundRect(28, 8, 200, 48, 12);
  ctx.fill();
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#cdd8ff';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.85,
  }));
  sp.scale.set(3.4, 0.85, 1);
  sp.position.set(0, 2.7, 0);
  return sp;
}

export class GhostCar {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this.group = new THREE.Group();
    const model = instantiate(data.car || 'car7');
    model.rotation.y = Math.PI; // 에셋 전방 보정(Car와 동일)
    // 반투명 + 은은한 청색 발광 — 야간에도 형체가 읽히고 실차와 혼동되지 않게.
    // 재질은 클론해서만 손댄다(에셋 캐시 원본 공유 — 실차·프리뷰 오염 금지)
    model.traverse((o) => {
      o.castShadow = false;
      if (!o.isMesh) return;
      const conv = (m) => {
        if (!m) return m;
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.32;
        if (c.emissive) {
          c.emissive = new THREE.Color(0x3550c8);
          c.emissiveIntensity = 0.5;
        }
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
    });
    this.group.add(model);
    this.group.add(makeLabel(`👻 ${fmt(data.time)}`));
    scene.add(this.group);
    this.update(0);
  }

  // t(레이스 경과초) 시점의 기록 위치로 이동 — 샘플 사이 선형 보간, 끝나면 종점 유지
  update(t) {
    const d = this.data;
    const n = d.x.length;
    const f = THREE.MathUtils.clamp(t * (d.hz || GHOST_HZ), 0, n - 1.001);
    const i = Math.floor(f);
    const j = Math.min(i + 1, n - 1);
    const k = f - i;
    this.group.position.set(
      d.x[i] + (d.x[j] - d.x[i]) * k,
      d.y[i] + (d.y[j] - d.y[i]) * k,
      d.z[i] + (d.z[j] - d.z[i]) * k
    );
    let dh = d.h[j] - d.h[i]; // 헤딩 보간(각도 랩)
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.group.rotation.y = d.h[i] + dh * k;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
