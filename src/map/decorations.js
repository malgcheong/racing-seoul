// 야간 고가도로 환경 오케스트레이터 (인스턴싱) — 도로변(가로등·파라펫·간판·
// 대향 차량·전광판)과 도시 블록 배치를 결정하고, 빌딩/강/산 생성은 env/* 모듈에 위임.
// 반복 오브젝트는 InstancedMesh로 묶어 수백 드로우콜을 종류당 1개로 줄인다.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pick, range } from '../utils/rng.js';
import { getAssetTemplate, instantiate } from '../utils/assets.js';
import {
  SHOULDER, PARAPET_HEIGHT, CONE_HEIGHT, UP, GHOST_CAR_TONES, NEON_SIGNS,
  lerpColor, minDistToTrack, minDistToTrackFar, trackRibbon, composeMatrix, addInstanced,
  canvasTex, lightPoolTexture, makeConeMaterial, neonSignTexture, gantrySignTexture,
  adStripTexture, mkCarGeo, mkPairGeo,
} from './env/common.js';
import { buildInstancedBuildings, buildInstancedTemplate, buildHouseClusters } from './env/buildings.js';
import { buildRiverCrossing, buildBridgeArches } from './env/river.js';
import { buildMountainRanges } from './env/terrain.js';

export function buildEnvironment(scene, rng, samples, palette, roadWidth, buildingGap = null, river = null, branchPts = null) {
  const halfW = roadWidth / 2;
  const parapetOffset = halfW + SHOULDER;
  const deckY = samples[0].pos.y;
  const n = samples.length;
  const updaters = []; // 매 프레임 호출되는 애니메이션 훅(전광판·점멸등 등)
  // buildingGap: { side, idx, halfSpan } 또는 그 배열 — 해당 구간(졸음쉼터·분기 진출입)엔 빌딩을 비운다
  const gaps = buildingGap ? (Array.isArray(buildingGap) ? buildingGap : [buildingGap]) : [];
  const inGap = (i, side) =>
    gaps.some((g) => side === g.side && Math.abs(i - g.idx) < g.halfSpan);
  // 분기 도로(램프·루프·강변 연결로) 주변 회피 — 건물·교각이 분기 위에 서지 않게
  const nearBranch = (x, z, r = 15) => {
    if (!branchPts) return false;
    for (const p of branchPts) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  // 강(교량) 구간 판정 — 이 x 범위엔 빌딩·갠트리·노면시설을 두지 않는다
  const inRiverX = (x, pad = 20) => river && x > river.x0 - pad && x < river.x1 + pad;
  const segLen = (() => {
    let total = 0;
    for (let i = 0; i < n; i++) total += samples[i].pos.distanceTo(samples[(i + 1) % n].pos);
    return total / n;
  })();

  // 루트 전체 범위 — 지면·산맥을 루트 중심에 맞춘다 (편도 루트는 원점에서 벗어남)
  const tb = new THREE.Box3();
  samples.forEach((s) => tb.expandByPoint(s.pos));
  const tcx = (tb.min.x + tb.max.x) / 2;
  const tcz = (tb.min.z + tb.max.z) / 2;
  const textent = Math.max(tb.max.x - tb.min.x, tb.max.z - tb.min.z) / 2;

  // 1) 지상: 야간 도시 바닥 (루트 중심, 루트보다 넉넉히 크게)
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(textent + 1500, 48),
    new THREE.MeshLambertMaterial({ color: lerpColor(palette.ground, 0x04050a, 0.8) })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(tcx, -0.05, tcz);
  ground.receiveShadow = true;
  scene.add(ground);

  // 2) 데크 갓길 포장
  const apron = new THREE.Mesh(
    trackRibbon(samples, { wHalf: parapetOffset + 0.35, yBase: -0.015 }),
    new THREE.MeshLambertMaterial({ color: 0x3c3e46 })
  );
  apron.receiveShadow = true;
  scene.add(apron);

  // 3) 데크 측면 스커트(거더) — 분기 진출입 구간은 뚫는다
  const skirtMat = new THREE.MeshBasicMaterial({ color: 0x1b1d26, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const sGap = gaps
      .filter((g) => g.side === side)
      .map((g) => ({ idx: g.idx, halfSpan: g.parapetSpan ?? g.halfSpan }));
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset + 0.35, side, height: 2.4, yBase: -2.4, gap: sGap }),
      skirtMat
    ));
  }
  // 3-2) 데크 바닥판 — 노면 리본은 윗면만 있어 아래(강변도로·램프 하부 통과)에서
  // 올려다보면 데크가 투명하게 뚫려 보인다. 스커트 하단 깊이에 맞춰 닫는다
  scene.add(new THREE.Mesh(
    trackRibbon(samples, { wHalf: parapetOffset + 0.35, yBase: -2.4 }),
    skirtMat
  ));

  // 4) 파라펫 + LED 스트립 + 젖은 노면 반사 밴드
  const parapetMat = new THREE.MeshBasicMaterial({ color: 0x31343e, side: THREE.DoubleSide });
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xffd9a2, side: THREE.DoubleSide });
  const stripReflMat = new THREE.MeshBasicMaterial({
    color: 0x241b0e, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  for (const side of [-1, 1]) {
    // 쉼터·분기 진출입 쪽엔 파라펫에 입구를 낸다 (램프 전체 구간)
    const pGap = gaps
      .filter((g) => g.side === side)
      .map((g) => ({ idx: g.idx, halfSpan: g.parapetSpan ?? g.halfSpan }));
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset, side, height: PARAPET_HEIGHT, gap: pGap }),
      parapetMat
    ));
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset, side, height: 0.12, yBase: PARAPET_HEIGHT, gap: pGap }),
      stripMat
    ));
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset - 1.0, side, wHalf: 0.9, yBase: 0.035, gap: pGap }),
      stripReflMat
    ));
  }

  // 5) 교각 (인스턴싱)
  const pierMatrices = [];
  const pierStep = Math.max(1, Math.round(38 / segLen));
  for (let i = 0; i < n; i += pierStep) {
    const s = samples[i];
    if (nearBranch(s.pos.x, s.pos.z, 12)) continue; // 분기가 고가 밑을 지나는 자리
    pierMatrices.push(composeMatrix(
      new THREE.Vector3(s.pos.x, deckY / 2 - 0.1, s.pos.z),
      Math.atan2(s.tangent.x, s.tangent.z)
    ));
  }
  addInstanced(scene, new THREE.BoxGeometry(3.6, deckY, 2.6),
    new THREE.MeshLambertMaterial({ color: 0x272a34 }), pierMatrices);

  // 6) 가로등 (파트별 인스턴싱: 기둥/암/헤드/볼륨콘/빛웅덩이)
  const lampHeads = [];
  const lampMatrices = [];
  const poolMatrices = [];
  const HEAD_LOCAL = new THREE.Vector3(0, 5.0, 1.75);
  const lampStep = Math.max(1, Math.round(30 / segLen));
  let lampIdx = 0;
  for (let i = 0; i < n; i += lampStep) {
    const s = samples[i];
    const side = lampIdx++ % 2 === 0 ? 1 : -1;
    // 졸음쉼터 확장 구간: 도로가 옆으로 넓어지므로 그 자리의 가로등이
    // 주행 공간 한가운데 서게 된다 — 쉼터 쪽 가로등은 건너뛴다(쉼터 자체 조명 있음)
    if (inGap(i, side)) continue;
    const pos = s.pos.clone().addScaledVector(s.left, (parapetOffset - 0.35) * side);
    const yaw = Math.atan2(-s.left.x * side, -s.left.z * side); // 헤드가 도로 쪽으로
    const m = composeMatrix(pos, yaw);
    lampMatrices.push(m);
    lampHeads.push(HEAD_LOCAL.clone().applyMatrix4(m));

    const poolPos = s.pos.clone()
      .addScaledVector(s.left, (parapetOffset - 2.1) * side)
      .setY(deckY + 0.04);
    poolMatrices.push(new THREE.Matrix4().compose(
      poolPos,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
      new THREE.Vector3(1, 1, 1)
    ));
  }

  const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3d47 });
  const lampParts = [
    { geo: new THREE.CylinderGeometry(0.12, 0.16, 5.2, 8), mat: poleMat, local: new THREE.Vector3(0, 2.6, 0) },
    { geo: new THREE.BoxGeometry(0.16, 0.16, 2.0), mat: poleMat, local: new THREE.Vector3(0, 5.1, 0.9) },
    { geo: new THREE.BoxGeometry(0.42, 0.14, 0.68), mat: new THREE.MeshBasicMaterial({ color: 0xfff1d4 }), local: new THREE.Vector3(0, 5.0, 1.75) },
    { geo: new THREE.CylinderGeometry(0.28, 3.6, CONE_HEIGHT, 24, 1, true), mat: makeConeMaterial(), local: new THREE.Vector3(0, 2.35, 1.75) },
  ];
  // 노을: 하늘이 아직 밝아 가로등 볼륨콘·빛웅덩이가 튀면 과하다 — 은은하게
  const duskDim = palette.tod === 'dusk';
  if (duskDim) lampParts[3].mat.uniforms.uIntensity.value = 0.16;
  for (const part of lampParts) {
    const localM = new THREE.Matrix4().makeTranslation(part.local.x, part.local.y, part.local.z);
    addInstanced(scene, part.geo, part.mat,
      lampMatrices.map((m) => m.clone().multiply(localM)));
  }
  addInstanced(scene, new THREE.PlaneGeometry(22, 22), new THREE.MeshBasicMaterial({
    map: lightPoolTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    opacity: duskDim ? 0.4 : 1,
  }), poolMatrices);

  // 7) 지상 빌딩 스카이라인 (외벽은 절차적 창문 셰이더, 색은 instanceColor)
  //    + 2단 셋백 타워, 옥상 프롭(물탱크·실외기·안테나·항공장애등), 도로변 네온 간판
  const buildingLists = { buildingA: [], buildingB: [] };
  // 거리판정 기준점: 촘촘해야 커브에서 건물-도로 겹침이 안 샌다 (간격 ≈ 8m, 오차 ≈ ±4m)
  const coarse = samples.filter((_, i) => i % 3 === 0).map((s) => s.pos);
  // 개방 구간(쉼터·분기 진출입) 주변 판정 — 확장 노면·램프 위에 소품이 서지 않게
  const gapDistIdx = (i) =>
    gaps.length ? Math.min(...gaps.map((g) => Math.abs(i - g.idx) - g.halfSpan)) : 999;
  const gapZones = gaps.map((g) => ({
    p: samples[Math.max(0, Math.min(n - 1, g.idx))].pos,
    r: g.halfSpan * segLen + 45,
  }));
  const nearGapZone = (x, z) =>
    gapZones.some((gz) => Math.hypot(gz.p.x - x, gz.p.z - z) < gz.r);
  // push 지정 개방 구간(쉼터): 건물을 없애는 대신 이 거리(중심선 기준)까지 물려 세운다
  const gapPush = (i, side) => {
    let p = 0;
    for (const g of gaps) {
      if (g.push && side === g.side && Math.abs(i - g.idx) < g.halfSpan) p = Math.max(p, g.push);
    }
    return p;
  };
  // 트랙 양 끝단(출발·도착 도로 단면) 주변은 비운다 — 건물이 열린 도로 끝을
  // 감싸면 도로가 건물 블록에서 튀어나오는 것처럼 보이고 카메라가 파고든다.
  const tipA = samples[0].pos, tipB = samples[samples.length - 1].pos;
  const nearTip = (x, z, r = 70) =>
    Math.hypot(tipA.x - x, tipA.z - z) < r || Math.hypot(tipB.x - x, tipB.z - z) < r;
  // 에셋 원본 높이(스케일 전) — 옥상 y 계산용
  const tplH = {};
  for (const t of ['buildingA', 'buildingB']) {
    const box = new THREE.Box3().setFromObject(getAssetTemplate(t));
    tplH[t] = box.max.y - box.min.y;
  }
  const tankMats = [], acMats = [], antMats = [], beaconMats = [];
  const screenSpots = [];  // 대형 전광판 후보(높은 빌딩 옥상)
  const crossMats = [];    // 교회 십자가 네온
  const bannerSpots = []; // 수직 네온 배너(현수막) 후보
  const signTextures = NEON_SIGNS.map(([t, c]) => neonSignTexture(t, c));
  let signCount = 0;

  for (const side of [-1, 1]) {
    let i = Math.floor(rng() * 6);
    while (i < n) {
      const s = samples[i];
      const push = gapPush(i, side); // 쉼터 뒤편: 스킵 대신 플랫폼 밖으로 물려 배치
      const sc = range(rng, 0.85, 1.4);
      // 쉼터 뒷벽은 데크(y≈14) 위로 충분히 솟아야 배경이 된다 — 높이 하한을 올림
      const scy = push ? range(rng, 1.2, 2.3) : range(rng, 0.7, 2.1);
      const depthHalf = 4.4 * sc;
      const off = Math.max(parapetOffset + 4.5, push) + depthHalf;
      const x = s.pos.x + s.left.x * off * side;
      const z = s.pos.z + s.left.z * off * side;
      const alongWidth = 8.6 * sc;
      let placed = false;

      if ((push > 0 || !inGap(i, side)) && !inRiverX(x, 26) && !nearTip(x, z) && !nearBranch(x, z, 20)
        && minDistToTrack(x, z, coarse) >= Math.min(off - 1, 12)
        && minDistToTrackFar(x, z, coarse, Math.round(i / 3), 13) >= 34) {
        placed = true;
        const accent = pick(rng, palette.accents);
        const type = rng() > 0.5 ? 'buildingA' : 'buildingB';
        const yaw = Math.atan2(-s.left.x * side, -s.left.z * side); // 로컬 +Z = 도로 쪽
        const facade = lerpColor(accent, 0x20242f, 0.82); // 야간 외벽: 어둡게(창문이 도드라지게)
        buildingLists[type].push({
          matrix: composeMatrix(new THREE.Vector3(x, 0, z), yaw, new THREE.Vector3(sc, scy, sc)),
          facade, seed: rng() * 1000,
        });
        let roofY = tplH[type] * scy;

        // 저층 포디움(상가 기단): 타워 밑을 넓은 저층부가 받친다 — 도심 밀도감
        if (scy > 1.15 && rng() < 0.5) {
          buildingLists[type].push({
            matrix: composeMatrix(new THREE.Vector3(x, 0, z), yaw,
              new THREE.Vector3(sc * 1.42, scy * 0.2, sc * 1.28)),
            facade: lerpColor(accent, 0x252a36, 0.72), seed: rng() * 1000,
          });
        }

        // 2단 셋백 타워: 위로 갈수록 좁아지는 실루엣
        if (scy > 1.1 && rng() < 0.32) {
          const sc2 = sc * 0.62, scy2 = scy * 0.55;
          buildingLists[type].push({
            matrix: composeMatrix(new THREE.Vector3(x, roofY - 0.15, z), yaw,
              new THREE.Vector3(sc2, scy2, sc2)),
            facade: lerpColor(accent, 0x1a1e28, 0.85), seed: rng() * 1000,
          });
          roofY += tplH[type] * scy2 - 0.15;
        }

        // 옥상 프롭 (yaw 회전된 로컬 오프셋으로 배치)
        const roofAt = (ox, oz) => new THREE.Vector3(
          x + ox * Math.cos(yaw) + oz * Math.sin(yaw), roofY,
          z - ox * Math.sin(yaw) + oz * Math.cos(yaw));
        if (rng() < 0.5) tankMats.push(composeMatrix(roofAt(range(rng, -2, 2) * sc, range(rng, -1.5, 1.5) * sc).add(new THREE.Vector3(0, 0.75, 0)), yaw));
        if (rng() < 0.45) acMats.push(composeMatrix(roofAt(range(rng, -2.4, 2.4) * sc, range(rng, -1.8, 1.8) * sc).add(new THREE.Vector3(0, 0.45, 0)), yaw + rng()));
        if (scy > 1.55) { // 높은 빌딩: 안테나 + 붉은 항공장애등
          antMats.push(composeMatrix(roofAt(0, 0).add(new THREE.Vector3(0, 1.7, 0)), yaw));
          beaconMats.push(composeMatrix(roofAt(0, 0).add(new THREE.Vector3(0, 3.5, 0)), 0));
        }
        if (scy > 1.7) screenSpots.push({ x, z, yaw, roofY, sc }); // 전광판 후보
        // 교회 붉은 십자가 (중저층 일부)
        if (scy < 1.4 && crossMats.length < 8 && rng() < 0.09) {
          crossMats.push(composeMatrix(
            roofAt(range(rng, -1.5, 1.5) * sc, range(rng, -1, 1) * sc)
              .add(new THREE.Vector3(0, 1.4, 0)), yaw));
        }

        // 뒷줄 빌딩: 도시에 깊이감 (거의 항상 한 줄 더 — 빼곡한 도심)
        if (rng() < 0.85) {
          const sc2 = range(rng, 0.85, 1.5), scy2 = range(rng, 0.7, 2.3);
          const off2 = off + depthHalf + 4.4 * sc2 + range(rng, 2, 8);
          const x2 = s.pos.x + s.left.x * off2 * side;
          const z2 = s.pos.z + s.left.z * off2 * side;
          if (!inRiverX(x2, 26) && !nearTip(x2, z2) && !nearBranch(x2, z2, 20)
            && minDistToTrackFar(x2, z2, coarse, Math.round(i / 3), 13) >= 34) {
            const t2 = rng() > 0.5 ? 'buildingA' : 'buildingB';
            buildingLists[t2].push({
              matrix: composeMatrix(new THREE.Vector3(x2, 0, z2), yaw,
                new THREE.Vector3(sc2, scy2, sc2)),
              facade: lerpColor(pick(rng, palette.accents), 0x20242f, 0.84),
              seed: rng() * 1000,
            });
            // 3열: 스카이라인을 한 겹 더 (커브 안쪽 빈 하늘 방지)
            if (rng() < 0.55) {
              const sc3 = range(rng, 0.9, 1.6), scy3 = range(rng, 0.8, 2.6);
              const off3 = off2 + 4.4 * sc2 + 4.4 * sc3 + range(rng, 3, 10);
              const x3 = s.pos.x + s.left.x * off3 * side;
              const z3 = s.pos.z + s.left.z * off3 * side;
              if (!inRiverX(x3, 26) && !nearTip(x3, z3) && !nearBranch(x3, z3, 20)
                && minDistToTrackFar(x3, z3, coarse, Math.round(i / 3), 13) >= 34) {
                const t3 = rng() > 0.5 ? 'buildingA' : 'buildingB';
                buildingLists[t3].push({
                  matrix: composeMatrix(new THREE.Vector3(x3, 0, z3),
                    yaw + range(rng, -0.1, 0.1), new THREE.Vector3(sc3, scy3, sc3)),
                  facade: lerpColor(pick(rng, palette.accents), 0x20242f, 0.85),
                  seed: rng() * 1000,
                });
              }
            }
          }
        }

        // 수직 네온 배너(간판 현수막) 후보: 중저층 정면 벽
        if (bannerSpots.length < 26 && scy < 1.7 && rng() < 0.24) {
          bannerSpots.push({ x, z, yaw, depthHalf, h: roofY });
        }

        // 도로를 향한 네온 간판 (낮은 층 벽면)
        if (signCount < 14 && scy < 1.6 && rng() < 0.22) {
          signCount++;
          const w = Math.min(7 * sc, alongWidth * 0.8);
          const sign = new THREE.Mesh(
            new THREE.PlaneGeometry(w, w * 0.36),
            new THREE.MeshBasicMaterial({ map: pick(rng, signTextures), fog: true })
          );
          const fy = roofY * range(rng, 0.42, 0.62);
          sign.position.set(
            x + Math.sin(yaw) * (depthHalf + 0.15), fy,
            z + Math.cos(yaw) * (depthHalf + 0.15));
          sign.rotation.y = yaw;
          scene.add(sign);
        }
      }
      // 배치 성공: 건물 폭만큼(틈 최소) / 스킵: 짧게 전진해 곧바로 재시도 — 구멍 방지
      i += placed
        ? Math.max(3, Math.round((alongWidth + 0.5) / segLen))
        : Math.max(2, Math.round(7 / segLen));
    }
  }

  // 수직 네온 배너: 정면 벽에 세로로 길게 매달린 간판 (인스턴싱, 텍스처 4종)
  if (bannerSpots.length) {
    const bannerWords = ['노래방', 'PC방', '만화카페', '호프'];
    const bannerColors = ['#ff5f8a', '#4fd8ff', '#ffd24f', '#7dff8a'];
    const texs = bannerWords.map((word, k) => canvasTex(64, 256, (ctx, w, h) => {
      ctx.fillStyle = '#101018';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = bannerColors[k];
      ctx.lineWidth = 5;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.fillStyle = bannerColors[k];
      ctx.font = 'bold 40px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const chars = word.split('');
      chars.forEach((c, ci) => {
        ctx.fillText(c, w / 2, ((ci + 0.5) / chars.length) * (h - 24) + 12);
      });
    }));
    const groupsM = texs.map(() => []);
    bannerSpots.forEach((b, k) => {
      const bh = Math.min(9, b.h * 0.55);
      const bx = b.x + Math.sin(b.yaw) * (b.depthHalf + 0.14)
        + Math.cos(b.yaw) * range(rng, -2.2, 2.2);
      const bz = b.z + Math.cos(b.yaw) * (b.depthHalf + 0.14)
        - Math.sin(b.yaw) * range(rng, -2.2, 2.2);
      groupsM[k % texs.length].push(new THREE.Matrix4().compose(
        new THREE.Vector3(bx, b.h * 0.5, bz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, b.yaw, 0)),
        new THREE.Vector3(1.15, bh, 1)));
    });
    texs.forEach((tex, k) => {
      if (!groupsM[k].length) return;
      addInstanced(scene, new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex, fog: true, side: THREE.DoubleSide }),
        groupsM[k]);
    });
  }

  // 골목 불빛: 빌딩 블록 사이 옆골목이 은은하게 새어나온다 (도심 격자 야경)
  {
    const alleyTex = canvasTex(32, 128, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,180,100,0)');
      g.addColorStop(0.35, 'rgba(255,190,110,0.55)');
      g.addColorStop(0.65, 'rgba(255,185,105,0.5)');
      g.addColorStop(1, 'rgba(255,180,100,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    const alleyM = [];
    const aStep = Math.max(4, Math.round(46 / segLen));
    for (let i = 14; i < n - 14; i += aStep) {
      if (rng() < 0.4) continue;
      const side = rng() < 0.5 ? -1 : 1;
      if (inGap(i, side)) continue;
      const s = samples[i];
      const ax = s.pos.x + s.left.x * (parapetOffset + 30) * side;
      const az = s.pos.z + s.left.z * (parapetOffset + 30) * side;
      if (inRiverX(ax, 30) || nearTip(ax, az) || nearBranch(ax, az, 18)) continue;
      alleyM.push(new THREE.Matrix4().compose(
        new THREE.Vector3(ax, 0.025, az),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
          -Math.PI / 2, 0, Math.atan2(s.left.x * side, s.left.z * side))),
        new THREE.Vector3(2.6, 34, 1)));
    }
    if (alleyM.length) addInstanced(scene, new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: alleyTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: true,
      }), alleyM);
  }
  // 랜드마크: 국회의사당 + 63빌딩 (강 서안, 여의도 자리). 다리에서 잘 보이는 위치.
  const landmarkPts = [];
  if (river) {
    const spots = [
      // 국회의사당: 강변 바로 앞(강변도로 뒤) — 정면(+X)과 강 사이에 건물이 못 들어감
      { name: 'assemblyHall', dz: 260, setback: 58, yaw: Math.PI / 2, clear: 75 },
      { name: 'tower63', dz: -310, setback: 125, yaw: Math.PI / 2, clear: 48 },
    ];
    for (const sp of spots) {
      const px2 = river.x0 - sp.setback;
      let pz2 = river.zBridge + sp.dz;
      let tries = 0;
      while (minDistToTrack(px2, pz2, coarse) < 95 && tries++ < 10) {
        pz2 += (tries % 2 ? 1 : -1) * 85 * Math.ceil(tries / 2);
      }
      const lm = instantiate(sp.name);
      lm.position.set(px2, 0, pz2);
      lm.rotation.y = sp.yaw; // 정면이 강(+X)을 향함
      scene.add(lm);
      landmarkPts.push({ x: px2, z: pz2, clear: sp.clear });
    }
    // 투광조명 웅덩이: 어두운 건물을 바닥 워시가 살린다
    const poolM = [];
    const [asm, t63] = landmarkPts;
    // 강변도로(x0-16)에 웅덩이가 얹히지 않게 x를 클램프 — 정면 기둥엔 워시가 닿게
    const poolX = (px) => Math.min(px, river.x0 - 26);
    if (asm) for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      poolM.push(new THREE.Matrix4().compose(
        new THREE.Vector3(poolX(asm.x + Math.cos(a) * 46), 0.06, asm.z + Math.sin(a) * 38),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
        new THREE.Vector3(2.4, 2.4, 1)));
    }
    if (t63) for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      poolM.push(new THREE.Matrix4().compose(
        new THREE.Vector3(poolX(t63.x + Math.cos(a) * 26), 0.06, t63.z + Math.sin(a) * 22),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
        new THREE.Vector3(1.7, 1.7, 1)));
    }
    if (poolM.length) addInstanced(scene, new THREE.PlaneGeometry(22, 22),
      new THREE.MeshBasicMaterial({
        map: lightPoolTexture(), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }), poolM);
  }
  const nearLandmark = (x, z) =>
    landmarkPts.some((p) => Math.hypot(p.x - x, p.z - z) < p.clear);

  // 강변 스카이라인: 종이상자 텍스처 대신 도심과 같은 GLB 빌딩(절차적 창문)을
  // 강 양안에 세운다 — 같은 인스턴스 드로우콜에 합류하므로 추가 비용 없음.
  const bankSpots = []; // 수면 반사 스트릭 위치 산출용 { z, side, h, w }
  if (river) {
    const zlo = tb.min.z - 550, zhi = tb.max.z + 550;
    for (const side of [-1, 1]) {
      let bz = zlo + rng() * 20;
      while (bz < zhi) {
        const sc = range(rng, 1.0, 1.9);
        const scy = range(rng, 1.1, 3.2); // 강변엔 고층 아파트/타워 느낌
        const setback = range(rng, 36, 95); // 물가에서 물려 수면이 넓게 보이게
        bz += 8.6 * sc + range(rng, 2, 12); // 빽빽하게
        if (Math.abs(bz - river.zBridge) < 100) continue; // 다리 접속부 비움
        const bx = side < 0 ? river.x0 - setback : river.x1 + setback;
        if (minDistToTrack(bx, bz, coarse) < 34) continue; // 루트와 겹침 방지
        if (nearLandmark(bx, bz)) continue;               // 랜드마크 주변 비움
        if (nearBranch(bx, bz, 20)) continue;             // 분기 램프/루프 자리
        const yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2; // 강 쪽을 바라봄
        const accent = pick(rng, palette.accents);
        const type = rng() > 0.5 ? 'buildingA' : 'buildingB';
        buildingLists[type].push({
          matrix: composeMatrix(new THREE.Vector3(bx, 0, bz), yaw,
            new THREE.Vector3(sc, scy, sc)),
          facade: lerpColor(accent, 0x20242f, 0.82),
          seed: rng() * 1000,
        });
        const h = tplH[type] * scy;
        if (scy > 2.5) beaconMats.push(composeMatrix(new THREE.Vector3(bx, h + 1.2, bz), 0));
        bankSpots.push({ z: bz, side, h, w: 8.6 * sc, setback });
        // 뒷줄: 강변 스카이라인에 깊이감 (물가에서 더 물러난 두 번째 열)
        if (rng() < 0.7) {
          const sc2 = range(rng, 0.9, 1.7), scy2 = range(rng, 0.9, 2.6);
          const bx2 = side < 0 ? bx - range(rng, 24, 52) : bx + range(rng, 24, 52);
          if (minDistToTrack(bx2, bz, coarse) >= 34 && !nearLandmark(bx2, bz)
            && !nearBranch(bx2, bz, 20)) {
            const t2 = rng() > 0.5 ? 'buildingA' : 'buildingB';
            buildingLists[t2].push({
              matrix: composeMatrix(new THREE.Vector3(bx2, 0, bz + range(rng, -4, 4)),
                yaw + range(rng, -0.15, 0.15), new THREE.Vector3(sc2, scy2, sc2)),
              facade: lerpColor(pick(rng, palette.accents), 0x20242f, 0.84),
              seed: rng() * 1000,
            });
          }
        }
      }
    }
  }

  // 산맥 앞 외곽 벨트: 지평선 방향 어디를 봐도 건물이 있게 (빈 들판 방지)
  {
    const beltInner = textent + 60;
    const beltOuter = textent + 640;
    for (let i = 0; i < 180; i++) {
      const ang = rng() * Math.PI * 2;
      const rr = beltInner + rng() * (beltOuter - beltInner);
      const bx = tcx + Math.cos(ang) * rr;
      const bz2 = tcz + Math.sin(ang) * rr;
      if (inRiverX(bx, 40)) continue;
      if (minDistToTrack(bx, bz2, coarse) < 42) continue;
      if (nearTip(bx, bz2)) continue; // 출발·도착 도로 끝단 비움
      if (nearBranch(bx, bz2, 20)) continue;
      if (nearGapZone(bx, bz2)) continue; // 쉼터 확장 노면·분기 입구
      const sc = range(rng, 0.9, 1.8);
      const scy = range(rng, 0.6, 2.4);
      const type = rng() > 0.5 ? 'buildingA' : 'buildingB';
      buildingLists[type].push({
        matrix: composeMatrix(new THREE.Vector3(bx, 0, bz2), rng() * Math.PI * 2,
          new THREE.Vector3(sc, scy, sc)),
        facade: lerpColor(pick(rng, palette.accents), 0x20242f, 0.84),
        seed: rng() * 1000,
      });
    }
  }

  buildInstancedBuildings(scene, 'buildingA', buildingLists.buildingA);
  buildInstancedBuildings(scene, 'buildingB', buildingLists.buildingB);

  // 주택가: 박공지붕 저층 주택 클러스터 (외곽 빈 땅 + 강가 뒤편, 랜드마크 회피)
  buildHouseClusters(scene, rng, coarse, palette, tcx, tcz, textent, inRiverX, river, nearLandmark, nearTip, nearBranch, nearGapZone);

  // 가로수: 강변 산책로 양안 + 랜드마크 조경 (treeRound GLB 인스턴싱)
  {
    const treeMats = [];
    if (river) {
      for (let z = tb.min.z - 450; z < tb.max.z + 450; z += 26) {
        if (Math.abs(z - river.zBridge) < 60) continue; // 다리 접속부 비움
        // 강변도로(폭 14.6, 중심 x0-16/x1+16) 도시 쪽 바깥에 세운다 —
        // 예전 x0-10.5 라인은 도로가 넓어지면서 노면 위에 서게 됐음("나무가 도로 위" 피드백)
        for (const bx of [river.x0 - 26.5, river.x1 + 26.5]) {
          if (rng() < 0.3) continue;
          const tz3 = z + range(rng, -4, 4);
          if (nearBranch(bx, tz3, 9)) continue; // 램프·루프 위 금지
          const s = range(rng, 0.8, 1.3);
          treeMats.push(composeMatrix(
            new THREE.Vector3(bx, 0, tz3),
            rng() * Math.PI * 2, new THREE.Vector3(s, s, s)));
        }
      }
    }
    for (const p of landmarkPts) { // 랜드마크 둘레 조경수
      const cnt = p.clear > 60 ? 14 : 8;
      for (let k = 0; k < cnt; k++) {
        const a = rng() * Math.PI * 2;
        const rr2 = (p.clear > 60 ? 54 : 32) + rng() * 12;
        const tx = p.x + Math.cos(a) * rr2;
        const tz2 = p.z + Math.sin(a) * rr2;
        if (river && tx > river.x0 - 24) continue; // 강변도로·강에 나무 금지
        if (nearBranch(tx, tz2, 8)) continue;      // 분기 도로 위 금지
        const s = range(rng, 0.9, 1.3);
        treeMats.push(composeMatrix(
          new THREE.Vector3(tx, 0, tz2),
          rng() * Math.PI * 2, new THREE.Vector3(s, s, s)));
      }
    }
    if (treeMats.length) buildInstancedTemplate(scene, 'treeRound', treeMats, 7.5);
  }

  // 옥상 프롭 인스턴싱 (종류당 드로우콜 1)
  const propMat = new THREE.MeshLambertMaterial({ color: 0x363a44 });
  if (tankMats.length) addInstanced(scene,
    new THREE.CylinderGeometry(0.9, 0.9, 1.5, 10), propMat, tankMats);
  if (acMats.length) addInstanced(scene,
    new THREE.BoxGeometry(1.4, 0.9, 1.4), propMat, acMats);
  if (antMats.length) addInstanced(scene,
    new THREE.CylinderGeometry(0.05, 0.1, 3.4, 6),
    new THREE.MeshLambertMaterial({ color: 0x4a4f5c }), antMats);
  if (beaconMats.length) addInstanced(scene,
    new THREE.SphereGeometry(0.22, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff3838 }), beaconMats);

  // 7.5) 대형 옥상 전광판 — 광고 4개가 3.5초마다 슬라이드 (텍스처 offset 애니메이션)
  if (screenSpots.length) {
    const adTex = adStripTexture();
    adTex.wrapS = THREE.RepeatWrapping;
    adTex.repeat.x = 0.25;
    const picked = [];
    const step = Math.max(1, Math.floor(screenSpots.length / 3));
    for (let k = 0; k < screenSpots.length && picked.length < 3; k += step) picked.push(screenSpots[k]);
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x22252e });
    for (const sp of picked) {
      const w = 9 * Math.min(sp.sc, 1.2), h = w * 0.42;
      const g = new THREE.Group();
      g.position.set(sp.x, sp.roofY, sp.z);
      g.rotation.y = sp.yaw; // 도로 쪽을 향함
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, h + 0.6, 0.35), frameMat);
      frame.position.set(0, h / 2 + 1.6, 0);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: adTex, fog: true }));
      screen.position.set(0, h / 2 + 1.6, 0.2);
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.8, 0.28), frameMat);
        leg.position.set(sx * w * 0.32, 0.9, 0);
        g.add(leg);
      }
      g.add(frame, screen);
      scene.add(g);
    }
    updaters.push((t) => {
      const cycle = t / 3.5;
      const i = Math.floor(cycle);
      const f = cycle - i;
      const e = f < 0.82 ? 0 : (f - 0.82) / 0.18; // 홀드 후 0.6초간 슬라이드
      const s2 = e * e * (3 - 2 * e);
      adTex.offset.x = ((i + s2) % 4) * 0.25;
    });
  }

  // 7.6) 교회 붉은 십자가 네온 (십자 지오메트리 병합 → 인스턴싱)
  if (crossMats.length) {
    const vbar = new THREE.BoxGeometry(0.16, 2.4, 0.16);
    const hbar = new THREE.BoxGeometry(1.4, 0.16, 0.16);
    hbar.translate(0, 0.55, 0);
    addInstanced(scene, mergeGeometries([vbar, hbar]),
      new THREE.MeshBasicMaterial({ color: 0xff2626 }), crossMats);
  }

  // 7.7) 공사 타워크레인 실루엣 + 지브 끝 점멸등
  // 회피 조건이 많아 시도 몇 번으로는 시드 대부분에서 전멸한다 — 성공할 때까지 재시도
  const craneMats = [], craneTipMats = [];
  for (let attempt = 0; attempt < 60 && craneMats.length < 4; attempt++) {
    const ci = Math.floor(rng() * n);
    if (inGap(ci, 1) || inGap(ci, -1)) continue;
    const cs = samples[ci];
    const cside = rng() < 0.5 ? 1 : -1;
    const coff = parapetOffset + range(rng, 26, 48);
    const px = cs.pos.x + cs.left.x * coff * cside;
    const pz = cs.pos.z + cs.left.z * coff * cside;
    if (inRiverX(px, 30)) continue; // 강물 위 크레인 방지
    if (minDistToTrack(px, pz, coarse) < 30) continue; // 커브 반대편 도로 위 방지
    if (nearBranch(px, pz, 24) || nearGapZone(px, pz) || nearTip(px, pz)) continue;
    const cyaw = rng() * Math.PI * 2;
    craneMats.push(composeMatrix(new THREE.Vector3(px, 0, pz), cyaw));
    craneTipMats.push(composeMatrix(new THREE.Vector3(
      px + 11.5 * Math.cos(cyaw), 26.4, pz - 11.5 * Math.sin(cyaw)), 0));
  }
  if (craneMats.length) {
    const mast = new THREE.BoxGeometry(1.0, 26, 1.0); mast.translate(0, 13, 0);
    const jib = new THREE.BoxGeometry(17, 0.7, 0.7); jib.translate(4.5, 26, 0); // 지브+카운터지브
    const cab = new THREE.BoxGeometry(1.6, 1.4, 1.6); cab.translate(0, 25, 0);
    const tip = new THREE.BoxGeometry(0.15, 3.2, 0.15); tip.translate(0, 27.6, 0); // 타워탑
    addInstanced(scene, mergeGeometries([mast, jib, cab, tip]),
      new THREE.MeshLambertMaterial({ color: 0x2e3138 }), craneMats);
    const tipMesh = addInstanced(scene, new THREE.SphereGeometry(0.3, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3030 }), craneTipMats);
    updaters.push((t) => { tipMesh.visible = (t % 1.5) < 0.85; }); // 천천히 점멸
  }

  // 7.8) 도로 위 문형(갠트리) 방향표지판 — 쉼터·출발선 회피, 최대 3개
  {
    const gIdx = [0.14, 0.38, 0.62, 0.86]
      .map((f) => Math.floor(n * f))
      .filter((i) => gapDistIdx(i) > 8 && i > 12 && i < n - 12
        && !inRiverX(samples[i].pos.x, 40)) // 다리 아치·쉼터·분기 진출입 회피
      .slice(0, 3);
    const gantryMat = new THREE.MeshLambertMaterial({ color: 0x3a3d47 });
    const gSignTexs = [
      gantrySignTexture('도심 방면', '직진'),
      gantrySignTexture('공항 방면', '2 km'),
      gantrySignTexture('강변북로', '직진'),
    ];
    const legGeo = new THREE.BoxGeometry(0.5, 6.4, 0.5);
    const panelGeo = new THREE.PlaneGeometry(5.4, 2.5);
    gIdx.forEach((gi, k) => {
      const s = samples[gi];
      const g = new THREE.Group();
      g.position.copy(s.pos);
      g.rotation.y = Math.atan2(s.tangent.x, s.tangent.z); // 로컬 +Z = 진행 방향
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, gantryMat);
        leg.position.set(sx * (parapetOffset - 0.5), 3.2, 0);
        g.add(leg);
      }
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(parapetOffset * 2, 0.6, 0.9), gantryMat);
      beam.position.y = 6.4;
      g.add(beam);
      for (const sx of [-1, 1]) { // 표지판은 다가오는 차(-Z 쪽에서 접근)를 향함
        const panel = new THREE.Mesh(panelGeo, new THREE.MeshBasicMaterial({
          map: gSignTexs[(k + (sx > 0 ? 1 : 0)) % gSignTexs.length], fog: true,
        }));
        panel.position.set(sx * roadWidth / 4, 4.9, -0.5);
        panel.rotation.y = Math.PI;
        g.add(panel);
      }
      scene.add(g);
    });
  }

  // 7.9) 노면 마킹(속도제한 80·직진 화살표) + 과속카메라 + km 표지판
  {
    // 개방 구간(쉼터·분기)까지의 인덱스 여유 — 음수면 구간 안
    const dRestOf = (i) => gapDistIdx(i);

    // (노면 페인트 데칼 — "80" 숫자·직진 화살표 — 는 야간에 뭉개져 잘 안 보인다는
    //  사용자 피드백으로 제거함. 재추가 시 고해상 텍스처+발광으로 다시 설계할 것)

    // 과속카메라 2대 — 우측 갓길 폴 + 도로 위로 뻗은 암 + 카메라 박스
    const camMat = new THREE.MeshLambertMaterial({ color: 0x8a8d95 });
    for (const f of [0.28, 0.72]) {
      const i = Math.floor(n * f);
      if (dRestOf(i) < 6) continue;
      if (inRiverX(samples[i].pos.x, 30)) continue;
      const s = samples[i];
      const g = new THREE.Group();
      g.position.copy(s.pos);
      g.rotation.y = Math.atan2(s.tangent.x, s.tangent.z); // 로컬 +X = -left(우측이 -X 아님 주의: 우측 갓길 = -X)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 5.6, 8), camMat);
      pole.position.set(-(parapetOffset - 0.5), 2.8, 0);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.22, 0.22), camMat);
      arm.position.set(-(parapetOffset - 0.5) + 2.3, 5.45, 0);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.9),
        new THREE.MeshLambertMaterial({ color: 0x2e3138 }));
      box.position.set(-(parapetOffset - 0.5) + 4.4, 5.2, 0);
      const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.22),
        new THREE.MeshBasicMaterial({ color: 0xdfe8ff }));
      lens.position.set(-(parapetOffset - 0.5) + 4.4, 5.2, -0.47);
      lens.rotation.y = Math.PI; // 다가오는 차량 쪽
      g.add(pole, arm, box, lens);
      scene.add(g);
    }

    // km 표지판 4개 — 우측 갓길의 작은 이정표 (목적지까지 남은 거리)
    for (let k = 0; k < 4; k++) {
      const i = Math.min(n - 2, Math.floor(n * (0.1 + k * 0.25)));
      if (dRestOf(i) < 6) continue;
      if (inRiverX(samples[i].pos.x, 25)) continue;
      const s = samples[i];
      const g = new THREE.Group();
      g.position.copy(s.pos);
      g.rotation.y = Math.atan2(s.tangent.x, s.tangent.z);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.1, 0.12), camMat);
      post.position.set(-(parapetOffset - 0.8), 1.05, 0);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0),
        new THREE.MeshBasicMaterial({
          map: canvasTex(160, 108, (ctx, w, h) => {
            ctx.fillStyle = '#0d5a2e'; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = '#eef6ef'; ctx.lineWidth = 5;
            ctx.strokeRect(5, 5, w - 10, h - 10);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = 'bold 52px sans-serif';
            ctx.fillText(`${(4 - k) * 2} km`, w / 2, h / 2 + 2);
          }),
          fog: true,
        }));
      panel.position.set(-(parapetOffset - 0.8), 2.2, -0.1);
      panel.rotation.y = Math.PI;
      g.add(post, panel);
      scene.add(g);
    }
  }

  // 8) 강(루트가 다리로 건너는 남북 밴드) + 물가 야경 반사 + 교량 아치
  if (river) {
    buildRiverCrossing(scene, rng, samples, river, bankSpots, updaters, !!branchPts, palette, lampHeads);
    buildBridgeArches(scene, samples, river, parapetOffset);
  }

  // 9) 원경 산맥 (Blender 3D 모델) — 루트 중심·크기에 맞춰 링을 두른다.
  // 강이 지나는 x 회랑에서는 산을 잘라내 강이 지평선까지 트이게 한다.
  buildMountainRanges(scene, rng, new THREE.Vector3(tcx, 0, tcz), textent + 1250, river);

  // 10) 원경 은은한 불빛 — 순검정 지평선 방지.
  // (a) 산맥 발치를 두르는 시티글로우 밴드, (b) 흩뿌려진 원경 광점 필드.
  {
    const glowTex = canvasTex(512, 64, (ctx, w, h) => {
      for (let x = 0; x < w; x += 8) { // 얼룩덜룩한 도시광(따뜻/차가운 패치)
        const warm = Math.random() < 0.72;
        const a = 0.09 + Math.random() * 0.13;
        const g = ctx.createLinearGradient(0, h, 0, 0);
        g.addColorStop(0, warm ? `rgba(255,190,120,${a})` : `rgba(150,185,255,${a * 0.8})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, 8, h);
      }
    });
    const glowR = textent + 1100;
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(glowR, glowR, 95, 48, 1, true),
      new THREE.MeshBasicMaterial({
        map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.BackSide, fog: false,
      })
    );
    glow.position.set(tcx, 44, tcz);
    scene.add(glow);

    // 원경 광점: 도시 외곽~산맥 사이 빈 땅에 흩어진 불빛(창문 하나짜리 동네들)
    const CNT = 750;
    const pos = new Float32Array(CNT * 3);
    const col = new Float32Array(CNT * 3);
    const warmC = new THREE.Color(1.0, 0.78, 0.5);
    const coolC = new THREE.Color(0.62, 0.75, 1.0);
    for (let i = 0; i < CNT; i++) {
      const ang = rng() * Math.PI * 2;
      const rr = textent + 160 + rng() * (glowR - textent - 260);
      pos[i * 3] = tcx + Math.cos(ang) * rr;
      pos[i * 3 + 1] = 1 + rng() * 26;
      pos[i * 3 + 2] = tcz + Math.sin(ang) * rr;
      const c = (rng() < 0.72 ? warmC : coolC).clone()
        .multiplyScalar(0.35 + rng() * 0.6);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dotGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const dotTex2 = canvasTex(32, 32, (ctx) => {
      const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.4)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
    });
    const farDots = new THREE.Points(dotGeo, new THREE.PointsMaterial({
      size: 2.4, sizeAttenuation: false, map: dotTex2, vertexColors: true,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    farDots.frustumCulled = false;
    scene.add(farDots);
  }

  // 11) 대향 차로(중앙분리대 좌측 4차선) 장식 차량 — 왕복 8차선의 반대 방향 흐름.
  // 플레이어는 laneMin 클램프로 분리대를 못 넘으므로 물리 없이 인스턴스만으로 안전.
  {
    const cum = new Float32Array(n);
    for (let i = 0; i < n - 1; i++) cum[i + 1] = cum[i] + samples[i].pos.distanceTo(samples[i + 1].pos);
    const L = cum[n - 1];
    const laneW = roadWidth / 8;
    const gcars = [];
    const NG = Math.max(8, Math.round(L / 85));
    for (let k = 0; k < NG; k++) {
      gcars.push({
        s0: rng() * L,
        spd: 19 + rng() * 12,
        lane: -laneW * (0.5 + Math.floor(rng() * 4)), // 좌측 4개 차선 중심
      });
    }
    const gBody = new THREE.InstancedMesh(mkCarGeo(),
      new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0e1016 }), gcars.length);
    const gHead = new THREE.InstancedMesh(mkPairGeo(0.17, 0.62, 2.16),
      new THREE.MeshBasicMaterial({ color: 0xfff2cf, fog: true }), gcars.length);
    const gTail = new THREE.InstancedMesh(mkPairGeo(0.14, 0.66, -2.16),
      new THREE.MeshBasicMaterial({ color: 0xff3a3a, fog: true }), gcars.length);
    const _gc = new THREE.Color();
    for (let i = 0; i < gcars.length; i++) gBody.setColorAt(i, _gc.set(pick(rng, GHOST_CAR_TONES)));
    if (gBody.instanceColor) gBody.instanceColor.needsUpdate = true;
    for (const im of [gBody, gHead, gTail]) { im.frustumCulled = false; scene.add(im); }
    const _gm = new THREE.Matrix4();
    const _gp = new THREE.Vector3();
    const _gq = new THREE.Quaternion();
    const _g1 = new THREE.Vector3(1, 1, 1);
    updaters.push((t) => {
      for (let i = 0; i < gcars.length; i++) {
        const c = gcars[i];
        // 대향 = 트랙 역방향 진행 (s 감소)
        const s = ((c.s0 - t * c.spd) % L + L) % L;
        let lo = 0, hi = n - 1;
        while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
        const seg = Math.max(1e-4, cum[lo + 1] - cum[lo]);
        const tt = (s - cum[lo]) / seg;
        const a = samples[lo], b = samples[lo + 1];
        _gp.copy(a.pos).lerp(b.pos, tt);
        const tanx = a.tangent.x + (b.tangent.x - a.tangent.x) * tt;
        const tanz = a.tangent.z + (b.tangent.z - a.tangent.z) * tt;
        const lx = a.left.x + (b.left.x - a.left.x) * tt;
        const lz = a.left.z + (b.left.z - a.left.z) * tt;
        _gp.x += lx * c.lane; _gp.z += lz * c.lane;
        _gp.y += 0.02;
        _gq.setFromAxisAngle(UP, Math.atan2(-tanx, -tanz)); // 역방향 요
        _gm.compose(_gp, _gq, _g1);
        gBody.setMatrixAt(i, _gm);
        gHead.setMatrixAt(i, _gm);
        gTail.setMatrixAt(i, _gm);
      }
      gBody.instanceMatrix.needsUpdate = true;
      gHead.instanceMatrix.needsUpdate = true;
      gTail.instanceMatrix.needsUpdate = true;
    });
  }

  return { lampHeads, update: (t, dt) => { for (const f of updaters) f(t, dt); } };
}

// GLB 템플릿의 모든 메시를 인스턴싱 배치. targetH가 있으면 전체 높이를
// 해당 값(m)으로 정규화(에셋 원본 스케일에 무관하게 일정한 크기 보장).
