// 분기 루트: 다리 서단 직후 우측 진출 램프 → 남쪽으로 충분히 빠진 뒤
// 완전한 360° 나선 루프(뺑글뺑글)로 지상까지 하강 → 서안 강변도로(올림픽대로)를
// 남쪽으로 쭉 — 재합류 없이 도로 끝이 곧 대체 목적지다.
// 본선과 같은 {pos, tangent, left} 샘플 규격을 쓰므로 클램프/추종 로직을 공유한다.

import * as THREE from 'three';

const BRANCH_WIDTH = 11; // 왕복 아닌 일방 2차선 램프 폭

// 분기 경로 생성. 전 구간이 강 좌표(x0, zBridge)에 고정이라 시드와 무관하게 안정적.
export function generateBranchRoute(mainSamples, river) {
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

  const pts = [
    S.pos.clone(),                     // 본선 위 (y14)
    P(232, zB - 6, S.pos.y),           // 우측으로 갈라짐 — 아직 데크 높이
    P(214, zB - 20, 13.4),             // 본선에서 떨어져 남쪽으로 방향 전환
    P(202, zB - 40, 12.6),
    P(196, zB - 62, 12.0),             // 남향 — 루프 진입
    // 반시계 360° 나선 루프 (중심 (238, zB-68), R≈42) — 본선과 안 겹치는 남쪽
    P(208, zB - 98, 10.6),
    P(238, zB - 110, 9.3),
    P(268, zB - 98, 8.0),
    P(281, zB - 68, 6.7),
    P(268, zB - 38, 5.4),
    P(238, zB - 26, 4.2),
    P(208, zB - 38, 3.2),
    P(195, zB - 68, 2.5),              // 한 바퀴 완료 — 다시 남향, 지상 근처
    // S자로 강변도로에 진입 후 올림픽대로 쭉
    P(200, zB - 108, 1.7),
    P(220, zB - 150, 0.9),
    P(rx, zB - 200, 0.5),
    P(rx, zB - 320, 0.5),
    P(rx, zB - 460, 0.5),
    P(rx, (zB - 600 + zEnd) / 2, 0.5),
    P(rx, zEnd, 0.5),
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
  return { samples, exitIdx, width: BRANCH_WIDTH };
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
export function buildBranchRoad(branch, mainSamples, mainWidth = 22) {
  const group = new THREE.Group();
  const { samples } = branch;
  const half = branch.width / 2;
  const n = samples.length;

  // 초입: 램프 리본을 본선 위에 그대로 겹쳐 그리면 노면 마킹이 이중으로 보여
  // "도로가 두 개"처럼 읽힌다 — 겹침 구간의 정점을 본선 우측 가장자리 밖으로
  // 밀어내 실제 진출로처럼 가장자리에서 벌어지는 쐐기(테이퍼)로 만든다.
  const innerLimit = mainWidth / 2 - 0.25;
  const clampN = Math.min(n, Math.round(150 / 2.6)); // 진출 후 ~150m까지만 검사
  const eI = branch.exitIdx;
  const jLo = Math.max(0, eI - 15);
  const jHi = Math.min(mainSamples.length, eI + Math.round(160 / 2.8));
  const latClamp = (v, minLat) => {
    let best = Infinity, bi = eI;
    for (let j = jLo; j < jHi; j++) {
      const q = mainSamples[j].pos;
      const d = (q.x - v.x) * (q.x - v.x) + (q.z - v.z) * (q.z - v.z);
      if (d < best) { best = d; bi = j; }
    }
    const m = mainSamples[bi];
    const lat = (v.x - m.pos.x) * m.left.x + (v.z - m.pos.z) * m.left.z;
    if (lat < minLat) {
      v.x += m.left.x * (minLat - lat);
      v.z += m.left.z * (minLat - lat);
    }
    return v;
  };

  // 노면 리본 — 본선과 겹치는 초입 구간에서 z-fight 하지 않게 살짝 띄운다
  const positions = [], uvs = [], indices = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (i > 0) dist += s.pos.distanceTo(samples[i - 1].pos);
    let l = s.pos.clone().addScaledVector(s.left, half);
    let r = s.pos.clone().addScaledVector(s.left, -half);
    if (i < clampN) {
      // 바깥 변에 최소 폭을 줘 시작점의 퇴화 삼각형(법선 NaN)을 막는다
      l = latClamp(l, innerLimit + 0.06);
      r = latClamp(r, innerLimit);
    }
    positions.push(l.x, l.y + 0.03, l.z, r.x, r.y + 0.03, r.z);
    uvs.push(0, dist / 14, 1, dist / 14);
    if (i < n - 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
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

  // 낮은 측벽(연석 느낌) — 클램프 경계의 시각 근거.
  // 초입은 본선 노면 위라 연석이 본선 차로를 가로지르므로 갈라진 뒤부터 시작한다.
  const curbMat = new THREE.MeshBasicMaterial({ color: 0x3a3d47, side: THREE.DoubleSide });
  const curbStart = Math.round(64 / 2.6); // 분기점에서 ~64m 지나서부터
  for (const side of [-1, 1]) {
    const cp = [], ci = [];
    for (let i = curbStart; i < n; i++) {
      const s = samples[i];
      const bx = s.pos.x + s.left.x * (half + 0.15) * side;
      const bz = s.pos.z + s.left.z * (half + 0.15) * side;
      cp.push(bx, s.pos.y, bz, bx, s.pos.y + 0.55, bz);
      if (i < n - 1) {
        const a = (i - curbStart) * 2;
        ci.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    cg.setIndex(ci);
    cg.computeVertexNormals();
    group.add(new THREE.Mesh(cg, curbMat));
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
    const px = s.pos.x + s.left.x * (half + 0.7);
    const pz = s.pos.z + s.left.z * (half + 0.7);
    poleM.push(new THREE.Matrix4().makeTranslation(px, s.pos.y + 2.3, pz));
    headM.push(new THREE.Matrix4().makeTranslation(
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

  // 진출 표지판: 본선 진출점 ~70m 전, 우측 갓길 (녹색 고속도로 표지)
  const segLen = (() => {
    let t = 0;
    for (let i = 1; i < mainSamples.length; i++) t += mainSamples[i].pos.distanceTo(mainSamples[i - 1].pos);
    return t / (mainSamples.length - 1);
  })();
  const signIdx = Math.max(0, branch.exitIdx - Math.round(70 / segLen));
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
  const sx = ms.pos.x + ms.left.x * 13.6;
  const sz = ms.pos.z + ms.left.z * 13.6;
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
