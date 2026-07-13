// 동적 맵(트랙) 생성 엔진 — 편도(point-to-point) 루트.
// 서쪽 도심에서 출발해 강을 다리로 건너 동쪽 도심의 목적지에 도착한다.
// 시드 난수로 컨트롤 포인트를 잡고 Catmull-Rom 스플라인으로 도로를 만든다.

import * as THREE from 'three';
import { range } from '../utils/rng.js';

export const TRACK_WIDTH = 22;   // 4차선(편도 2차선 x 양방향). 차 대비 도로가 너무 넓지 않게
export const MEDIAN_HALF = 1.4;  // 중앙분리대 반폭
export const SAMPLE_COUNT = 900;
export const DECK_HEIGHT = 14; // 고가도로 데크 높이

export function generateTrack(rng) {
  // 강: x가 RIV_X0~RIV_X1인 남북 방향 밴드. 루트는 이 위를 직선 다리로 건넌다.
  const RIV_X0 = 260;
  const RIV_W = 240;
  const RIV_X1 = RIV_X0 + RIV_W;
  const zBridge = range(rng, -120, 120); // 다리가 놓이는 z (시드마다 다름)

  const points = [];
  // 서쪽 도심: S자로 굽이치며 강으로 접근
  let z = zBridge + range(rng, -60, 60);
  const westXs = [-700, -540, -380, -240, -60];
  for (const x of westXs) {
    z += range(rng, -170, 170);
    points.push(new THREE.Vector3(x, 0, z));
  }
  // 다리 진입·통과·진출: z를 고정해 곧은 교량 구간을 만든다
  for (const x of [RIV_X0 - 150, RIV_X0 - 50, RIV_X1 + 50, RIV_X1 + 150]) {
    points.push(new THREE.Vector3(x, 0, zBridge));
  }
  // 동쪽 도심: 다시 굽이치다 목적지
  z = zBridge;
  const eastXs = [660, 820, 990, 1160, 1330];
  for (const x of eastXs) {
    z += range(rng, -170, 170);
    points.push(new THREE.Vector3(x, 0, z));
  }

  // 출발지↔도착지 반전: 동쪽 도심에서 출발해 다리를 건너
  // 여의도(랜드마크가 있는 서안) 방면 도심에 도착한다
  points.reverse();

  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.6);

  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t = i / (SAMPLE_COUNT - 1);
    const pos = curve.getPointAt(t);
    pos.y = DECK_HEIGHT; // 고가도로: 트랙 전체를 데크 높이로
    const tangent = curve.getTangentAt(t).normalize();
    // 평면 트랙: 좌측 법선은 접선을 90도 회전
    const left = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    samples.push({ pos, tangent, left });
  }

  return {
    curve, samples, width: TRACK_WIDTH,
    river: { x0: RIV_X0, x1: RIV_X1, zBridge },
  };
}

// 졸음쉼터 구간 직선화: idx±half 창의 샘플을 창 양끝을 잇는 직선(chord)에
// 눌러붙인다. 시드에 따라 "가장 직선인 구간"조차 S커브일 수 있는데, 긴
// 직사각형 플랫폼·램프가 곡선에 걸리면 진입이 어렵고 도로가 어색해진다.
// 가운데 약 40%는 완전 직선, 양끝 30%씩은 smoothstep으로 원곡선에 블렌드.
export function straightenTrackWindow(samples, idx, half) {
  const n = samples.length;
  const i0 = Math.max(1, idx - half);
  const i1 = Math.min(n - 2, idx + half);
  if (i1 - i0 < 8) return;
  const a = samples[i0].pos, b = samples[i1].pos;
  const dir = b.clone().sub(a);
  const len2 = dir.lengthSq();
  if (len2 < 1) return;
  const E = 0.3; // 양끝 블렌드 구간 비율
  const smooth = (x) => x * x * (3 - 2 * x);
  for (let i = i0 + 1; i < i1; i++) {
    const p = samples[i].pos;
    const t = p.clone().sub(a).dot(dir) / len2;
    const proj = a.clone().addScaledVector(dir, t);
    const u = (i - i0) / (i1 - i0);
    const w = u < E ? smooth(u / E) : u > 1 - E ? smooth((1 - u) / E) : 1;
    p.lerp(proj, w);
  }
  // 이동한 구간(경계 한 칸 여유)의 접선·좌측 법선 재계산
  for (let i = Math.max(1, i0 - 1); i <= Math.min(n - 2, i1 + 1); i++) {
    const tan = samples[i + 1].pos.clone().sub(samples[i - 1].pos).normalize();
    samples[i].tangent.copy(tan);
    samples[i].left.set(-tan.z, 0, tan.x);
  }
}

// 아스팔트 + 중앙 점선 + 양측 흰 라인 텍스처
function createRoadTexture() {
  const canvas = document.createElement('canvas');
  const S = 512;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  // 베이스 아스팔트
  ctx.fillStyle = '#2b2d34';
  ctx.fillRect(0, 0, S, S);

  // 고운 알갱이(2톤): 밝은 자갈 + 어두운 알갱이
  for (let i = 0; i < 6000; i++) {
    const v = 55 + Math.random() * 45;
    ctx.fillStyle = `rgba(${v},${v},${v + 5},${0.12 + Math.random() * 0.18})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  for (let i = 0; i < 4000; i++) {
    const v = 18 + Math.random() * 18;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.15 + Math.random() * 0.2})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  // 큰 얼룩(보수 자국·오일)
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 30 + Math.random() * 90;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    const dark = Math.random() < 0.5;
    g.addColorStop(0, dark ? 'rgba(20,20,24,0.35)' : 'rgba(70,72,80,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.5), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 미세 크랙
  ctx.strokeStyle = 'rgba(12,12,14,0.5)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 22; i++) {
    let x = Math.random() * S, y = Math.random() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 3 + Math.floor(Math.random() * 4);
    for (let j = 0; j < segs; j++) {
      x += (Math.random() - 0.5) * 60;
      y += (Math.random() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 차선 마모 효과: 라인 위에 불규칙 지움
  const wear = (lx, lw) => {
    const scratches = 40;
    for (let i = 0; i < scratches; i++) {
      ctx.fillStyle = `rgba(43,45,52,${0.25 + Math.random() * 0.4})`;
      ctx.fillRect(lx + Math.random() * lw, Math.random() * S, 1 + Math.random() * 2, 3 + Math.random() * 8);
    }
  };
  // 일방통행 4차선. U(가로)=도로 폭 전체. 흰 점선 3개로 4차선 구분(중앙선 없음).
  //  U:  0(끝) — 0.25 — 0.5 — 0.75 — 1(끝), 양끝 흰 실선
  ctx.fillStyle = '#dcdcd2';
  ctx.fillRect(9, 0, 10, S);
  ctx.fillRect(S - 19, 0, 10, S);
  wear(9, 10); wear(S - 19, 10);
  // 차로 구분 흰 점선 3개 (4차선 → 3줄). 야간 가독 위해 밝게, 마모 최소.
  ctx.fillStyle = '#f2f2ea';
  for (const dx of [S * 0.25, S * 0.5, S * 0.75]) {
    for (let y = 0; y < S; y += 92) ctx.fillRect(dx - 6, y, 12, 56);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function buildRoadMesh(samples, width) {
  const half = width / 2;
  const positions = [];
  const uvs = [];
  const indices = [];
  const n = samples.length;

  let dist = 0;
  for (let i = 0; i < n; i++) { // 개방 루트: 끝→시작 연결 세그먼트 없음
    const s = samples[i];
    if (i > 0) dist += s.pos.distanceTo(samples[i - 1].pos);
    const l = s.pos.clone().addScaledVector(s.left, half);
    const r = s.pos.clone().addScaledVector(s.left, -half);
    positions.push(l.x, l.y + 0.02, l.z, r.x, r.y + 0.02, r.z);
    const v = dist / 18;
    uvs.push(0, v, 1, v);
    if (i < n - 1) {
      const a = i * 2;
      // 위(+Y)를 향하도록 반시계 winding
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // 마른 아스팔트: 물웅덩이(roughnessMap 매끈 패치)는 반사가 과해 제거됨
  const mat = new THREE.MeshStandardMaterial({
    map: createRoadTexture(),
    roughness: 0.9,
    metalness: 0.04,
    color: 0xaeb2bc,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// 중앙분리대: 도로 중앙선을 따라가는 낮은 콘크리트 연석 + 상단 발광 LED 라인.
// 야간에 중앙 경계가 또렷하게 보이고, 게임에선 차가 넘지 못하게 막는다(game.js).
export function buildMedian(samples) {
  const n = samples.length;
  // 뉴저지형 콘크리트 방호벽 단면(도면: 3000x1270x610x150).
  // 중심 기준 [좌우 오프셋, 높이](게임유닛). 도면 비율 유지:
  //  바닥 토우(수직) → 하부 급경사 플레어 → 상부 완경사 → 좁은 상단(150).
  //  base 610→반폭 305, top 150→반폭 75, height 1270 비율을 게임 스케일에 맞춤.
  const H = 1.55;              // 방호벽 높이(게임유닛)
  const BASE = 1.02;          // 바닥 반폭
  const TOP = 0.26;           // 상단 반폭
  const PROFILE = [
    // 우측: 바닥 → 상단
    [BASE, 0.0], [BASE, 0.09], [0.78, 0.30], [TOP + 0.06, H - 0.16], [TOP, H],
    // 상단 → 좌측: 미러
    [-TOP, H], [-(TOP + 0.06), H - 0.16], [-0.78, 0.30], [-BASE, 0.09], [-BASE, 0.0],
  ];
  const P = PROFILE.length;
  const pos = [];
  const ledPos = [];
  for (let i = 0; i <= n; i++) {
    const s = samples[i % n];
    const y = s.pos.y;
    for (const [ox, oy] of PROFILE) {
      const p = s.pos.clone().addScaledVector(s.left, ox);
      pos.push(p.x, y + oy, p.z);
    }
    ledPos.push(s.pos.x, y + H + 0.03, s.pos.z); // 상단 중앙 반사 스트립
  }
  const idx = [];
  for (let i = 0; i < n; i++) {
    const a = i * P, b = (i + 1) * P;
    for (let k = 0; k < P - 1; k++) {
      idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
    }
  }

  const group = new THREE.Group();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const wall = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0x5a5d66, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide,
  }));
  wall.receiveShadow = true;
  wall.castShadow = true;
  group.add(wall);

  // 상단 반사 스트립(야간 네온 감성 유지)
  const ledGeo = new THREE.BufferGeometry();
  ledGeo.setAttribute('position', new THREE.Float32BufferAttribute(ledPos, 3));
  const led = new THREE.LineLoop(ledGeo, new THREE.LineBasicMaterial({ color: 0xffb454 }));
  group.add(led);

  return group;
}

// 출발/결승 체커 라인 (idx로 위치 지정 — 결승선은 마지막 샘플 부근에)
export function buildStartLine(samples, width, idx = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const cell = 16;
  for (let x = 0; x < 128 / cell; x++) {
    for (let y = 0; y < 32 / cell; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);

  const s = samples[idx];
  const geo = new THREE.PlaneGeometry(width, 4);
  // 야간 눈부심 방지: 체커를 톤다운
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0x8a8a8a });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(s.pos).setY(s.pos.y + 0.05);
  // 트랙 진행 방향에 맞춰 회전
  mesh.rotation.z = Math.atan2(s.tangent.x, s.tangent.z);
  return mesh;
}
