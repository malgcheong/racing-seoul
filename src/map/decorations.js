// 야간 고가도로 환경 구성 (인스턴싱 버전)
// 반복 오브젝트(빌딩·가로등·교각·산)는 InstancedMesh로 묶어
// 수백 개의 드로우콜을 종류당 1개로 줄인다.
// 빌딩 외벽/창문 색은 instanceColor로 개별 유지.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pick, range } from '../utils/rng.js';
import { getAssetTemplate, instantiate } from '../utils/assets.js';

const SHOULDER = 2.2;        // 도로 가장자리 → 파라펫까지 갓길 폭
const PARAPET_HEIGHT = 1.15;
const CONE_HEIGHT = 5.3;
const UP = new THREE.Vector3(0, 1, 0);

function lerpColor(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

function minDistToTrack(x, z, coarse) {
  let min = Infinity;
  for (const p of coarse) {
    const dx = x - p.x;
    const dz = z - p.z;
    const d = dx * dx + dz * dz;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}

// 자기 도로 구간(코스 인덱스 ci±skip)을 제외한 트랙까지의 최소 거리.
// 도로변 건물은 자기 구간에서는 당연히 가깝기 때문에 minDistToTrack만으로는
// S자 커브에서 "다른 트랙 가지" 위에 떨어지는 걸 못 잡는다 — 이 함수로 걸러낸다.
function minDistToTrackFar(x, z, coarse, ci, skip) {
  let min = Infinity;
  for (let k = 0; k < coarse.length; k++) {
    if (Math.abs(k - ci) <= skip) continue;
    const dx = x - coarse[k].x;
    const dz = z - coarse[k].z;
    const d = dx * dx + dz * dz;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}

// 트랙을 따라가는 리본 지오메트리 (개방 루트: 끝→시작 연결 없음)
// height>0: 수직 벽 / offset>0 && side!=0: 사이드 밴드 / 그 외: 중심 수평 리본
// gap: {idx, halfSpan} 또는 그 배열 — 해당 인덱스 구간의 세그먼트를 비운다(입구 등)
function trackRibbon(samples, { offset = 0, side = 0, wHalf = 0, height = 0, yBase = 0, gap = null }) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const n = samples.length;
  let dist = 0;
  const gapList = gap ? (Array.isArray(gap) ? gap : [gap]) : [];
  const inGapSeg = (i) => gapList.some((g) => Math.abs(i - g.idx) < g.halfSpan);

  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (i > 0) dist += s.pos.distanceTo(samples[i - 1].pos);
    if (height > 0) {
      const bx = s.pos.x + s.left.x * offset * side;
      const bz = s.pos.z + s.left.z * offset * side;
      const y0 = s.pos.y + yBase;
      positions.push(bx, y0, bz, bx, y0 + height, bz);
      uvs.push(dist / 6, 0, dist / 6, 1);
    } else if (offset > 0 && side !== 0) {
      const l = s.pos.clone().addScaledVector(s.left, (offset + wHalf) * side);
      const r = s.pos.clone().addScaledVector(s.left, (offset - wHalf) * side);
      positions.push(l.x, l.y + yBase, l.z, r.x, r.y + yBase, r.z);
      uvs.push(0, dist / 10, 1, dist / 10);
    } else {
      const l = s.pos.clone().addScaledVector(s.left, wHalf);
      const r = s.pos.clone().addScaledVector(s.left, -wHalf);
      positions.push(l.x, l.y + yBase, l.z, r.x, r.y + yBase, r.z);
      uvs.push(0, dist / 10, 1, dist / 10);
    }
    if (i < n - 1 && !inGapSeg(i)) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// 가로등 빛 웅덩이 데칼 텍스처 — 가우시안처럼 완만하게 감쇠해야 원판 티가 안 남
function lightPoolTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 2, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,232,195,0.34)');
  g.addColorStop(0.25, 'rgba(255,222,175,0.20)');
  g.addColorStop(0.55, 'rgba(255,210,155,0.08)');
  g.addColorStop(0.8, 'rgba(255,200,140,0.025)');
  g.addColorStop(1, 'rgba(255,195,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

// 볼륨 라이트 콘 셰이더 — 실루엣에서 소멸시켜 폴리곤 고깔 윤곽을 지운다
// InstancedMesh 대응: USE_INSTANCING 분기
function makeConeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(0xffdfae) },
      uIntensity: { value: 0.38 },
      uHeight: { value: CONE_HEIGHT },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying float vH; // 0=바닥, 1=램프 헤드
      uniform float uHeight;
      void main() {
        vec4 pos = vec4(position, 1.0);
        vec3 nrm = normal;
        #ifdef USE_INSTANCING
          pos = instanceMatrix * pos;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vNormal = normalize(normalMatrix * nrm);
        vec4 mv = modelViewMatrix * pos;
        vViewDir = normalize(-mv.xyz);
        vH = clamp(position.y / uHeight + 0.5, 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying float vH;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float edgeFade = pow(facing, 2.4);   // 실루엣 가장자리 소멸
        float vertical = pow(vH, 1.7);       // 아래로 갈수록 소멸
        gl_FragColor = vec4(uColor, edgeFade * vertical * uIntensity);
      }
    `,
  });
}

// 캔버스 텍스처 공통 헬퍼
function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  return new THREE.CanvasTexture(cv);
}

// 네온 간판 캔버스 텍스처 (어두운 판 + 글로우 텍스트)
function neonSignTexture(text, color) {
  return canvasTex(256, 96, (ctx) => {
    ctx.fillStyle = 'rgba(8,10,16,0.94)';
    ctx.fillRect(0, 0, 256, 96);
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, 244, 84);
    ctx.font = 'bold 42px "Malgun Gothic", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = color; ctx.shadowBlur = 16;
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 50);
  });
}

const NEON_SIGNS = [
  ['24시 편의점', '#57e0a0'], ['노래방', '#ff5da2'], ['HOTEL', '#6fb7ff'],
  ['치킨 · 호프', '#ffb347'], ['CAFE', '#c88cff'], ['PC방', '#59d8e6'],
  ['사우나', '#ff8a5c'], ['약국', '#7dffa8'],
];

// 고속도로 문형(갠트리) 녹색 방향표지판
function gantrySignTexture(line1, line2) {
  return canvasTex(512, 224, (ctx, w, h) => {
    ctx.fillStyle = '#0d5a2e'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#eef6ef'; ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 64px "Malgun Gothic", sans-serif';
    ctx.fillText(line1, w / 2, 74);
    ctx.font = 'bold 46px "Malgun Gothic", sans-serif';
    ctx.fillText(line2, w / 2, 158);
  });
}

// 대형 전광판용 광고 스트립: 광고 4개를 가로로 이어 붙인 와이드 캔버스.
// repeat.x=0.25 + offset 애니메이션으로 한 장씩 슬라이드된다.
function adStripTexture() {
  const ADS = [
    ['NIGHT DRIVE', '#101826', '#6fb7ff'],
    ['별빛 극장', '#1a0f22', '#ff5da2'],
    ['NEON OIL', '#101c14', '#57e0a0'],
    ['한강 크루즈', '#1c1410', '#ffb347'],
  ];
  return canvasTex(2048, 216, (ctx, w, h) => {
    ADS.forEach(([text, bg, fg], i) => {
      const x0 = i * 512;
      ctx.fillStyle = bg; ctx.fillRect(x0, 0, 512, h);
      ctx.strokeStyle = fg; ctx.lineWidth = 6; ctx.strokeRect(x0 + 8, 8, 496, h - 16);
      ctx.font = 'bold 84px "Malgun Gothic", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = fg; ctx.shadowBlur = 26;
      ctx.fillStyle = fg;
      ctx.fillText(text, x0 + 256, h / 2 + 4);
    });
  });
}

function composeMatrix(pos, yaw, scale = new THREE.Vector3(1, 1, 1)) {
  return new THREE.Matrix4().compose(
    pos,
    new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    scale
  );
}

function addInstanced(scene, geometry, material, matrices, { colors = null, castShadow = false } = {}) {
  const im = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((m, i) => {
    im.setMatrixAt(i, m);
    if (colors) im.setColorAt(i, colors[i]);
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = castShadow;
  im.frustumCulled = false; // 트랙 전체에 퍼져 있어 컬링 이득이 없음
  scene.add(im);
  return im;
}

// 절차적 창문 외벽 머티리얼: object 공간 좌표로 창 격자를 계산해
// 스케일·회전에 뭉개지지 않는 깔끔한 창문. 창마다 랜덤 점등(따뜻/차가운 빛)되고
// 켜진 창은 발광(bloom)한다. instanceColor로 외벽 색을, aSeed로 창 패턴을 개별화.
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
function buildInstancedBuildings(scene, type, list) {
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
        for (const bx of [river.x0 - 10.5, river.x1 + 10.5]) {
          if (rng() < 0.3) continue;
          const s = range(rng, 0.8, 1.3);
          treeMats.push(composeMatrix(
            new THREE.Vector3(bx, 0, z + range(rng, -4, 4)),
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

    // 노면 데칼 — 도로 위 페인트. 텍스트 상단이 진행 방향을 향하게 굽는다.
    const tex80 = canvasTex(128, 256, (ctx) => {
      ctx.font = 'bold 150px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(232,236,244,0.8)';
      ctx.fillText('80', 64, 128);
    });
    const texArrow = canvasTex(128, 256, (ctx) => {
      ctx.fillStyle = 'rgba(232,236,244,0.75)';
      ctx.beginPath();
      ctx.moveTo(64, 10); ctx.lineTo(104, 88); ctx.lineTo(78, 88);
      ctx.lineTo(78, 244); ctx.lineTo(50, 244); ctx.lineTo(50, 88);
      ctx.lineTo(24, 88); ctx.closePath(); ctx.fill();
    });
    const decalGeo = new THREE.PlaneGeometry(2.0, 4.2);
    decalGeo.rotateX(-Math.PI / 2); // 바닥에 눕히고
    decalGeo.rotateY(Math.PI);      // 글자 상단이 로컬 +Z(진행 방향)로
    const mats80 = [], matsArrow = [];
    const laneOff = [-1.5, -0.5, 0.5, 1.5].map((v) => v * (roadWidth / 4));
    const dStep = Math.max(6, Math.floor(n / 16));
    for (let i = 4, k = 0; i < n - 10; i += dStep, k++) {
      if (dRestOf(i) < 4) continue;
      const s = samples[i];
      const lat = pick(rng, laneOff);
      const m = composeMatrix(
        s.pos.clone().addScaledVector(s.left, lat).add(new THREE.Vector3(0, 0.03, 0)),
        Math.atan2(s.tangent.x, s.tangent.z));
      (k % 2 === 0 ? mats80 : matsArrow).push(m);
    }
    const decalMat = (map) => new THREE.MeshBasicMaterial({
      map, transparent: true, depthWrite: false, fog: true,
    });
    if (mats80.length) addInstanced(scene, decalGeo, decalMat(tex80), mats80);
    if (matsArrow.length) addInstanced(scene, decalGeo.clone(), decalMat(texArrow), matsArrow);

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
    buildRiverCrossing(scene, rng, samples, river, bankSpots, updaters, !!branchPts, palette);
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

  return { lampHeads, update: (t, dt) => { for (const f of updaters) f(t, dt); } };
}

// GLB 템플릿의 모든 메시를 인스턴싱 배치. targetH가 있으면 전체 높이를
// 해당 값(m)으로 정규화(에셋 원본 스케일에 무관하게 일정한 크기 보장).
function buildInstancedTemplate(scene, type, mats, targetH = 0) {
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
function buildHouseClusters(scene, rng, coarse, palette, tcx, tcz, textent, inRiverX, river = null, nearLandmark = () => false, nearTip = () => false, nearBranch = () => false, nearGapZone = () => false) {
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
function buildRiverCrossing(scene, rng, samples, river, bankSpots, updaters, hasBranch = false, palette = null) {
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
      walkMats.push(new THREE.Matrix4().compose(
        new THREE.Vector3(lx + side * 7.5, 1.9, jz),
        new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      walkPts.push({ z: jz, side });
    }
  }
  if (walkMats.length) addInstanced(scene, new THREE.SphereGeometry(0.26, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xffd9a2, fog: true }), walkMats);

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

  // ── 강변도로(강변북로·올림픽대로 느낌): 양안을 따라 남북으로, 다리 아래를 통과 ──
  const roadTex = canvasTex(64, 256, (ctx, w, h) => {
    ctx.fillStyle = '#20232b'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(200,205,215,0.5)';
    for (let y = 0; y < h; y += 64) ctx.fillRect(w / 2 - 2, y, 4, 34); // 중앙 점선
    ctx.fillStyle = 'rgba(210,215,225,0.4)';
    ctx.fillRect(2, 0, 3, h); ctx.fillRect(w - 5, 0, 3, h);           // 가장자리 실선
  });
  roadTex.wrapT = THREE.RepeatWrapping;
  roadTex.repeat.set(1, riverLen / 14);
  const roadXs = [x0 - 16, x1 + 16];
  for (const rx of roadXs) {
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(10, riverLen * 0.96),
      new THREE.MeshBasicMaterial({ map: roadTex, fog: true })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(rx, 0.01, cz);
    scene.add(road);
    // 나트륨등 글로우: 도로 띠가 다리 위에서도 또렷이 보이게
    const rglow = new THREE.Mesh(
      new THREE.PlaneGeometry(9, riverLen * 0.96),
      new THREE.MeshBasicMaterial({
        color: 0xffb45c, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
      })
    );
    rglow.rotation.x = -Math.PI / 2;
    rglow.position.set(rx, 0.04, cz);
    scene.add(rglow);
  }
  // 강변도로 가로등 행렬: 도로 바깥쪽을 따라 따뜻한 불빛 점
  const roadLampMats = [];
  for (let wz = cz - riverLen / 2 + 20; wz < cz + riverLen / 2 - 20; wz += 26) {
    for (const rx of roadXs) {
      const out = rx < (x0 + x1) / 2 ? -5.6 : 5.6; // 강 반대쪽 가장자리
      roadLampMats.push(new THREE.Matrix4().compose(
        new THREE.Vector3(rx + out, 4.4, wz + range(rng, -4, 4)),
        new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
    }
  }
  addInstanced(scene, new THREE.SphereGeometry(0.32, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xffe2b0, fog: true }), roadLampMats);

  // 강변도로 차량 불빛: 흰(전조등)·붉은(후미등) 점들이 반대 방향으로 흐른다.
  // InstancedMesh 2개로 드로우콜 2 — 매 프레임 행렬만 갱신.
  const span = riverLen * 0.9;
  const zBase = cz - span / 2;
  const mkDotIm = (color, count) => {
    const im = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.42, 6, 5),
      new THREE.MeshBasicMaterial({ color, fog: true }), count);
    im.frustumCulled = false;
    scene.add(im);
    return im;
  };
  const roadDots = [];
  for (const rx of roadXs) {
    // 서안(x0-16) 도로는 분기 루트로 플레이어가 직접 달린다 →
    // 가짜 점 불빛이 차를 통과해 지나가면 안 되므로 동안에만 배치
    if (hasBranch && rx < (x0 + x1) / 2) continue;
    const per = hasBranch ? 32 : 20; // 한쪽만 쓰면 그쪽 밀도를 높여 보상
    for (let k = 0; k < per; k++) {
      const spd = 22 + rng() * 14; // 고속화도로 속도(22~36m/s) — 느리면 멈춘 듯 보임
      const off = rng() * span;
      roadDots.push({ rx, off, spd });
      // 앞차를 따라가는 소그룹(플래툰) — 흐르는 교통 느낌
      if (rng() < 0.4) roadDots.push({ rx, off: off - 7 - rng() * 9, spd });
    }
  }
  const whiteIm = mkDotIm(0xfff2cf, roadDots.length);
  const redIm = mkDotIm(0xff3a3a, roadDots.length);
  // 차량 불빛의 수면 반사: 물가에서 안쪽으로 번지는 짧은 스트릭이 점을 따라다닌다
  const mkReflIm = (hex) => {
    const im = new THREE.InstancedMesh(streakGeo, new THREE.MeshBasicMaterial({
      map: streakTex, color: hex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    }), roadDots.length);
    im.frustumCulled = false;
    scene.add(im);
    return im;
  };
  const whiteRefl = mkReflIm(0xfff2cf);
  const redRefl = mkReflIm(0xff5a5a);
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _sc = new THREE.Vector3(13, 1, 1.7);
  const _p = new THREE.Vector3();
  updaters.push((t) => {
    for (let i = 0; i < roadDots.length; i++) {
      const d = roadDots[i];
      const side = d.rx < (x0 + x1) / 2 ? -1 : 1; // 서안/동안
      const reflX = side < 0 ? x0 + 8.5 : x1 - 8.5;
      const q = side < 0 ? flipQ : _q.identity();
      const dz = (t * d.spd + d.off) % span;
      _m4.makeTranslation(d.rx - 2.3, 0.55, zBase + dz);          // 북행(흰 점)
      whiteIm.setMatrixAt(i, _m4);
      _m4.compose(_p.set(reflX, 0.43, zBase + dz), q, _sc);
      whiteRefl.setMatrixAt(i, _m4);
      _m4.makeTranslation(d.rx + 2.3, 0.55, zBase + span - dz);   // 남행(붉은 점)
      redIm.setMatrixAt(i, _m4);
      _m4.compose(_p.set(reflX, 0.43, zBase + span - dz), q, _sc);
      redRefl.setMatrixAt(i, _m4);
    }
    whiteIm.instanceMatrix.needsUpdate = true;
    redIm.instanceMatrix.needsUpdate = true;
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
function buildBridgeArches(scene, samples, river, parapetOffset) {
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
        const p0 = smp0.pos.clone().addScaledVector(smp0.left, off * side).add(new THREE.Vector3(0, h0, 0));
        const p1 = smp1.pos.clone().addScaledVector(smp1.left, off * side).add(new THREE.Vector3(0, h1, 0));
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
          const base = smp0.pos.clone().addScaledVector(smp0.left, off * side);
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
function buildMountainRanges(scene, rng, center = new THREE.Vector3(), targetRadius = 1250, river = null) {
  let geo = null;
  getAssetTemplate('mountainRange').traverse((o) => { if (o.isMesh && !geo) geo = o.geometry; });
  if (!geo) return;

  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, fog: true, side: THREE.DoubleSide,
  });
  mat.color.setRGB(3.2, 3.2, 3.2);
  mat.emissive.setRGB(0.04, 0.07, 0.05);

  const mats = [];
  const N = 15; // 링을 도는 세그먼트 수 (겹치며 이어지는 능선들)
  for (let k = 0; k < N; k++) {
    const ang = (k / N) * Math.PI * 2 + range(rng, -0.08, 0.08);
    const rr = targetRadius + range(rng, -140, 160);
    const px = center.x + Math.cos(ang) * rr;
    const pz = center.z + Math.sin(ang) * rr;
    const yaw = -ang + Math.PI / 2 + range(rng, -0.2, 0.2); // 접선 방향(+X 길이축)
    const sl = range(rng, 14, 24);   // 길이 스케일 (40u → 560~960m)
    const sy = range(rng, 16, 28);   // 높이 스케일 (봉우리 ~70~125m)
    // 강 회랑 회피: 세그먼트 중심·양 끝점의 x가 회랑에 걸리면 스킵
    if (river) {
      const dx = Math.cos(yaw) * 20 * sl; // 로컬 +X(길이축 절반)의 월드 x 성분
      const lo = river.x0 - 90, hi = river.x1 + 90;
      const inCorr = (x) => x > lo && x < hi;
      if (inCorr(px) || inCorr(px + dx) || inCorr(px - dx)) continue;
    }
    mats.push(new THREE.Matrix4().compose(
      new THREE.Vector3(px, -2, pz),
      new THREE.Quaternion().setFromAxisAngle(UP, yaw),
      new THREE.Vector3(sl, sy, sl * range(rng, 0.9, 1.5))
    ));
    // 뒷열 보조 능선(멀리 겹쳐 보이는 깊이감), 확률적으로
    if (rng() < 0.5) {
      mats.push(new THREE.Matrix4().compose(
        new THREE.Vector3(
          center.x + Math.cos(ang + 0.06) * (rr + range(rng, 180, 320)), -2,
          center.z + Math.sin(ang + 0.06) * (rr + range(rng, 180, 320))),
        new THREE.Quaternion().setFromAxisAngle(UP, yaw + range(rng, -0.3, 0.3)),
        new THREE.Vector3(sl * 1.2, sy * 1.25, sl * 1.4)
      ));
    }
  }
  if (!mats.length) return;
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((m, i) => im.setMatrixAt(i, m));
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false;
  im.renderOrder = -10;
  scene.add(im);
}
