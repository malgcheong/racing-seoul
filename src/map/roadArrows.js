// 발광 노면 화살표 — 야간에 뭉개지던 페인트 데칼 대신 은은한 자발광(additive).
// 직진 화살표(차로 유도)와 우측 굽음 화살표(분기 진출 유도) 두 종류.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function arrowTexture(bend) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(215, 238, 255, 0.95)';
  ctx.fillStyle = 'rgba(215, 238, 255, 0.95)';
  ctx.shadowColor = 'rgba(150, 200, 255, 0.9)';
  ctx.shadowBlur = 16;
  ctx.lineWidth = 20;
  ctx.lineCap = 'butt';
  if (!bend) {
    // 직진: 샤프트 + 삼각 헤드
    ctx.beginPath();
    ctx.moveTo(64, 216);
    ctx.lineTo(64, 88);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(64, 20);
    ctx.lineTo(28, 96);
    ctx.lineTo(100, 96);
    ctx.closePath();
    ctx.fill();
  } else {
    // 우측 굽음: 아래 직선 → 우상단 커브 + 우향 헤드 (캔버스 +x = 도로 우측)
    ctx.beginPath();
    ctx.moveTo(56, 216);
    ctx.lineTo(56, 140);
    ctx.quadraticCurveTo(56, 76, 96, 62);
    ctx.stroke();
    ctx.beginPath(); // 헤드: 우상향
    ctx.moveTo(122, 52);
    ctx.lineTo(72, 30);
    ctx.lineTo(84, 92);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// spots: [{ i, lat, bend }] — samples[i] 중심선에서 +left(lat)만큼 이동한 노면 위
export function buildRoadArrows(samples, spots) {
  const group = new THREE.Group();
  const byBend = { 0: [], 1: [] };
  const rx = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  for (const sp of spots) {
    const s = samples[Math.max(0, Math.min(samples.length - 1, sp.i))];
    const h = Math.atan2(s.tangent.x, s.tangent.z);
    const g = new THREE.PlaneGeometry(1.35, 3.4);
    // 캔버스 상단이 진행 방향(+tangent)을 향하고 법선은 위(+y)
    const m = new THREE.Matrix4().makeRotationY(h + Math.PI).multiply(rx);
    m.setPosition(
      s.pos.x + s.left.x * sp.lat,
      s.pos.y + 0.06, // 분기 진출차로 노면(+0.03)보다 확실히 위 — z-파이팅 방지
      s.pos.z + s.left.z * sp.lat
    );
    g.applyMatrix4(m);
    byBend[sp.bend ? 1 : 0].push(g);
  }
  for (const bend of [0, 1]) {
    if (!byBend[bend].length) continue;
    const mat = new THREE.MeshBasicMaterial({
      map: arrowTexture(bend),
      transparent: true,
      opacity: 0.55, // 은은하게 — 페인트가 스스로 빛나는 정도
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    group.add(new THREE.Mesh(mergeGeometries(byBend[bend]), mat));
    byBend[bend].forEach((g) => g.dispose());
  }
  return group;
}
