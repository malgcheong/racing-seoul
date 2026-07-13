// 졸음쉼터: 고가도로 우측에 붙은 간이 휴게 플랫폼. 셸터 + 주차된 차 + 가로등 + 표지판.
// 게임 요소: 플레이어가 입구 구간에서 우측으로 빠져 발광 패드 근처에 잠깐 정차하면
// 졸음 게이지가 해소된다(game.js의 restIdx/restSpan 구간과 연동).

import * as THREE from 'three';

function parkedCar(color, x, z, rot) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.85 });
  const W = 2.0, L = 4.3, H = 0.7;
  const add = (geo, m, px, py, pz) => { const me = new THREE.Mesh(geo, m); me.position.set(px, py, pz); g.add(me); };
  add(new THREE.BoxGeometry(W, H, L), bodyMat, 0, 0.4 + H / 2, 0);
  add(new THREE.BoxGeometry(W * 0.82, 0.48, L * 0.42), bodyMat, 0, 0.4 + H + 0.24, -0.1);
  add(new THREE.BoxGeometry(W * 0.7, 0.32, L * 0.38), glass, 0, 0.4 + H + 0.28, -0.08);
  const wheel = new THREE.CylinderGeometry(0.4, 0.4, 0.32, 10);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const w = new THREE.Mesh(wheel, dark); w.rotation.z = Math.PI / 2;
    w.position.set(sx * (W / 2 - 0.02), 0.4, sz * (L * 0.32)); g.add(w);
  }
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function makeSign(x, z) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 3.2, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x8a8d95, roughness: 0.6, metalness: 0.4 })
  );
  post.position.y = 1.6; g.add(post);
  // 표지판 캔버스(녹색 도로표지)
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#12692f'; ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 240, 112);
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 52px "Malgun Gothic", sans-serif';
  ctx.fillText('졸음쉼터', 128, 52);
  ctx.font = '22px sans-serif';
  ctx.fillText('REST AREA', 128, 96);
  const tex = new THREE.CanvasTexture(cv);
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 1.6),
    new THREE.MeshBasicMaterial({ map: tex }) // 자체발광(야간 가독)
  );
  board.position.set(0, 3.0, 0);
  board.rotation.y = Math.PI; // 접근하는 차 쪽(-Z)을 향함
  g.add(board);
  g.position.set(x, 0, z);
  return g;
}

export function buildRestArea(scene, samples, idx) {
  const s = samples[idx];
  const group = new THREE.Group();
  group.position.copy(s.pos).addScaledVector(s.left, 15); // 우측(도로 가장자리~바깥)
  group.position.y = s.pos.y;
  group.rotation.y = Math.atan2(s.tangent.x, s.tangent.z); // 로컬 +Z = 트랙 진행

  const pave = new THREE.MeshStandardMaterial({ color: 0x34363d, roughness: 0.95 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x6b6e76, roughness: 0.9 });
  const skirt = new THREE.MeshStandardMaterial({ color: 0x202228, roughness: 1.0 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x2b6e4f, roughness: 0.7, metalness: 0.2 });
  const warm = new THREE.MeshStandardMaterial({ color: 0xfff0c8, emissive: 0xffe6a8, emissiveIntensity: 2.6 });

  const M = (geo, m, x, y, z) => { const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); group.add(me); return me; };

  // 주의: 그룹 로컬 +X는 left의 반대 = "도로 쪽". 바깥(우측 확장)은 -X 방향이다.
  // 플랫폼 + 진입/퇴출 테이퍼 램프를 한 다각형으로:
  // 갓길 경계(+4.5 = lateral 10.5)에서 바깥(-17.5 = lateral 32.5)까지,
  // 본체 z ±28, 양끝은 z ±52에서 도로 가장자리로 수렴(감속/가속차로).
  const outline = new THREE.Shape();
  outline.moveTo(4.5, -80);     // 진입 팁(도로 가장자리)
  outline.lineTo(-17.5, -40);   // 전방 바깥 코너
  outline.lineTo(-17.5, 40);    // 후방 바깥 코너
  outline.lineTo(4.5, 80);      // 퇴출 팁
  outline.closePath();          // 도로변 직선으로 복귀
  const plat = new THREE.Mesh(
    new THREE.ExtrudeGeometry(outline, { depth: 0.4, bevelEnabled: false }),
    pave
  );
  plat.rotation.x = Math.PI / 2; // (u,v)평면 → 수평, 상판이 y=0
  plat.receiveShadow = true;
  group.add(plat);
  // 고가 스커트(지지대처럼)
  M(new THREE.BoxGeometry(21, 4, 78), skirt, -6.5, -2.3, 0);
  // 도로 쪽은 입구(연석 없음). 바깥쪽 가장자리에만 낮은 경계
  M(new THREE.BoxGeometry(0.5, 0.5, 80), concrete, -17.5, 0.05, 0);

  // 셸터(기둥 4 + 지붕) — 안쪽 깊숙이
  const sh = new THREE.Group(); sh.position.set(-11, 0, -16);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.5, 0.25), concrete);
    post.position.set(sx * 2.4, 1.25, sz * 1.7); sh.add(post);
  }
  const rf = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.3, 4.4), roofMat);
  rf.position.y = 2.65; rf.castShadow = true; sh.add(rf);
  const bench = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 0.6), concrete);
  bench.position.set(-12, 0.35, -22); group.add(bench);
  group.add(sh);

  // 주차된 차들 — 바깥쪽 가장자리(진입로를 막지 않게)
  group.add(parkedCar(0x9aa0ad, -14.5, 20, 0.06));
  group.add(parkedCar(0xb14a3a, -14.5, 14.4, -0.05));
  group.add(parkedCar(0x3a5ea8, -14.5, 8.8, 0.04));
  group.add(parkedCar(0x556070, -14.5, 3.2, -0.04));

  // 정차 스팟: 은은하게 발광하는 패드(여기 근처에 서면 졸음 해소)
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 26),
    new THREE.MeshStandardMaterial({
      color: 0x123322, emissive: 0x2fd08a, emissiveIntensity: 0.55,
      transparent: true, opacity: 0.38,
    })
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(-3.5, 0.02, 3);
  group.add(pad);

  // 가로등 3개
  for (const lz of [-28, 0, 28]) {
    M(new THREE.BoxGeometry(0.2, 5, 0.2), concrete, -10, 2.5, lz);
    M(new THREE.BoxGeometry(1.3, 0.35, 0.6), warm, -10, 5, lz);
  }

  // 표지판(갓길 바로 바깥, 진입 램프 시작 부근)
  group.add(makeSign(3, -46));

  scene.add(group);
  return group;
}
