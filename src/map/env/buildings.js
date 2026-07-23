// 빌딩 장식 — 절차 파사드 재질(창문 셰이더), 박스 빌딩/GLB 템플릿 인스턴싱,
// 강 건너 주택 클러스터. 배치 결정은 decorations.js(오케스트레이터)가 한다.

import * as THREE from 'three';
import { pick, range } from '../../utils/rng.js';
import { getAssetTemplate } from '../../utils/assets.js';
import { addInstanced, composeMatrix, lerpColor, minDistToTrack } from './common.js';

function makeFacadeMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.82, metalness: 0.0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSeed;
        varying float vSeed;
        varying vec3 vLPos;
        varying vec3 vLNorm;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSeed = aSeed;
        vLPos = position;
        vLNorm = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vSeed;
        varying vec3 vLPos;
        varying vec3 vLNorm;
        float hash21(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 nrm = normalize(vLNorm);
          float hasWindows = step(0.28, fract(vSeed * 0.0173)); // 약 28%는 창문 없는 빌딩
          if (abs(nrm.y) < 0.5 && hasWindows > 0.5) {  // 지붕/바닥·무창 빌딩은 창 없음
            float hcoord = abs(nrm.x) > abs(nrm.z) ? vLPos.z : vLPos.x;
            float vcoord = vLPos.y;
            const float CW = 1.6, CH = 2.0;        // 창 셀 크기(로컬 단위)
            vec2 cell = vec2(floor(hcoord/CW), floor(vcoord/CH));
            vec2 fr = vec2(fract(hcoord/CW), fract(vcoord/CH));
            float win = step(0.16, fr.x)*step(fr.x, 0.84)*step(0.16, fr.y)*step(fr.y, 0.80);
            float faceId = nrm.x > 0.5 ? 0.0 : (nrm.x < -0.5 ? 1.0 : (nrm.z > 0.5 ? 2.0 : 3.0));
            float r = hash21(cell + vec2(vSeed*57.3 + faceId*11.7, vSeed*19.1 + 3.0));
            float lit = step(0.46, r);             // 약 54% 점등
            vec3 warm = vec3(1.0, 0.80, 0.48);
            vec3 cool = vec3(0.60, 0.76, 1.0);
            vec3 wcol = mix(warm, cool, step(0.72, fract(r*7.0)));
            float flick = 0.55 + 0.45*fract(r*131.0);
            totalEmissiveRadiance += win * lit * wcol * flick * 0.7;
            diffuseColor.rgb *= (1.0 - win*0.55);  // 창 부분 외벽은 어둡게(유리 느낌)
          }
        }`);
  };
  return mat;
}

// 빌딩 에셋 인스턴싱. 외벽은 절차적 창문 머티리얼(+aSeed), 창문 스트립은 생략,
// 지붕 트림은 원래 색 유지.
export function buildInstancedBuildings(scene, type, list) {
  if (!list.length) return;
  const meshes = [];
  getAssetTemplate(type).traverse((o) => { if (o.isMesh) meshes.push(o); });

  for (const mesh of meshes) {
    const name = mesh.material.name;
    if (name === 'Window') continue; // 절차적 창문으로 대체

    if (name === 'Facade') {
      const geo = mesh.geometry.clone();
      const seeds = new Float32Array(list.map((b) => b.seed));
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      const im = new THREE.InstancedMesh(geo, makeFacadeMaterial(), list.length);
      list.forEach((b, i) => {
        im.setMatrixAt(i, b.matrix);
        im.setColorAt(i, b.facade);
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      // castShadow 금지: 도시 전체가 매 프레임 그림자 패스에 다시 그려져
      // 렉의 주원인이 된다(야간이라 빌딩 그림자는 어차피 안 보임).
      im.castShadow = false;
      im.frustumCulled = false;
      scene.add(im);
    } else {
      // RoofTrim 등: 원래 머티리얼 유지
      addInstanced(scene, mesh.geometry, mesh.material, list.map((b) => b.matrix));
    }
  }
}

export function buildInstancedTemplate(scene, type, mats, targetH = 0) {
  const tpl = getAssetTemplate(type);
  tpl.updateMatrixWorld(true);
  let norm = 1;
  if (targetH > 0) {
    const bb = new THREE.Box3().setFromObject(tpl);
    const h = bb.max.y - bb.min.y || 1;
    norm = targetH / h;
  }
  const normM = new THREE.Matrix4().makeScale(norm, norm, norm);
  tpl.traverse((o) => {
    if (!o.isMesh) return;
    const local = normM.clone().multiply(o.matrixWorld);
    addInstanced(scene, o.geometry, o.material, mats.map((m) => m.clone().multiply(local)));
  });
}

// 주택가: 박공지붕 저층 주택을 클러스터(동네) 단위로 배치.
// 벽은 도시 빌딩과 같은 절차적 창문 셰이더(makeFacadeMaterial)를 재사용 —
// 5m 폭 벽에 창 2~3칸이 자연스럽게 나온다. 지붕은 인스턴스 프리즘.
export function buildHouseClusters(scene, rng, coarse, palette, tcx, tcz, textent, inRiverX, river = null, nearLandmark = () => false, nearTip = () => false, nearBranch = () => false, nearGapZone = () => false) {
  const HOUSE_COLORS = [0x8a7f6a, 0x7c6f5e, 0x83786b, 0x6e6a63, 0x86775f, 0x77706a];
  const ROOF_COLORS = [0x4a3630, 0x35443a, 0x3a3d46, 0x4c4438, 0x40333c];

  // 클러스터 중심 고르기 (트랙·강·다른 클러스터 회피)
  const clusters = [];
  let attempts = 0;
  while (clusters.length < 13 && attempts++ < 400) {
    const ang = rng() * Math.PI * 2;
    const rr = 230 + rng() * (textent + 430 - 230);
    const cx = tcx + Math.cos(ang) * rr;
    const cz = tcz + Math.sin(ang) * rr;
    if (inRiverX(cx, 90)) continue;
    if (minDistToTrack(cx, cz, coarse) < 72) continue;
    if (clusters.some((c) => Math.hypot(c.x - cx, c.z - cz) < 150)) continue;
    clusters.push({ x: cx, z: cz, yaw: rng() * Math.PI });
  }
  // 강가 동네: 강변 타워 뒤편(양안)에 주택가를 촘촘히
  if (river) {
    let placed = 0, att2 = 0;
    while (placed < 7 && att2++ < 160) {
      const side = rng() < 0.5 ? -1 : 1;
      const hx = side < 0
        ? river.x0 - range(rng, 130, 250)
        : river.x1 + range(rng, 130, 250);
      const hz = river.zBridge + (rng() - 0.5) * 950;
      if (Math.abs(hz - river.zBridge) < 130) continue; // 다리 접속부 회피
      if (minDistToTrack(hx, hz, coarse) < 70) continue;
      if (nearLandmark(hx, hz)) continue;               // 랜드마크 주변 비움
      if (clusters.some((c) => Math.hypot(c.x - hx, c.z - hz) < 130)) continue;
      clusters.push({ x: hx, z: hz, yaw: rng() * Math.PI });
      placed++;
    }
  }

  const houseMats = [], houseSeeds = [], houseColors = [], roofColors = [];
  for (const cl of clusters) {
    const rows = 3 + Math.floor(rng() * 2);
    const cols = 4 + Math.floor(rng() * 3);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (rng() < 0.15) continue; // 빈 필지
      const lx = (c - (cols - 1) / 2) * 9.5 + range(rng, -1.2, 1.2);
      const lz = (r - (rows - 1) / 2) * 11.5 + range(rng, -1.2, 1.2);
      const wx = cl.x + lx * Math.cos(cl.yaw) + lz * Math.sin(cl.yaw);
      const wz = cl.z - lx * Math.sin(cl.yaw) + lz * Math.cos(cl.yaw);
      if (minDistToTrack(wx, wz, coarse) < 42) continue;
      if (nearTip(wx, wz)) continue; // 트랙 끝단 비움
      if (nearBranch(wx, wz, 18)) continue; // 분기 도로 자리
      if (nearGapZone(wx, wz)) continue;    // 쉼터 확장 노면·분기 입구
      const s = range(rng, 0.8, 1.15);
      const hyaw = cl.yaw + (rng() < 0.5 ? 0 : Math.PI) + range(rng, -0.06, 0.06);
      houseMats.push(composeMatrix(new THREE.Vector3(wx, 0, wz), hyaw,
        new THREE.Vector3(s, s, s)));
      houseSeeds.push(rng() * 1000);
      houseColors.push(lerpColor(pick(rng, HOUSE_COLORS), 0x1c1e24, 0.5));
      roofColors.push(new THREE.Color(pick(rng, ROOF_COLORS)));
    }
  }
  if (!houseMats.length) return;

  // 벽체 (창문 셰이더 + aSeed)
  const wallGeo = new THREE.BoxGeometry(5.2, 3.2, 6.4);
  wallGeo.translate(0, 1.6, 0);
  wallGeo.setAttribute('aSeed',
    new THREE.InstancedBufferAttribute(new Float32Array(houseSeeds), 1));
  const walls = new THREE.InstancedMesh(wallGeo, makeFacadeMaterial(), houseMats.length);
  houseMats.forEach((m, i) => {
    walls.setMatrixAt(i, m);
    walls.setColorAt(i, houseColors[i]);
  });
  walls.instanceMatrix.needsUpdate = true;
  walls.instanceColor.needsUpdate = true;
  walls.frustumCulled = false;
  scene.add(walls);

  // 박공지붕 (삼각 프리즘, 처마가 벽보다 살짝 넓게)
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-3.0, 0); roofShape.lineTo(3.0, 0); roofShape.lineTo(0, 1.9);
  roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 7.0, bevelEnabled: false });
  roofGeo.translate(0, 3.15, -3.5);
  addInstanced(scene, roofGeo,
    new THREE.MeshLambertMaterial({ color: 0xffffff }), houseMats, { colors: roofColors });
}

// 강 밴드(x0~x1, 남북 방향): 하늘 반사 + 잔물결이 흐르는 수면, 콘크리트 호안,
// 강변 산책로 조명, 물가 불빛의 수면 반사 스트릭. 강변 빌딩은 도심과 같은
// GLB 인스턴스(bankSpots는 그 배치 정보)로 buildEnvironment에서 세운다.
