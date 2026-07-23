// 강(한강) 횡단 구간 — 수면·둔치·강변도로(장식)·교량 아치.
// 본선 다리 밑을 지나는 분기(올림픽대로)와의 간섭은 hasBranch로 조정.

import * as THREE from 'three';
import { pick, range } from '../../utils/rng.js';
import { buildRoadMesh } from '../trackGenerator.js';
import {
  CONE_HEIGHT, UP, addInstanced, canvasTex, composeMatrix,
  lightPoolTexture, makeConeMaterial, mkCarGeo, mkPairGeo,
} from './common.js';

export function buildRiverCrossing(scene, rng, samples, river, bankSpots, updaters, hasBranch = false, palette = null, lampHeads = null) {
  const { x0, x1, zBridge } = river;
  const bbox = new THREE.Box3();
  samples.forEach((s) => bbox.expandByPoint(s.pos));
  const cz = (bbox.min.z + bbox.max.z) / 2;
  const riverLen = (bbox.max.z - bbox.min.z) + 1300;

  // 수면: 하늘 환경맵을 반사하는 매끈한 재질 + 흐르는 잔물결 노멀맵.
  // 시점에 따라 지평선 빛이 어려 '물'로 읽힌다. (평면 1장 — 비용 미미)
  const rip = canvasTex(256, 256, (ctx) => {
    ctx.fillStyle = 'rgb(128,128,255)';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1100; i++) {
      const r = 100 + Math.floor(Math.random() * 56);
      const g = 100 + Math.floor(Math.random() * 56);
      ctx.fillStyle = `rgba(${r},${g},255,0.35)`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * 256, Math.random() * 256,
        2 + Math.random() * 9, 1 + Math.random() * 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  rip.wrapS = rip.wrapT = THREE.RepeatWrapping;
  rip.repeat.set(22, 110);
  // 주의: 스침각에서 환경반사가 세면 수면 전체가 뿌옇게(안개처럼) 떠 보인다
  // 노을: 수면이 하늘 주황을 받아 밝게 일렁이도록 색·반사 강화
  const duskWater = palette?.tod === 'dusk';
  const waterMat = new THREE.MeshStandardMaterial({
    color: duskWater ? 0x241d33 : 0x0b1a33, roughness: 0.32, metalness: 0.0,
    normalMap: rip, normalScale: new THREE.Vector2(0.35, 0.35),
  });
  waterMat.envMapIntensity = duskWater ? 0.9 : 0.28; // 노을: 전역 env 감쇠 보상(수면만 노을 반사 유지)
  // 실제 물결: 세분화한 평면을 정점 셰이더에서 사인파 3겹으로 출렁이게 한다.
  // 진폭 합 ≈ ±0.3m — 호안 턱(상단 1.35m)을 넘지 않는 잔잔한 강 스웰.
  const waterTime = { value: 0 };
  waterMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        // 평면 로컬 xy 기준 파고와 기울기(해석적 법선용)를 함께 계산
        vec3 waveHD(vec2 p, float t) {
          vec3 hd = vec3(0.0); // (h, dh/dx, dh/dy)
          vec2 k1 = vec2(0.24, 0.10); float a1 = 0.15, w1 = t * 1.1;
          vec2 k2 = vec2(-0.13, 0.31); float a2 = 0.09, w2 = t * 0.75;
          vec2 k3 = vec2(0.42, -0.27); float a3 = 0.05, w3 = t * 1.7;
          float s1 = dot(p, k1) + w1, s2 = dot(p, k2) + w2, s3 = dot(p, k3) + w3;
          hd.x = a1 * sin(s1) + a2 * sin(s2) + a3 * sin(s3);
          hd.y = a1 * cos(s1) * k1.x + a2 * cos(s2) * k2.x + a3 * cos(s3) * k3.x;
          hd.z = a1 * cos(s1) * k1.y + a2 * cos(s2) * k2.y + a3 * cos(s3) * k3.y;
          return hd;
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vec3 whd = waveHD(position.xy, uTime);
        objectNormal = normalize(vec3(-whd.y, -whd.z, 1.0));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.z += whd.x;`);
  };
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(x1 - x0, riverLen, 72, 360), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set((x0 + x1) / 2, -0.02, cz);
  scene.add(water);
  updaters.push((t) => { // 잔물결 노멀맵은 느리게 흐르고, 스웰은 시간 uniform으로
    waterTime.value = t;
    rip.offset.y = (t * 0.014) % 1;
    rip.offset.x = (t * 0.005) % 1;
  });

  // 달빛 밴드는 은은하게만 (수면 리얼리즘은 환경맵 반사가 담당)
  const sheenTex = canvasTex(128, 16, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(150,180,235,0)');
    g.addColorStop(0.5, 'rgba(170,200,245,0.07)');
    g.addColorStop(1, 'rgba(150,180,235,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  const sheen = new THREE.Mesh(
    new THREE.PlaneGeometry((x1 - x0) * 0.85, riverLen),
    new THREE.MeshBasicMaterial({
      map: sheenTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: true,
    })
  );
  sheen.rotation.x = -Math.PI / 2;
  sheen.position.set((x0 + x1) / 2, 0.42, cz); // 물결 최고점(~0.28) 위
  scene.add(sheen);

  // 호안(콘크리트 둔치 턱): 물과 뭍의 경계를 또렷하게
  const ledgeMat = new THREE.MeshLambertMaterial({ color: 0x24272f });
  for (const [lx, side] of [[x0, -1], [x1, 1]]) {
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(9, 1.6, riverLen), ledgeMat);
    ledge.position.set(lx + side * 4.5, 0.55, cz);
    scene.add(ledge);
  }

  // 강변 산책로 조명: 양안을 따라 따뜻한 불빛 점(한강공원 감성). 다리 부근은 비움.
  const walkMats = [];
  const walkPts = []; // 수면 반사 스트릭용 { z, side }
  for (let wz = cz - riverLen / 2 + 30; wz < cz + riverLen / 2 - 30; wz += 21) {
    if (Math.abs(wz - zBridge) < 70) continue;
    for (const [lx, side] of [[x0, -1], [x1, 1]]) {
      const jz = wz + range(rng, -3, 3);
      // 서안 합류 차선(x0-7.5 라인, 램프 하강~테이퍼)이 지나는 구간은 산책로 등 스킵
      if (hasBranch && side < 0 && jz < zBridge - 190 && jz > zBridge - 390) continue;
      walkMats.push(new THREE.Matrix4().compose(
        new THREE.Vector3(lx + side * 7.5, 1.9, jz),
        new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      walkPts.push({ z: jz, side });
    }
  }
  if (walkMats.length) addInstanced(scene, new THREE.SphereGeometry(0.26, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xffd9a2, fog: true }), walkMats);
  // 산책로 등은 공중에 뜬 광구가 아니라 기둥 위 보행등으로 — 기둥만 아래에 세운다
  if (walkMats.length) {
    const poleLocal = new THREE.Matrix4().makeTranslation(0, -0.95, 0);
    addInstanced(scene, new THREE.CylinderGeometry(0.045, 0.06, 1.8, 6),
      new THREE.MeshLambertMaterial({ color: 0x2e3138 }),
      walkMats.map((m) => m.clone().multiply(poleLocal)));
  }

  // 반사 스트릭 공용 리소스 (아래 여러 섹션에서 사용 — 반드시 먼저 선언)
  // 밝은 끝(+V)이 +X를 향하게 굽기 → 동안(x1)용. 서안은 yaw 180°로 뒤집는다.
  const streakTex = canvasTex(32, 128, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,225,170,0.6)');
    g.addColorStop(0.45, 'rgba(255,210,150,0.2)');
    g.addColorStop(1, 'rgba(255,205,140,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 128);
  });
  const streakGeo = new THREE.PlaneGeometry(1, 1);
  streakGeo.rotateX(-Math.PI / 2);
  streakGeo.rotateY(-Math.PI / 2);
  const flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  // ── 수면 디테일: 글리터(광점) 2겹 + 달빛 글린트 + 다리 불빛 반사 글로우 ──
  // 글리터: 작은 광점 타일 2장이 서로 다른 속도로 흘러 물이 일렁이는 느낌을 만든다
  const glintTex = canvasTex(256, 256, (ctx) => {
    for (let i = 0; i < 240; i++) {
      ctx.fillStyle = `rgba(200,220,255,${0.25 + Math.random() * 0.55})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256,
        1 + Math.random() * 2, 1 + Math.random() * 1.5);
    }
  });
  glintTex.wrapS = glintTex.wrapT = THREE.RepeatWrapping;
  glintTex.repeat.set(10, 52);
  const glintTex2 = glintTex.clone();
  glintTex2.needsUpdate = true;
  glintTex2.repeat.set(14, 66);
  const mkGlint = (tex, op, y) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(x1 - x0, riverLen),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: op,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
      })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set((x0 + x1) / 2, y, cz);
    scene.add(m);
  };
  mkGlint(glintTex, 0.3, 0.44);  // 물결 최고점 위 (뚫고 나오면 구멍처럼 보임)
  mkGlint(glintTex2, 0.18, 0.46);
  updaters.push((t) => {
    glintTex.offset.y = (t * 0.010) % 1;
    glintTex.offset.x = (t * 0.004) % 1;
    glintTex2.offset.y = (-t * 0.007) % 1;
    glintTex2.offset.x = (t * 0.0025) % 1;
  });

  // (달빛 글린트 패치는 안개처럼 보여서 제거)

  // 다리 불빛의 수면 반사: 다리 라인을 따라 따뜻한 글로우 밴드
  const bglowTex = canvasTex(16, 128, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,215,160,0)');
    g.addColorStop(0.5, 'rgba(255,215,160,0.34)');
    g.addColorStop(1, 'rgba(255,215,160,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  const bglow = new THREE.Mesh(
    new THREE.PlaneGeometry(x1 - x0, 44),
    new THREE.MeshBasicMaterial({
      map: bglowTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: true,
    })
  );
  bglow.rotation.x = -Math.PI / 2;
  bglow.position.set((x0 + x1) / 2, 0.45, zBridge); // 물결(최고 ~0.28) 위
  scene.add(bglow);

  // ── 강변도로(강변북로·올림픽대로): 왕복 4차선 아스팔트(황색 중앙복선·차로 점선)
  //    + 실물 가로등(기둥/암/헤드/볼륨콘/빛웅덩이) + 콘크리트 방호벽
  //    + 차체 있는 차량(전조/후미등 쌍) — "떠 있는 광구·점 불빛" 전면 교체 ──
  const ROAD_W = 14.6;
  const zNorth = cz + riverLen * 0.48;
  const zSouth = cz - riverLen * 0.48;
  // 서안 도로는 남북 전장 '하나의' 왕복 도로(사용자 요청 — 기존 이중 도로 제거).
  // 분기 램프는 도로 위를 고가로 횡단해 동측(강측)에 합류 차선으로 붙었다가
  // 테이퍼로 사라진다(branchRoad.js) — 그 구간만 동측 방호벽·가로등을 연다.
  const mergeHole = hasBranch ? { side: 1, z0: zBridge - 380, z1: zBridge - 160 } : null;
  const roadRuns = [
    { rx: x0 - 16, z0: zSouth, z1: zNorth, side: -1, hole: mergeHole, noSouthCars: hasBranch },
    { rx: x1 + 16, z0: zSouth, z1: zNorth, side: 1 },
  ];
  const railMat = new THREE.MeshLambertMaterial({ color: 0x4a4e58 });
  for (const run of roadRuns) {
    // 본선과 완전히 같은 도로(사용자 요청): buildRoadMesh + createRoadTexture
    // (아스팔트 골재·얼룩·크랙·마모 흰 실선/점선, MeshStandard 톤 동일)
    const rvSamples = [];
    for (let z = run.z0; z <= run.z1; z += 8) {
      rvSamples.push({
        pos: new THREE.Vector3(run.rx, 0, z),
        // 게임 규약: left = (-tan.z, 0, tan.x) — 반대로 넣으면 winding이 뒤집혀
        // 노면이 백페이스 컬링돼 아예 안 보인다(빛웅덩이만 남는 함정)
        left: new THREE.Vector3(-1, 0, 0),
        tangent: new THREE.Vector3(0, 0, 1),
      });
    }
    const road = buildRoadMesh(rvSamples, ROAD_W, 2); // 왕복 4차선(방향별 2차선)
    if (palette?.tod === 'dusk') road.material.envMapIntensity = 0.35; // 본선과 동일 보정
    // 강변은 본선보다 가로등 실광원 밀도가 낮다(합류 구간은 동측 스킵) — 은은한 플로어만
    road.material.emissive.setHex(0x15171c);
    road.material.emissiveIntensity = 1.0;
    scene.add(road);
    // 콘크리트 방호벽 양측 — 합류 구간(hole)은 그 측만 분절해서 연다
    for (const s of [-1, 1]) {
      const hole = run.hole && run.hole.side === s ? run.hole : null;
      const segs = hole ? [[run.z0, hole.z0], [hole.z1, run.z1]] : [[run.z0, run.z1]];
      for (const [a, b] of segs) {
        if (b - a < 4) continue;
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.85, b - a), railMat);
        rail.position.set(run.rx + s * (ROAD_W / 2 + 0.42), 0.42, (a + b) / 2);
        scene.add(rail);
      }
    }
  }

  // 강변 가로등: 본선과 같은 실물 부품 인스턴싱(지그재그 양측).
  // 도로가 전장 하나이므로 별도 분기 구간 가로등은 없다 — 합류 구간 서측만 스킵
  // (합류 차선이 지나는 자리, branchRoad.js의 연석·차선이 대신 채운다).
  const lampRuns = roadRuns.map((r) => ({ ...r, w: ROAD_W }));
  const rvLampM = [], rvPoolM = [];
  const flatQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  let rvIdx = 0;
  for (const run of lampRuns) {
    for (let wz = run.z0 + 14; wz < run.z1 - 8; wz += 34) {
      const lside = rvIdx++ % 2 === 0 ? 1 : -1;
      if (run.hole && lside === run.hole.side && wz > run.hole.z0 && wz < run.hole.z1) continue;
      const px = run.rx + lside * (run.w / 2 + 0.9);
      const yaw = lside > 0 ? -Math.PI / 2 : Math.PI / 2; // 헤드(로컬 +z)가 도로 중앙으로
      const lm = composeMatrix(new THREE.Vector3(px, 0, wz), yaw);
      rvLampM.push(lm);
      // 실광원 풀 후보 등록 — 없으면 강변도로(MeshStandard)가 새까맣게 남는다(본선과 동일 체계)
      if (lampHeads) lampHeads.push(new THREE.Vector3(0, 5.0, 1.75).applyMatrix4(lm));
      rvPoolM.push(new THREE.Matrix4().compose(
        new THREE.Vector3(run.rx + lside * (run.w / 2 - 2.4), 0.05, wz),
        flatQ, new THREE.Vector3(1, 1, 1)));
    }
  }
  const rvPoleMat = new THREE.MeshLambertMaterial({ color: 0x3a3d47 });
  const rvConeMat = makeConeMaterial();
  const rvDusk = palette?.tod === 'dusk';
  if (rvDusk) rvConeMat.uniforms.uIntensity.value = 0.16;
  const rvParts = [
    { geo: new THREE.CylinderGeometry(0.12, 0.16, 5.2, 8), mat: rvPoleMat, local: [0, 2.6, 0] },
    { geo: new THREE.BoxGeometry(0.16, 0.16, 2.0), mat: rvPoleMat, local: [0, 5.1, 0.9] },
    { geo: new THREE.BoxGeometry(0.42, 0.14, 0.68), mat: new THREE.MeshBasicMaterial({ color: 0xfff1d4 }), local: [0, 5.0, 1.75] },
    { geo: new THREE.CylinderGeometry(0.28, 3.6, CONE_HEIGHT, 24, 1, true), mat: rvConeMat, local: [0, 2.35, 1.75] },
  ];
  for (const part of rvParts) {
    const lm = new THREE.Matrix4().makeTranslation(part.local[0], part.local[1], part.local[2]);
    addInstanced(scene, part.geo, part.mat, rvLampM.map((m) => m.clone().multiply(lm)));
  }
  addInstanced(scene, new THREE.PlaneGeometry(22, 22), new THREE.MeshBasicMaterial({
    map: lightPoolTexture(), transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: rvDusk ? 0.4 : 1,
  }), rvPoolM);

  // 강변도로 차량: 점 불빛이 아니라 차체+전조/후미등 쌍. 우측통행(북행=서측 차로).
  const cars = [];
  for (const run of roadRuns) {
    const L = run.z1 - run.z0 - 30;
    const per = Math.round(L / 38); // 방향당 밀도(평균 차간 ~38m)
    // 서안(플레이어가 동측 반부를 남행): 남행 가짜 차는 플레이어 반부를 침범하므로
    // 북행(서측 반부, 표준 우측통행 배치)만 남긴다.
    // ⚠ 임시(사용자 테스트): 서안 대향 차량 비활성 — 되살리려면 []를 [1]로
    const dirs = run.noSouthCars ? [] : [1, -1];
    for (const dir of dirs) {
      for (let k = 0; k < per; k++) {
        const spd = 22 + rng() * 14; // 고속화도로 속도 — 느리면 멈춘 듯 보임
        const off = rng() * L;
        const lane = rng() < 0.55 ? 1.83 : 5.45; // 본선 텍스처 4차선 중심(±1.825/±5.475)에 정렬
        cars.push({ run, dir, spd, off, lane, L });
        // 앞차를 따라가는 플래툰 — 흐르는 교통 느낌
        if (rng() < 0.35) cars.push({ run, dir, spd, off: off - 8 - rng() * 10, lane, L });
      }
    }
  }
  const bodyIm = new THREE.InstancedMesh(mkCarGeo(),
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0e1016 }), cars.length);
  const headIm = new THREE.InstancedMesh(mkPairGeo(0.17, 0.62, 2.16),
    new THREE.MeshBasicMaterial({ color: 0xfff2cf, fog: true }), cars.length);
  const tailIm = new THREE.InstancedMesh(mkPairGeo(0.14, 0.66, -2.16),
    new THREE.MeshBasicMaterial({ color: 0xff3a3a, fog: true }), cars.length);
  const carTones = [0x2e3138, 0x3a3f4a, 0x23262e, 0x424855, 0x555b66, 0x2b2f3d];
  const _col = new THREE.Color();
  for (const im of [bodyIm, headIm, tailIm]) {
    im.frustumCulled = false;
    scene.add(im);
  }
  for (let i = 0; i < cars.length; i++) bodyIm.setColorAt(i, _col.set(pick(rng, carTones)));
  if (bodyIm.instanceColor) bodyIm.instanceColor.needsUpdate = true;
  // 차량 불빛의 수면 반사: 북행(흰)·남행(붉은) 스트릭이 차를 따라다닌다
  const nNorth = cars.filter((c) => c.dir > 0).length;
  const mkReflIm = (hex, count) => {
    const im = new THREE.InstancedMesh(streakGeo, new THREE.MeshBasicMaterial({
      map: streakTex, color: hex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    }), count);
    im.frustumCulled = false;
    scene.add(im);
    return im;
  };
  const whiteRefl = mkReflIm(0xfff2cf, nNorth);
  const redRefl = mkReflIm(0xff5a5a, cars.length - nNorth);
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const qSouth = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
  const _sc = new THREE.Vector3(13, 1, 1.7);
  const _p = new THREE.Vector3();
  const _one = new THREE.Vector3(1, 1, 1);
  updaters.push((t) => {
    let wi = 0, ri = 0;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const dz = (t * c.spd + (c.off % c.L) + c.L) % c.L;
      const z = c.dir > 0 ? c.run.z0 + 15 + dz : c.run.z1 - 15 - dz;
      const x = c.run.rx - c.dir * c.lane; // 우측통행: 북행(+z)이 -x측(서측)
      _m4.compose(_p.set(x, 0.01, z), c.dir > 0 ? _q.identity() : qSouth, _one);
      bodyIm.setMatrixAt(i, _m4);
      headIm.setMatrixAt(i, _m4);
      tailIm.setMatrixAt(i, _m4);
      const reflX = c.run.side < 0 ? x0 + 8.5 : x1 - 8.5;
      const rq = c.run.side < 0 ? flipQ : _q.identity();
      _m4.compose(_p.set(reflX, 0.43, z), rq, _sc);
      if (c.dir > 0) whiteRefl.setMatrixAt(wi++, _m4);
      else redRefl.setMatrixAt(ri++, _m4);
    }
    bodyIm.instanceMatrix.needsUpdate = true;
    headIm.instanceMatrix.needsUpdate = true;
    tailIm.instanceMatrix.needsUpdate = true;
    whiteRefl.instanceMatrix.needsUpdate = true;
    redRefl.instanceMatrix.needsUpdate = true;
  });

  // 수면 반사 스트릭: 강변 빌딩(bankSpots) 불빛이 강 안쪽으로 길게 번짐 (additive)
  const streakMats = [];
  const streakColors = [];
  const pushStreak = (side, z, len, w, color) => {
    const cx2 = side > 0 ? x1 - len / 2 - 2 : x0 + len / 2 + 2;
    streakMats.push(new THREE.Matrix4().compose(
      new THREE.Vector3(cx2, 0.44, z),
      side > 0 ? new THREE.Quaternion() : flipQ,
      new THREE.Vector3(len, 1, w)
    ));
    streakColors.push(color);
  };
  // (빌딩 불빛의 수면 반사는 뺐음 — 산책로·차량·다리 불빛 반사만 유지)
  // 산책로 조명의 짧은 반사 (한 칸 걸러 하나)
  for (let i = 0; i < walkPts.length; i += 2) {
    pushStreak(walkPts[i].side, walkPts[i].z, 9 + rng() * 6, 1.6,
      new THREE.Color(1.1, 0.95, 0.7));
  }
  if (streakMats.length) addInstanced(scene, streakGeo, new THREE.MeshBasicMaterial({
    map: streakTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: true,
  }), streakMats, { colors: streakColors });
}

// 플레이어 도로 위의 교량 아치(양화대교 드레싱):
// 강을 건너는 샘플 구간을 3스팬으로 나눠, 도로 양옆에 사인 아치 리브 + 행어를 세운다.
export function buildBridgeArches(scene, samples, river, parapetOffset) {
  const n = samples.length;
  let ia = -1, ib = -1;
  for (let i = 0; i < n; i++) {
    const x = samples[i].pos.x;
    if (x >= river.x0 - 6 && x <= river.x1 + 6) {
      if (ia < 0) ia = i;
      ib = i;
    }
  }
  if (ia < 0 || ib - ia < 20) return;

  // 성산대교풍: 붉은 아치 + 아치를 따라 흐르는 전구 스트링 + 데크 조명
  const steel = new THREE.MeshLambertMaterial({ color: 0x8a2d26 });
  const off = parapetOffset + 0.7;   // 아치 리브 측면 오프셋(파라펫 바로 바깥)
  const ARCH_H = 17, SPANS = 3, SEG = 12;
  const archMats = [];
  const hangerMats = [];
  const bulbMats = [];
  const at = (fi) => samples[Math.max(0, Math.min(n - 1, Math.round(fi)))];

  for (let a = 0; a < SPANS; a++) {
    const sA = ia + ((ib - ia) / SPANS) * a;
    const sB = ia + ((ib - ia) / SPANS) * (a + 1);
    for (let k = 0; k < SEG; k++) {
      const f0 = sA + ((sB - sA) * k) / SEG;
      const f1 = sA + ((sB - sA) * (k + 1)) / SEG;
      const smp0 = at(f0), smp1 = at(f1);
      const h0 = Math.sin((k / SEG) * Math.PI) * ARCH_H;
      const h1 = Math.sin(((k + 1) / SEG) * Math.PI) * ARCH_H;
      for (const side of [-1, 1]) {
        // 서단(마지막 스팬) 우측 리브는 진출차로(증설 차선) 회랑을 관통하므로 바깥으로.
        // 스팬 경계는 기부(h=0)라 옆 스팬과의 어긋남이 티 나지 않는다.
        const o2 = a === SPANS - 1 && side === 1 ? off + 2.9 : off;
        const p0 = smp0.pos.clone().addScaledVector(smp0.left, o2 * side).add(new THREE.Vector3(0, h0, 0));
        const p1 = smp1.pos.clone().addScaledVector(smp1.left, o2 * side).add(new THREE.Vector3(0, h1, 0));
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        const d = p1.clone().sub(p0);
        const hDist = Math.hypot(d.x, d.z);
        const yaw = Math.atan2(d.x, d.z);
        const pitch = -Math.atan2(d.y, hDist);
        archMats.push(new THREE.Matrix4().compose(
          mid,
          new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')),
          new THREE.Vector3(1.0, 1.0, d.length() + 0.5)
        ));
        // 아치 전구 스트링: 각 세그먼트 이음마다 따뜻한 전구
        bulbMats.push(new THREE.Matrix4().compose(
          p0.clone().add(new THREE.Vector3(0, 0.8, 0)),
          new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      }
      // 행어(아치→데크 세로 케이블)
      if (k > 0 && k % 2 === 0 && h0 > 2.5) {
        for (const side of [-1, 1]) {
          const oH = a === SPANS - 1 && side === 1 ? off + 2.9 : off;
          const base = smp0.pos.clone().addScaledVector(smp0.left, oH * side);
          hangerMats.push(new THREE.Matrix4().compose(
            base.add(new THREE.Vector3(0, h0 / 2, 0)),
            new THREE.Quaternion(),
            new THREE.Vector3(0.2, h0, 0.2)
          ));
        }
      }
    }
  }
  // 데크 조명 스트링: 다리 구간의 파라펫 위 전구 행렬 (작게 — 크면 공처럼 떠 보임)
  for (let i = ia; i <= ib; i += 3) {
    const s = samples[i];
    for (const side of [-1, 1]) {
      bulbMats.push(new THREE.Matrix4().compose(
        s.pos.clone().addScaledVector(s.left, (parapetOffset - 0.1) * side)
          .add(new THREE.Vector3(0, 1.5, 0)),
        new THREE.Quaternion(), new THREE.Vector3(0.5, 0.5, 0.5)));
    }
  }
  addInstanced(scene, new THREE.BoxGeometry(1, 1, 1), steel, archMats);
  if (hangerMats.length) addInstanced(scene, new THREE.BoxGeometry(1, 1, 1), steel, hangerMats);
  if (bulbMats.length) addInstanced(scene, new THREE.SphereGeometry(0.3, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xffd9a2 }), bulbMats);
}

// Blender 제작 3D 산맥 모델(mountain.glb)을 원경 배경으로 배치.
// GLB의 PBR 머티리얼(바위 텍스처+정점색)을 언릿 MeshBasic으로 바꿔
// 야간 조명과 무관하게 일정 밝기로 지평선에 보이게 한다.
// 개별 산맥 세그먼트(mountain_range.glb — Blender 제작, 양끝이 0으로 수렴하는 능선)를
// 루트를 감싸는 링 위에 여러 개 흩어 배치. 강 회랑에 걸리는 세그먼트는 건너뛰어
// 강이 지평선까지 자연스럽게 트인다(셰이더 절단 없음).
