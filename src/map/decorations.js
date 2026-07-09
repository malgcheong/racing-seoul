// 야간 고가도로 환경 구성 (인스턴싱 버전)
// 반복 오브젝트(빌딩·가로등·교각·산)는 InstancedMesh로 묶어
// 수백 개의 드로우콜을 종류당 1개로 줄인다.
// 빌딩 외벽/창문 색은 instanceColor로 개별 유지.

import * as THREE from 'three';
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
      im.castShadow = true;
      im.frustumCulled = false;
      scene.add(im);
    } else {
      // RoofTrim 등: 원래 머티리얼 유지
      addInstanced(scene, mesh.geometry, mesh.material, list.map((b) => b.matrix));
    }
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
    new THREE.CircleGeometry(1600, 48),
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

  // 7) 지상 빌딩 스카이라인 (외벽은 절차적 창문 셰이더, 색은 instanceColor)
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
        const type = rng() > 0.5 ? 'buildingA' : 'buildingB';
        buildingLists[type].push({
          matrix: composeMatrix(
            new THREE.Vector3(x, 0, z),
            Math.atan2(-s.left.x * side, -s.left.z * side),
            new THREE.Vector3(sc, scy, sc)
          ),
          facade: lerpColor(accent, 0x20242f, 0.82), // 야간 외벽: 어둡게(창문이 도드라지게)
          seed: rng() * 1000,
        });
      }
      i += Math.max(3, Math.round((alongWidth + 1.2) / segLen));
    }
  }
  buildInstancedBuildings(scene, 'buildingA', buildingLists.buildingA);
  buildInstancedBuildings(scene, 'buildingB', buildingLists.buildingB);

  // 8) 원경 산맥 (Blender 3D 모델)
  buildMountainRanges(scene, rng);

  return { lampHeads };
}

// Blender 제작 3D 산맥 모델(mountain.glb)을 원경 배경으로 배치.
// GLB의 PBR 머티리얼(바위 텍스처+정점색)을 언릿 MeshBasic으로 바꿔
// 야간 조명과 무관하게 일정 밝기로 지평선에 보이게 한다.
// 바위 디테일 텍스처(게임 생성): 밝은 회색 베이스에 어두운 알갱이·크랙.
// GLB에 심은 UV(둘레 48회·반경 5회 반복)에 타일링되어 정점색과 곱해진다.
let _rockTex = null;
function mountainRockTexture() {
  if (_rockTex) return _rockTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#cfcfcf';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 3000; i++) {
    const v = 90 + Math.random() * 90;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.15 + Math.random() * 0.25})`;
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
  }
  ctx.strokeStyle = 'rgba(70,70,70,0.5)';
  for (let i = 0; i < 30; i++) {
    let x = Math.random() * 128, y = Math.random() * 128;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let j = 0; j < 5; j++) { x += (Math.random() - 0.5) * 24; y += (Math.random() - 0.5) * 24; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  _rockTex = new THREE.CanvasTexture(c);
  _rockTex.wrapS = _rockTex.wrapT = THREE.RepeatWrapping;
  return _rockTex;
}

function buildMountainRanges(scene, rng) {
  const model = instantiate('mountain');
  // XZ는 크게(지평선까지), Y는 빌딩 위로 봉우리가 드러나게
  model.scale.set(88, 16, 88);
  model.position.y = -4;
  model.rotation.y = rng() * Math.PI * 2; // 방향 랜덤(판마다 다른 능선 노출)
  model.traverse((o) => {
    if (!o.isMesh) return;
    // Blender 정점색(숲/바위/눈) x 게임 바위 디테일 텍스처, 언릿(야간 조명 무관)
    // color>1 배수로 달빛 받은 산처럼 밝게 (baked 정점색이 어두워 야간에 묻히는 것 보정)
    const mat = new THREE.MeshBasicMaterial({
      map: mountainRockTexture(),
      vertexColors: true,
      fog: false,
      side: THREE.DoubleSide,
    });
    mat.color.setRGB(2.1, 2.1, 2.1);
    o.material = mat;
    o.renderOrder = -10;
    o.frustumCulled = false;
  });
  scene.add(model);
}
