// 동적 맵(트랙) 생성 엔진 — 편도(point-to-point) 루트.
// 동쪽 도심에서 출발해 강을 다리로 건너 서안(여의도 랜드마크) 도심에 도착한다.
// 시드 난수로 컨트롤 포인트를 잡고 Catmull-Rom 스플라인으로 도로를 만든다.

import * as THREE from 'three';
import { range } from '../utils/rng.js';

const TRACK_WIDTH = 32;   // 왕복 8차선(방향별 4차선, 차선폭 4m) + 중앙분리대
const SAMPLE_COUNT = 900;
const DECK_HEIGHT = 14;   // 고가도로 데크 높이
// 중앙분리대 반폭(가드레일형 — 연석 0.46 + 여유). 플레이어 좌측 클램프 기준(game.js)
export const MEDIAN_HALF = 0.5;

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
    samples.push({ pos, tangent: new THREE.Vector3(), left: new THREE.Vector3() });
  }

  // 곡률 제한 스무딩: 커브 반경이 도로 반폭(16)에 근접하면 리본 안쪽 변이
  // 자기 자신을 가로질러 접힌다("커브에서 도로가 깨짐"). 반경 < ~45m 구간을
  // 이웃 중점으로 반복 완화 — 직선(다리 구간)은 중점이 같은 선상이라 안 움직인다.
  const MIN_R = 45;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < SAMPLE_COUNT - 1; i++) {
      const a = samples[i - 1].pos, b = samples[i].pos, c = samples[i + 1].pos;
      const v1x = b.x - a.x, v1z = b.z - a.z;
      const v2x = c.x - b.x, v2z = c.z - b.z;
      const l1 = Math.hypot(v1x, v1z), l2 = Math.hypot(v2x, v2z);
      if (l1 < 1e-4 || l2 < 1e-4) continue;
      const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1z * v2z) / (l1 * l2)));
      const ang = Math.acos(cos);
      // 회전각/구간길이 ≈ 곡률. 반경이 MIN_R보다 작으면 완화
      if (ang > l1 / MIN_R) {
        b.x += ((a.x + c.x) / 2 - b.x) * 0.55;
        b.z += ((a.z + c.z) / 2 - b.z) * 0.55;
      }
    }
  }
  // 접선·좌측 법선은 스무딩 후 중앙차분으로 일괄 계산
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const p0 = samples[Math.max(0, i - 1)].pos;
    const p1 = samples[Math.min(SAMPLE_COUNT - 1, i + 1)].pos;
    const tan = samples[i].tangent.set(p1.x - p0.x, 0, p1.z - p0.z).normalize();
    samples[i].left.set(-tan.z, 0, tan.x); // 평면 트랙: 접선 90도 회전
  }

  return {
    curve, samples, width: TRACK_WIDTH,
    river: { x0: RIV_X0, x1: RIV_X1, zBridge },
  };
}

// 아스팔트 + 중앙 황색복선 + 차로 점선 + 양측 흰 실선 텍스처.
// halfLanes = 방향별 차선 수 (본선 4 → 왕복 8차선, 강변도로 2 → 왕복 4차선)
// widthM = 실제 도로 폭(m) — 라인 굵기를 미터 기준으로 그려 도로가 넓어져도
// 점선이 같이 뚱뚱해지지 않게 한다("점선이 왜 커졌지" 피드백)
function createRoadTexture(halfLanes = 4, widthM = 32) {
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
  // U(가로)=도로 폭 전체. 중앙 황색 복선(본선은 그 위에 중앙분리대가 선다) +
  // 방향별 (halfLanes-1)개 흰 점선 + 양끝 흰 실선. 굵기는 미터 기준 환산.
  const pxm = S / widthM;
  const edgeW = Math.max(4, Math.round(0.38 * pxm));
  const dashW = Math.max(3, Math.round(0.3 * pxm));
  const yelW = Math.max(3, Math.round(0.3 * pxm));
  const yelOff = Math.max(yelW, Math.round(0.34 * pxm));
  ctx.fillStyle = '#dcdcd2';
  ctx.fillRect(9, 0, edgeW, S);
  ctx.fillRect(S - 9 - edgeW, 0, edgeW, S);
  wear(9, edgeW); wear(S - 9 - edgeW, edgeW);
  ctx.fillStyle = '#d8b13c'; // 중앙 황색 복선
  ctx.fillRect(S / 2 - yelOff - yelW / 2, 0, yelW, S);
  ctx.fillRect(S / 2 + yelOff - yelW / 2, 0, yelW, S);
  // 차로 구분 흰 점선. 야간 가독 위해 밝게, 마모 최소.
  ctx.fillStyle = '#f2f2ea';
  const nb = halfLanes * 2;
  for (let j = 1; j < nb; j++) {
    if (j === halfLanes) continue; // 중앙은 황색 복선 자리
    const dx = (S * j) / nb;
    for (let y = 0; y < S; y += 112) ctx.fillRect(dx - dashW / 2, y, dashW, 56);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function buildRoadMesh(samples, width, halfLanes = 4) {
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
    map: createRoadTexture(halfLanes, width),
    roughness: 0.9,
    metalness: 0.04,
    color: 0xaeb2bc,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// 중앙분리대(실사 레퍼런스: 교량 중분대): 낮은 콘크리트 연석 위에
// 지주 + 은색 원형 가드레일 빔 2단. 게임에선 차가 넘지 못하게 막는다(game.js).
export function buildMedian(samples) {
  const n = samples.length;
  const group = new THREE.Group();

  // 프로파일 스윕 헬퍼 — 개방(P2P) 트랙: 끝→시작을 잇지 않는다
  const sweep = (profile, mat, closed = false) => {
    const prof = closed ? [...profile, profile[0]] : profile;
    const P = prof.length;
    const pos = [];
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      for (const [ox, oy] of prof) {
        const p = s.pos.clone().addScaledVector(s.left, ox);
        pos.push(p.x, s.pos.y + oy, p.z);
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * P, b = (i + 1) * P;
      for (let k = 0; k < P - 1; k++) {
        idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  };

  // 콘크리트 연석(밝은 회색 사다리꼴, 높이 0.35)
  const curbMat = new THREE.MeshLambertMaterial({ color: 0x82858c });
  const curb = sweep([
    [0.46, 0], [0.42, 0.16], [0.34, 0.35], [-0.34, 0.35], [-0.42, 0.16], [-0.46, 0],
  ], curbMat);
  curb.receiveShadow = true;
  group.add(curb);

  // 은색 가드레일 빔 2단(팔각 근사 원형 튜브) — 야간에도 죽지 않게 발광 플로어
  const beamMat = new THREE.MeshStandardMaterial({
    color: 0xc8ccd2, roughness: 0.38, metalness: 0.55, emissive: 0x1c1e23,
  });
  const beamProf = (cy, r) => [
    [r, cy], [r * 0.7, cy + r * 0.7], [0, cy + r], [-r * 0.7, cy + r * 0.7],
    [-r, cy], [-r * 0.7, cy - r * 0.7], [0, cy - r], [r * 0.7, cy - r * 0.7],
  ];
  group.add(sweep(beamProf(0.62, 0.085), beamMat, true));
  group.add(sweep(beamProf(0.95, 0.085), beamMat, true));

  // 지주: 연석 위 ~4.2m 간격 (InstancedMesh 1개)
  const postGeo = new THREE.BoxGeometry(0.12, 0.72, 0.16);
  const postMat = new THREE.MeshLambertMaterial({ color: 0x9a9ea6 });
  const postM = [];
  let acc = 99;
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += samples[i].pos.distanceTo(samples[i - 1].pos);
    if (acc < 4.2) continue;
    acc = 0;
    const s = samples[i];
    postM.push(new THREE.Matrix4().makeTranslation(s.pos.x, s.pos.y + 0.35 + 0.36, s.pos.z));
  }
  if (postM.length) {
    const pim = new THREE.InstancedMesh(postGeo, postMat, postM.length);
    postM.forEach((m, i) => pim.setMatrixAt(i, m));
    pim.frustumCulled = false;
    group.add(pim);
  }

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
