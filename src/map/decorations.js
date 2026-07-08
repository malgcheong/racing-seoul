// 야간 고가도로 환경 구성 (인스턴싱 버전)
// 반복 오브젝트(빌딩·가로등·교각·산)는 InstancedMesh로 묶어
// 수백 개의 드로우콜을 종류당 1개로 줄인다.
// 빌딩 외벽/창문 색은 instanceColor로 개별 유지.

import * as THREE from 'three';
import { pick, range } from '../utils/rng.js';
import { getAssetTemplate } from '../utils/assets.js';

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

// 트랙을 따라가는 리본 지오메트리
// height>0: 수직 벽 / offset>0 && side!=0: 사이드 밴드 / 그 외: 중심 수평 리본
function trackRibbon(samples, { offset = 0, side = 0, wHalf = 0, height = 0, yBase = 0 }) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const n = samples.length;
  let dist = 0;

  for (let i = 0; i <= n; i++) {
    const s = samples[i % n];
    if (i > 0) dist += s.pos.distanceTo(samples[(i - 1) % n].pos);
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
    if (i < n) {
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

// 빌딩 에셋의 프리미티브별 InstancedMesh 생성 (외벽/창문은 instanceColor)
function buildInstancedBuildings(scene, type, list) {
  if (!list.length) return;
  const meshes = [];
  getAssetTemplate(type).traverse((o) => { if (o.isMesh) meshes.push(o); });

  for (const mesh of meshes) {
    const name = mesh.material.name;
    let material = mesh.material;
    let colors = null;
    if (name === 'Facade') {
      material = mesh.material.clone();
      material.color.set(0xffffff); // instanceColor가 곱해짐
      colors = list.map((b) => b.facade);
    } else if (name === 'Window') {
      material = new THREE.MeshBasicMaterial({ color: 0xffffff }); // 야간 발광(언릿)
      colors = list.map((b) => b.window);
    }
    addInstanced(scene, mesh.geometry, material, list.map((b) => b.matrix), {
      colors,
      castShadow: name === 'Facade',
    });
  }
}

export function buildEnvironment(scene, rng, samples, palette, roadWidth) {
  const halfW = roadWidth / 2;
  const parapetOffset = halfW + SHOULDER;
  const deckY = samples[0].pos.y;
  const n = samples.length;
  const segLen = (() => {
    let total = 0;
    for (let i = 0; i < n; i++) total += samples[i].pos.distanceTo(samples[(i + 1) % n].pos);
    return total / n;
  })();

  // 1) 지상: 야간 도시 바닥
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1400, 48),
    new THREE.MeshLambertMaterial({ color: lerpColor(palette.ground, 0x04050a, 0.8) })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // 2) 데크 갓길 포장
  const apron = new THREE.Mesh(
    trackRibbon(samples, { wHalf: parapetOffset + 0.35, yBase: -0.015 }),
    new THREE.MeshLambertMaterial({ color: 0x3c3e46 })
  );
  apron.receiveShadow = true;
  scene.add(apron);

  // 3) 데크 측면 스커트(거더)
  const skirtMat = new THREE.MeshBasicMaterial({ color: 0x1b1d26, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset + 0.35, side, height: 2.4, yBase: -2.4 }),
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
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset, side, height: PARAPET_HEIGHT }),
      parapetMat
    ));
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset, side, height: 0.12, yBase: PARAPET_HEIGHT }),
      stripMat
    ));
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset - 1.0, side, wHalf: 0.9, yBase: 0.035 }),
      stripReflMat
    ));
  }

  // 5) 교각 (인스턴싱)
  const pierMatrices = [];
  const pierStep = Math.max(1, Math.round(38 / segLen));
  for (let i = 0; i < n; i += pierStep) {
    const s = samples[i];
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
  for (const part of lampParts) {
    const localM = new THREE.Matrix4().makeTranslation(part.local.x, part.local.y, part.local.z);
    addInstanced(scene, part.geo, part.mat,
      lampMatrices.map((m) => m.clone().multiply(localM)));
  }
  addInstanced(scene, new THREE.PlaneGeometry(22, 22), new THREE.MeshBasicMaterial({
    map: lightPoolTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }), poolMatrices);

  // 7) 지상 빌딩 스카이라인 (에셋 타입별 인스턴싱, 색은 instanceColor)
  const WINDOW_VARIANTS = [
    { color: new THREE.Color(0xffc978), p: 0.45 }, // 따뜻한 불빛
    { color: new THREE.Color(0x9fc0ff), p: 0.25 }, // 차가운 불빛
    { color: new THREE.Color(0x0d1018), p: 0.3 },  // 소등
  ];
  const buildingLists = { buildingA: [], buildingB: [] };
  const coarse = samples.filter((_, i) => i % 8 === 0).map((s) => s.pos);
  for (const side of [-1, 1]) {
    let i = Math.floor(rng() * 6);
    while (i < n) {
      const s = samples[i];
      const sc = range(rng, 0.85, 1.4);
      const scy = range(rng, 0.7, 2.1);
      const depthHalf = 4.4 * sc;
      const off = parapetOffset + 4.5 + depthHalf;
      const x = s.pos.x + s.left.x * off * side;
      const z = s.pos.z + s.left.z * off * side;
      const alongWidth = 8.6 * sc;

      if (minDistToTrack(x, z, coarse) >= Math.min(off - 1, 12)) {
        const accent = pick(rng, palette.accents);
        const roll = rng();
        let acc = 0;
        let winColor = WINDOW_VARIANTS[WINDOW_VARIANTS.length - 1].color;
        for (const v of WINDOW_VARIANTS) {
          acc += v.p;
          if (roll < acc) { winColor = v.color; break; }
        }
        const type = rng() > 0.5 ? 'buildingA' : 'buildingB';
        buildingLists[type].push({
          matrix: composeMatrix(
            new THREE.Vector3(x, 0, z),
            Math.atan2(-s.left.x * side, -s.left.z * side),
            new THREE.Vector3(sc, scy, sc)
          ),
          facade: lerpColor(pick(rng, [accent]), 0x2a2e40, 0.75),
          window: winColor,
        });
      }
      i += Math.max(3, Math.round((alongWidth + 1.2) / segLen));
    }
  }
  buildInstancedBuildings(scene, 'buildingA', buildingLists.buildingA);
  buildInstancedBuildings(scene, 'buildingB', buildingLists.buildingB);

  // 8) 원경 산맥 (단위 콘 + 인스턴스 스케일)
  const mountainMatrices = [];
  for (let i = 0; i < 26; i++) {
    const angle = (i / 26) * Math.PI * 2 + range(rng, -0.1, 0.1);
    const dist = range(rng, 750, 1050);
    const height = range(rng, 90, 220);
    const radius = range(rng, 120, 240);
    mountainMatrices.push(composeMatrix(
      new THREE.Vector3(Math.cos(angle) * dist, height / 2 - 8, Math.sin(angle) * dist),
      rng() * Math.PI,
      new THREE.Vector3(radius, height, radius)
    ));
  }
  addInstanced(scene, new THREE.ConeGeometry(1, 1, 5),
    new THREE.MeshLambertMaterial({ color: lerpColor(palette.skyHorizon, 0x090b16, 0.7) }),
    mountainMatrices);

  return { lampHeads };
}
