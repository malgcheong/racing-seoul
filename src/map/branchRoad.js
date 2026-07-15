// 분기 루트: 다리 서단 직후 우측 진출 램프 → 남쪽으로 충분히 빠진 뒤
// 완전한 360° 나선 루프(뺑글뺑글)로 지상까지 하강 → 서안 강변도로(올림픽대로)를
// 남쪽으로 쭉 — 재합류 없이 도로 끝이 곧 대체 목적지다.
// 본선과 같은 {pos, tangent, left} 샘플 규격을 쓰므로 클램프/추종 로직을 공유한다.

import * as THREE from 'three';

const BRANCH_WIDTH = 11; // 왕복 아닌 일방 2차선 램프 폭
// 실제 진출로 구조(사용자 레퍼런스 사진): 본선 우측에 진출 전용 차선이 하나 증설되고
// (4차선→5차선), 그 끝차선이 고어(분류점)에서 통째로 우측 램프로 빠진다.
const LANE_W = 3.9;       // 증설되는 진출 차선 폭
const TAPER_LEN = 40;     // 차선이 0→풀폭으로 열리는 테이퍼 길이
const APPROACH_LEN = 110; // 테이퍼 시작 → 고어점까지(평행 주행 구간 포함)

// 분기 경로 생성. 전 구간이 강 좌표(x0, zBridge)에 고정이라 시드와 무관하게 안정적.
export function generateBranchRoute(mainSamples, river, mainWidth = 30) {
  if (!river) return null;
  const n = mainSamples.length;
  const zB = river.zBridge;

  // 진출점: 다리 서단을 갓 벗어난 본선 샘플 (여기부터 우측으로 갈라진다)
  let exitIdx = -1;
  for (let i = 0; i < n; i++) {
    if (mainSamples[i].pos.x < river.x0 - 8 && mainSamples[i].pos.x > river.x0 - 40) {
      exitIdx = i;
      break;
    }
  }
  if (exitIdx < 0) return null;

  // 강변도로(장식 빌더와 같은 규칙: 트랙 bbox 기준)의 남쪽 끝 안쪽에서 종료
  let minZ = Infinity, maxZ = -Infinity;
  for (const s of mainSamples) {
    if (s.pos.z < minZ) minZ = s.pos.z;
    if (s.pos.z > maxZ) maxZ = s.pos.z;
  }
  const czRiver = (minZ + maxZ) / 2;
  const riverLen = (maxZ - minZ) + 1300;
  const zEnd = czRiver - riverLen * 0.48 + 80; // 도로 남단 조금 안쪽

  const S = mainSamples[exitIdx];
  const P = (x, z, y) => new THREE.Vector3(x, y, z);
  const rx = river.x0 - 16; // 서안 강변도로 중심선
  const innerLimit = mainWidth / 2 - 0.25;

  // 진출 차선 제어점: 테이퍼 시작부터 고어점까지 본선 우측 가장자리에 평행하게.
  // 중심 = 가장자리(innerLimit) + 현재 열린 폭의 절반 — 테이퍼에서 서서히 미끄러져 나온다.
  const segLen = S.pos.distanceTo(mainSamples[exitIdx - 1].pos);
  const aN = Math.round(APPROACH_LEN / segLen);
  const appPts = [];
  for (let k = 0; k <= aN; k += 3) {
    const m = mainSamples[Math.max(0, exitIdx - aN + k)];
    const d = k * segLen;
    const w = Math.min(LANE_W, (LANE_W * d) / TAPER_LEN);
    appPts.push(m.pos.clone().addScaledVector(m.left, innerLimit + Math.max(w, 0.12) / 2));
  }

  const pts = [
    ...appPts,                         // 증설 차선(본선 평행, y14) — 끝이 고어점
    P(216, zB - 28, 13.5),             // 고어 뒤 우측으로 완전히 갈라져 남쪽으로
    P(202, zB - 46, 12.6),
    P(196, zB - 64, 12.0),             // 남향 — 루프 진입
    // 반시계 360° 나선 루프 (중심 (238, zB-68), R≈42) — 출구 고도 5.6m 유지
    // (강변도로 위를 건너 동측(주행측) 반부로 합류해야 하므로 지상까지 안 내려간다)
    P(208, zB - 98, 10.9),
    P(238, zB - 110, 9.9),
    P(268, zB - 98, 9.0),
    P(281, zB - 68, 8.2),
    P(268, zB - 38, 7.4),
    P(238, zB - 26, 6.7),
    P(208, zB - 38, 6.1),
    P(195, zB - 68, 5.6),              // 한 바퀴 완료 — 다시 남향, 고가 유지
    // 강변도로 합류: 도로 위를 고가로 횡단(북행 반부 위 통과) → 동측(강측) 스트립으로
    // 하강 → 합류 차선(가속차선) 평행 진입 → 테이퍼에서 남행 차로(동측 반부)로 흡수.
    // 남행 주행측은 게임 우측통행 규칙상 동측(+left=+x) — 서측 합류는 역주행 배치였음
    P(206, zB - 116, 5.2),
    P(230, zB - 150, 4.6),
    P(249, zB - 182, 3.4),              // 도로 횡단 완료 — 동측 가장자리 상공
    P(rx + 9.0, zB - 215, 1.9),         // 합류 차선 라인(동측 가장자리+차선 반폭) 하강
    P(rx + 9.0, zB - 248, 0.8),
    P(rx + 9.0, zB - 278, 0.15),
    P(rx + 9.0, zB - 305, 0.06),        // 접지 — 평행 주행
    P(rx + 9.0, zB - 330, 0.05),        // 평행 끝 — 합류 테이퍼 시작
    P(rx + 5.2, zB - 355, 0.05),
    P(rx + 3.7, zB - 378, 0.05),        // 남행 반부 중심 — 이후 강변도로가 곧 노면
    P(rx + 3.7, zB - 470, 0.05),
    P(rx + 3.7, (zB - 600 + zEnd) / 2, 0.05),
    P(rx + 3.7, zEnd, 0.05),
  ];

  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  const approxLen = curve.getLength();
  const count = Math.max(120, Math.round(approxLen / 2.6));
  const samples = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const pos = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    // 본선과 같은 규격: left는 수평면 기준 (경사가 있어도 도로가 옆으로 안 기움)
    const left = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
    samples.push({ pos, tangent: tan.normalize(), left });
  }
  // 누적 거리(테이퍼 시작 기준)와 구간별 주행 클램프 반폭:
  // 진출차로 위에선 열린 차선 폭 안으로, 고어 뒤엔 램프 풀폭으로 완만히 확장
  const dists = new Array(count);
  dists[0] = 0;
  for (let i = 1; i < count; i++) dists[i] = dists[i - 1] + samples[i].pos.distanceTo(samples[i - 1].pos);
  const laneHalf = LANE_W / 2 - 0.3;
  const fullHalf = BRANCH_WIDTH / 2 - 1.1;
  // 주행 클램프는 비대칭(+lat = left 벡터 = 동측): 합류 차선에선 서쪽(도로 남행 반부)으로
  // 언제든 건너갈 수 있게 lo를 크게 연다 — "합류 차선에 갇혀 도로 접근 불가" 방지
  const clampLo = new Array(count);
  const clampHi = new Array(count);
  for (let i = 0; i < count; i++) {
    const d = dists[i];
    let lo, hi;
    if (d < APPROACH_LEN) {
      const w = Math.min(LANE_W, (LANE_W * d) / TAPER_LEN);
      const h = Math.max(1.1, w / 2 - 0.3);
      lo = -h; hi = h;
    } else {
      const t = Math.min(1, (d - APPROACH_LEN) / 55);
      const rampHalf = laneHalf + (fullHalf - laneHalf) * t;
      const dz = zB - samples[i].pos.z;
      if (dz < 115) { lo = -rampHalf; hi = rampHalf; }
      else if (dz < 215) { // 도로 횡단·하강(고가) — 대칭
        const h = fullHalf + (1.65 - fullHalf) * ((dz - 115) / 100);
        lo = -h; hi = h;
      } else if (dz < 295) { lo = -1.65; hi = 1.65; } // 아직 공중 하강 — 이탈 금지
      else if (dz < 330) { lo = -8.1; hi = 1.6; } // 접지 — 서쪽(남행 차로)으로 개방
      else if (dz < 378) {
        const t2 = (dz - 330) / 48;
        lo = -8.1 + (-2.75 - -8.1) * t2;
        hi = 1.6 + (2.75 - 1.6) * t2;
      } else { lo = -2.75; hi = 2.75; } // 강변도로 남행(동측) 반부 — 중앙선 안 넘게
    }
    clampLo[i] = lo;
    clampHi[i] = hi;
  }
  return {
    samples, exitIdx, width: BRANCH_WIDTH, dists, clampLo, clampHi,
    approachLen: APPROACH_LEN, taperLen: TAPER_LEN, laneW: LANE_W,
  };
}

// 일방 2차선 램프용 노면 텍스처 (중앙 점선 1줄 + 양끝 실선)
function branchRoadTexture() {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b2d34';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 2200; i++) {
    const v = 45 + Math.random() * 45;
    ctx.fillStyle = `rgba(${v},${v},${v + 5},${0.12 + Math.random() * 0.16})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  ctx.fillStyle = '#d8d8ce';
  ctx.fillRect(6, 0, 7, S);
  ctx.fillRect(S - 13, 0, 7, S);
  ctx.fillStyle = '#eeeee6';
  for (let y = 0; y < S; y += 64) ctx.fillRect(S / 2 - 4, y, 8, 38);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// 분기 도로 지오메트리 + 교각 + 가로등 + 진출 표지판을 묶은 그룹 생성
export function buildBranchRoad(branch, mainSamples, mainWidth = 22, river = null) {
  const group = new THREE.Group();
  group.userData.lampHeads = []; // 실광원 풀링용 헤드 위치(game.js가 본선 풀에 합류)
  const { samples } = branch;
  const half = branch.width / 2;
  const n = samples.length;
  // 합류(강변도로) 기하 상수 — decorations의 강변도로(ROAD_W 14.6, 중심 x0-16)와 정합
  const zB = river ? river.zBridge : 0;
  const roadEdgeE = river ? river.x0 - 16 + (14.6 / 2 - 0.25) : 0; // 도로 동측 가장자리 x

  // 진출차로 → 고어 → 램프: 리본 폭을 구간별로 바꾼다.
  // 진출차로 구간은 본선 우측 가장자리에 붙는 실제 차선 폭(테이퍼로 열림),
  // 고어 뒤 60m에 걸쳐 램프 풀폭으로 확장. 본선과 겹치지 않게 안쪽 변은
  // 본선 가장자리(innerLimit) 밖으로 클램프.
  const innerLimit = mainWidth / 2 - 0.25;
  const AP = branch.approachLen, TP = branch.taperLen, LW = branch.laneW;
  const eI = branch.exitIdx;
  const segLenM = (() => {
    let t = 0;
    for (let i = 1; i < mainSamples.length; i++) t += mainSamples[i].pos.distanceTo(mainSamples[i - 1].pos);
    return t / (mainSamples.length - 1);
  })();
  const jLo = Math.max(0, eI - Math.round(AP / segLenM) - 15);
  const jHi = Math.min(mainSamples.length, eI + Math.round(160 / segLenM));
  const nearestMain = (v) => {
    let best = Infinity, bi = eI;
    for (let j = jLo; j < jHi; j++) {
      const q = mainSamples[j].pos;
      const d = (q.x - v.x) * (q.x - v.x) + (q.z - v.z) * (q.z - v.z);
      if (d < best) { best = d; bi = j; }
    }
    return mainSamples[bi];
  };
  const latClamp = (v, minLat) => {
    const m = nearestMain(v);
    const lat = (v.x - m.pos.x) * m.left.x + (v.z - m.pos.z) * m.left.z;
    if (lat < minLat) {
      v.x += m.left.x * (minLat - lat);
      v.z += m.left.z * (minLat - lat);
    }
    return v;
  };
  // 리본 반폭: 진출차로 테이퍼 → 램프 풀폭 → (도로 횡단·하강) 차선 폭 → 테이퍼 소멸.
  // 합류 구간은 다리 남쪽 거리(dz) 기준 — 소멸 후 노면은 강변도로가 담당(도로 하나).
  const ribbonHalf = (d, z) => {
    if (d < AP) return Math.max(0.05, Math.min(LW, (LW * d) / TP) / 2);
    const rampHalf = THREE.MathUtils.lerp(LW / 2, half, Math.min(1, (d - AP) / 60));
    if (!river) return rampHalf;
    const dz = zB - z;
    if (dz < 115) return rampHalf;
    if (dz < 215) return THREE.MathUtils.lerp(half, LW / 2, (dz - 115) / 100);
    if (dz < 330) return LW / 2;
    if (dz < 375) return THREE.MathUtils.lerp(LW / 2, 0.05, (dz - 330) / 45);
    return 0;
  };

  // 노면 리본 — 본선과 겹치는 초입 구간에서 z-fight 하지 않게 살짝 띄운다
  const positions = [], uvs = [], indices = [];
  const edges = []; // {l, r, s} — 연석·고어 빗금에서 재사용
  let dist = 0;
  let ribRows = 0, ribDone = false;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (i > 0) dist += s.pos.distanceTo(samples[i - 1].pos);
    const hw = Math.max(0.02, ribbonHalf(dist, s.pos.z));
    let l = s.pos.clone().addScaledVector(s.left, hw);
    let r = s.pos.clone().addScaledVector(s.left, -hw);
    if (dist < AP + 150) {
      // 바깥 변에 최소 폭을 줘 시작점의 퇴화 삼각형(법선 NaN)을 막는다
      l = latClamp(l, innerLimit + 0.06);
      r = latClamp(r, innerLimit);
    }
    // 합류 차선(접지 후): 도로 동측 가장자리에 밀착 — 서측 변(r)이 도로 위로 못 들어가게
    const inMerge = river && zB - s.pos.z > 290;
    if (inMerge) {
      if (r.x < roadEdgeE) r.x = roadEdgeE;
      if (l.x < r.x + 0.06) l.x = r.x + 0.06;
    }
    edges.push({ l, r, s, d: dist });
    if (!ribDone) {
      // 보이는 폭만큼 텍스처 바깥쪽(가장자리부)만 쓴다 — 좁은 차선 한복판에
      // 중앙 점선·반대편 실선이 생기지 않게 (풀폭이 되면 전체 마킹이 나온다)
      const visW = Math.hypot(l.x - r.x, l.z - r.z);
      const uCut = Math.min(1, visW / branch.width);
      positions.push(l.x, l.y + 0.03, l.z, r.x, r.y + 0.03, r.z);
      uvs.push(0, dist / 14, uCut, dist / 14);
      ribRows++;
      // 합류 테이퍼 끝 — 리본 종료(이후는 강변도로 노면 하나만 남는다)
      if (river && ribbonHalf(dist, s.pos.z) <= 0 && zB - s.pos.z > 370) ribDone = true;
    }
  }
  for (let k = 0; k < ribRows - 1; k++) {
    const a = k * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: branchRoadTexture(), roughness: 0.85, metalness: 0.05,
  }));
  road.receiveShadow = true;
  group.add(road);

  // 측벽 — 클램프 경계의 시각 근거.
  // 바깥쪽(l): 본선 파라펫이 열린 자리를 잇는 램프 파라펫(같은 색+상단 발광 스트립,
  // 높이도 파라펫과 동일) — 진출 시작점에서 벽이 사라져 보이던 문제의 해법.
  // 안쪽(r): 고어 뒤부터 낮은 연석.
  const curbMat = new THREE.MeshBasicMaterial({ color: 0x3a3d47, side: THREE.DoubleSide });
  const rampParapetMat = new THREE.MeshBasicMaterial({ color: 0x31343e, side: THREE.DoubleSide });
  const rampLedMat = new THREE.MeshBasicMaterial({ color: 0xffd9a2, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const dStart = side > 0 ? 1 : AP + 64; // +1 = 바깥(l), -1 = 안쪽(r) — 바깥은 파라펫 갭 시작부터 즉시
    const cp = [], ci = [];
    const lp = [], li = []; // 바깥 상단 발광 스트립(본선 파라펫 LED 연속감)
    let seg = 0;
    for (let i = 0; i < n; i++) {
      if (edges[i].d < dStart) continue;
      const e = edges[i];
      // 합류 구간: 서측(r)은 접지 후 도로에 붙는 자리라 연석 금지(합류를 막는다),
      // 동측(l)은 합류 차선 바깥 방호벽으로 테이퍼 끝까지
      if (river && side < 0 && zB - e.s.pos.z > 292) continue;
      if (river && side > 0 && zB - e.s.pos.z > 368) continue;
      const bx = (side > 0 ? e.l.x : e.r.x) + e.s.left.x * 0.15 * side;
      const bz = (side > 0 ? e.l.z : e.r.z) + e.s.left.z * 0.15 * side;
      // 데크(고가) 구간은 본선 파라펫과 같은 높이, 지상은 낮은 연석
      const ch = side > 0 ? (e.s.pos.y > 3 ? 1.15 : 0.6) : 0.55;
      cp.push(bx, e.s.pos.y, bz, bx, e.s.pos.y + ch, bz);
      if (side > 0) lp.push(bx, e.s.pos.y + ch, bz, bx, e.s.pos.y + ch + 0.07, bz);
      if (seg > 0) {
        const a = (seg - 1) * 2;
        ci.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        if (side > 0) li.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      seg++;
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    cg.setIndex(ci);
    cg.computeVertexNormals();
    group.add(new THREE.Mesh(cg, side > 0 ? rampParapetMat : curbMat));
    if (side > 0 && lp.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      lg.setIndex(li);
      lg.computeVertexNormals();
      group.add(new THREE.Mesh(lg, rampLedMat));
    }
  }

  // 고어(분류점) 안전지대: 본선 가장자리와 램프 안쪽 변 사이 흰 빗금 쐐기 + 라바콘.
  // 레퍼런스 사진(올림픽대로 진출부)의 도류화 표시 재현.
  const goreP = [], goreUV = [], goreI = [];
  let gSeg = 0;
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    if (e.d < AP - 2 || e.d > AP + 95) continue;
    const m = nearestMain(e.r);
    const gapW = (e.r.x - m.pos.x) * m.left.x + (e.r.z - m.pos.z) * m.left.z - innerLimit;
    if (gapW > 7.5) break;      // 램프가 완전히 벌어짐 — 안전지대 끝
    if (gapW < 0.04) continue;  // 아직 고어 시작 전(변이 본선 가장자리에 밀착)
    goreP.push(
      m.pos.x + m.left.x * innerLimit, m.pos.y + 0.055, m.pos.z + m.left.z * innerLimit,
      e.r.x, e.r.y + 0.055, e.r.z);
    goreUV.push(0, e.d / 6, gapW / 7.5, e.d / 6);
    if (gSeg > 0) {
      const a = (gSeg - 1) * 2;
      goreI.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    gSeg++;
  }
  if (gSeg > 1) {
    const hatchCv = document.createElement('canvas');
    hatchCv.width = 128; hatchCv.height = 128;
    const hctx = hatchCv.getContext('2d');
    hctx.strokeStyle = 'rgba(225,228,235,0.9)';
    hctx.lineWidth = 10;
    for (let o = -128; o < 256; o += 44) { // 대각 빗금(도류선)
      hctx.beginPath(); hctx.moveTo(o, 128); hctx.lineTo(o + 128, 0); hctx.stroke();
    }
    const hatchTex = new THREE.CanvasTexture(hatchCv);
    hatchTex.wrapS = hatchTex.wrapT = THREE.RepeatWrapping;
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(goreP, 3));
    gg.setAttribute('uv', new THREE.Float32BufferAttribute(goreUV, 2));
    gg.setIndex(goreI);
    gg.computeVertexNormals();
    group.add(new THREE.Mesh(gg, new THREE.MeshBasicMaterial({
      map: hatchTex, transparent: true, opacity: 0.85, depthWrite: false, fog: true,
    })));
  }
  // 라바콘: 고어 직전~램프 초입, 램프 안쪽 변을 따라 (야간 시인성 발광 오렌지)
  const coneGeo = new THREE.CylinderGeometry(0.035, 0.16, 0.55, 8);
  const coneMat = new THREE.MeshLambertMaterial({
    color: 0xd2571c, emissive: 0x8a3410, emissiveIntensity: 0.9,
  });
  const coneM = [];
  let lastConeD = -99;
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    if (e.d < AP - 6 || e.d > AP + 58) continue;
    if (e.d - lastConeD < 5) continue;
    lastConeD = e.d;
    coneM.push(new THREE.Matrix4().makeTranslation(
      e.r.x - e.s.left.x * 0.45, e.s.pos.y + 0.27, e.r.z - e.s.left.z * 0.45));
  }
  if (coneM.length) {
    const cim = new THREE.InstancedMesh(coneGeo, coneMat, coneM.length);
    coneM.forEach((m, i) => cim.setMatrixAt(i, m));
    cim.frustumCulled = false;
    group.add(cim);
  }

  // (합류부는 고가로 도로를 횡단해 동측에서 접지하므로 지상 빗금 쐐기가 생기지 않는다
  //  — 테이퍼 소멸과 점선 경계만으로 충분)

  // 데크 하부(바닥판 + 양측 거더 스커트): 노면 리본은 윗면만 있어서
  // 아래·측면에서 보면 투명하게 뚫려 보인다(루프 건너편·도로 횡단부에서 티 남).
  // 고가 구간(접지 전) 전체를 얕은 박스 거더로 닫는다.
  const underMat = new THREE.MeshBasicMaterial({ color: 0x1b1d26, side: THREE.DoubleSide });
  const stripMesh = (rows) => {
    const p = [], si = [];
    rows.forEach((r2, k) => {
      p.push(...r2);
      if (k > 0) {
        const a = (k - 1) * 2;
        si.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(si);
    g.computeVertexNormals();
    return new THREE.Mesh(g, underMat);
  };
  const GIRDER = 0.6;
  const botRows = [], slRows = [], srRows = [];
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    if (e.s.pos.y < 0.45) break; // 접지 후 지상 구간은 불필요
    const yb = e.s.pos.y - GIRDER;
    botRows.push([e.l.x, yb, e.l.z, e.r.x, yb, e.r.z]);
    slRows.push([e.l.x, e.s.pos.y + 0.02, e.l.z, e.l.x, yb, e.l.z]);
    srRows.push([e.r.x, e.s.pos.y + 0.02, e.r.z, e.r.x, yb, e.r.z]);
  }
  if (botRows.length > 1) {
    group.add(stripMesh(botRows), stripMesh(slRows), stripMesh(srRows));
  }

  // 교각: 높이 있는 구간(램프·루프)에만. 나선이 자기 아래층을 지나는 자리는
  // 기둥이 아래 도로를 관통하므로 제외한다.
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x272a34 });
  const pierGeo = new THREE.BoxGeometry(2.4, 1, 2.0); // y는 스케일로
  const pierM = [];
  const overLowerDeck = (i) => {
    const p = samples[i].pos;
    for (let j = 0; j < n; j++) {
      if (Math.abs(i - j) < 20) continue;
      const q = samples[j].pos;
      if (q.y < p.y - 2.5 && Math.hypot(q.x - p.x, q.z - p.z) < 8) return true;
    }
    return false;
  };
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += samples[i].pos.distanceTo(samples[i - 1].pos);
    const y = samples[i].pos.y;
    if (branch.dists[i] < AP - 5) continue; // 진출차로는 본선 데크에 붙어있음 — 교각 불필요
    // 강변도로가 루프 아래·램프 횡단부 아래를 지난다 — 도로 노면 위에 교각 금지
    // (동측 하강 스트립(x≈rx+9)은 도로 밖이라 교각 허용 — 8.2 = 도로 반폭+여유)
    if (river && Math.abs(samples[i].pos.x - (river.x0 - 16)) < 8.2) continue;
    if (acc > 30 && y > 3.2) {
      acc = 0;
      if (overLowerDeck(i)) continue;
      pierM.push(new THREE.Matrix4().compose(
        new THREE.Vector3(samples[i].pos.x, y / 2 - 0.2, samples[i].pos.z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, y - 0.3, 1)));
    }
  }
  if (pierM.length) {
    const im = new THREE.InstancedMesh(pierGeo, pierMat, pierM.length);
    pierM.forEach((m, i) => im.setMatrixAt(i, m));
    im.frustumCulled = false;
    group.add(im);
  }

  // 간이 가로등: 폴 + 발광 헤드 (풀링 실광원 없이 발광 재질만 — 저렴)
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 4.6, 6);
  const headGeo = new THREE.BoxGeometry(0.4, 0.12, 0.6);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3d47 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffe9bc });
  const poleM = [], headM = [];
  acc = 0;
  for (let i = 1; i < n; i++) {
    acc += samples[i].pos.distanceTo(samples[i - 1].pos);
    if (acc < 42) continue;
    acc = 0;
    const s = samples[i];
    if (s.pos.y < 1.8) continue; // 강변 구간엔 기존 강변 가로등이 있음
    // 진출차로 구간(테이퍼 이후)부터 세운다 — 파라펫 개방으로 본선 우측 가로등이
    // 빠지는 자리라 여기가 없으면 차선이 어둡다. 리본 실제 바깥변 기준으로 배치
    // (풀폭 half 기준이면 좁은 진출차로에선 기둥이 데크 밖 허공에 뜬다).
    if (branch.dists[i] < 50) continue;
    const px = edges[i].l.x + s.left.x * 0.7;
    const pz = edges[i].l.z + s.left.z * 0.7;
    poleM.push(new THREE.Matrix4().makeTranslation(px, s.pos.y + 2.3, pz));
    headM.push(new THREE.Matrix4().makeTranslation(
      px - s.left.x * 0.9, s.pos.y + 4.6, pz - s.left.z * 0.9));
    // 실광원 풀링 후보(게임이 차 근처 3개에 PointLight를 옮겨 붙인다) —
    // 본선 lampHeads만 풀에 있으면 분기 노면이 새까맣게 남는다
    group.userData.lampHeads.push(new THREE.Vector3(
      px - s.left.x * 0.9, s.pos.y + 4.6, pz - s.left.z * 0.9));
  }
  if (poleM.length) {
    const pm = new THREE.InstancedMesh(poleGeo, poleMat, poleM.length);
    poleM.forEach((m, i) => pm.setMatrixAt(i, m));
    pm.frustumCulled = false;
    const hm = new THREE.InstancedMesh(headGeo, headMat, headM.length);
    headM.forEach((m, i) => hm.setMatrixAt(i, m));
    hm.frustumCulled = false;
    group.add(pm, hm);
  }

  // 진출 표지판: 진출차로 테이퍼가 열리기 전(고어 ~128m 전) 우측 갓길 (녹색 고속도로 표지)
  const signIdx = Math.max(0, branch.exitIdx - Math.round(128 / segLenM));
  const ms = mainSamples[signIdx];
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d6b3f';
  ctx.fillRect(0, 0, 512, 192);
  ctx.strokeStyle = '#e8f4ec';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, 496, 176);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('강변도로 · 올림픽대로', 256, 84);
  ctx.font = 'bold 52px sans-serif';
  ctx.fillText('출구 ↘', 256, 156);
  const signTex = new THREE.CanvasTexture(canvas);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(7.4, 2.8),
    new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide, fog: true })
  );
  const signLat = mainWidth / 2 + 2.6; // 갓길 바깥(도로 폭에 따라오게 — 13.6 고정값은 폭 32에서 도로 안)
  const sx = ms.pos.x + ms.left.x * signLat;
  const sz = ms.pos.z + ms.left.z * signLat;
  sign.position.set(sx, ms.pos.y + 5.6, sz);
  sign.rotation.y = Math.atan2(ms.tangent.x, ms.tangent.z) + Math.PI;
  group.add(sign);
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.15, 5.6, 8),
    new THREE.MeshLambertMaterial({ color: 0x3a3d47 })
  );
  post.position.set(sx, ms.pos.y + 2.8, sz);
  group.add(post);

  return group;
}
