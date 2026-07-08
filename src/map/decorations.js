// 야간 고가도로 환경 구성
// - 데크: 갓길 포장 + 측면 스커트(거더) + 어두운 파라펫 + 상단 LED 라이트 스트립
// - 교각이 일정 간격으로 지상까지 내려감
// - 데크 아래·옆으로 불 켜진 빌딩 스카이라인 (창문 발광 랜덤)
// - 가로등: 발광 헤드 + 도로 위 빛 웅덩이 데칼 (실제 광원 없이 야간 연출)

import * as THREE from 'three';
import { pick, range } from '../utils/rng.js';
import { instantiate } from '../utils/assets.js';

const SHOULDER = 2.2;        // 도로 가장자리 → 파라펫까지 갓길 폭
const PARAPET_HEIGHT = 1.15;

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

// 트랙을 따라가는 리본 지오메트리 (height>0: 수직 벽 / 아니면: 수평 데크)
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

// 가로등 빛 웅덩이 데칼 텍스처 (방사형 그라디언트)
function lightPoolTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,214,150,0.85)');
  g.addColorStop(0.5, 'rgba(255,190,110,0.28)');
  g.addColorStop(1, 'rgba(255,180,90,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

// 창문 발광 배리에이션 (빌딩 단위로 랜덤 적용)
function windowVariants() {
  return [
    { mat: new THREE.MeshBasicMaterial({ color: 0xffc978 }), p: 0.45 }, // 따뜻한 불빛
    { mat: new THREE.MeshBasicMaterial({ color: 0x9fc0ff }), p: 0.25 }, // 차가운 불빛
    { mat: new THREE.MeshBasicMaterial({ color: 0x0d1018 }), p: 0.3 },  // 소등
  ];
}

function makeLamp(headMat, poleMat) {
  const lamp = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 5.2, 8), poleMat);
  pole.position.y = 2.6;
  lamp.add(pole);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 2.0), poleMat);
  arm.position.set(0, 5.1, 0.9);
  lamp.add(arm);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.8), headMat);
  head.position.set(0, 5.0, 1.75);
  lamp.add(head);
  return lamp;
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

  // 1) 지상: 야간 도시 바닥 (아주 어둡게)
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1400, 48),
    new THREE.MeshLambertMaterial({ color: lerpColor(palette.ground, 0x04050a, 0.8) })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // 2) 데크 갓길 포장 (도로보다 살짝 아래, 어두운 콘크리트)
  const apron = new THREE.Mesh(
    trackRibbon(samples, { wHalf: parapetOffset + 0.35, yBase: -0.015 }),
    new THREE.MeshLambertMaterial({ color: 0x3c3e46 })
  );
  apron.receiveShadow = true;
  scene.add(apron);

  // 3) 데크 측면 스커트(거더) — 아래에서 봐도 고가답게
  const skirtMat = new THREE.MeshBasicMaterial({ color: 0x1b1d26, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset + 0.35, side, height: 2.4, yBase: -2.4 }),
      skirtMat
    ));
  }

  // 4) 파라펫(어두운 방호벽) + 상단 LED 라이트 스트립
  const parapetMat = new THREE.MeshBasicMaterial({ color: 0x31343e, side: THREE.DoubleSide });
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xffd9a2, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset, side, height: PARAPET_HEIGHT }),
      parapetMat
    ));
    scene.add(new THREE.Mesh(
      trackRibbon(samples, { offset: parapetOffset, side, height: 0.12, yBase: PARAPET_HEIGHT }),
      stripMat
    ));
  }

  // 5) 교각 (일정 간격, 지상 → 데크)
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x272a34 });
  const pierStep = Math.max(1, Math.round(38 / segLen));
  for (let i = 0; i < n; i += pierStep) {
    const s = samples[i];
    const pier = new THREE.Mesh(new THREE.BoxGeometry(3.6, deckY, 2.6), pierMat);
    pier.position.set(s.pos.x, deckY / 2 - 0.1, s.pos.z);
    pier.rotation.y = Math.atan2(s.tangent.x, s.tangent.z);
    scene.add(pier);
  }

  // 6) 가로등 (양쪽 교차, 발광 헤드 + 도로 위 빛 웅덩이)
  const lampHeadMat = new THREE.MeshBasicMaterial({ color: 0xffe7b8 });
  const lampPoleMat = new THREE.MeshLambertMaterial({ color: 0x3a3d47 });
  const poolTex = lightPoolTexture();
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lampStep = Math.max(1, Math.round(30 / segLen));
  let lampIdx = 0;
  for (let i = 0; i < n; i += lampStep) {
    const s = samples[i];
    const side = lampIdx++ % 2 === 0 ? 1 : -1;
    const lamp = makeLamp(lampHeadMat, lampPoleMat);
    lamp.position.copy(s.pos).addScaledVector(s.left, (parapetOffset - 0.35) * side);
    lamp.rotation.y = Math.atan2(-s.left.x * side, -s.left.z * side); // 헤드가 도로 쪽으로
    scene.add(lamp);

    const pool = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.copy(s.pos)
      .addScaledVector(s.left, (parapetOffset - 2.1) * side)
      .setY(deckY + 0.04);
    scene.add(pool);
  }

  // 7) 지상 빌딩 스카이라인 (양 사이드 상시 채움, 창문 불빛 랜덤)
  const winVars = windowVariants();
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
        const building = instantiate(rng() > 0.5 ? 'buildingA' : 'buildingB', {
          Facade: lerpColor(accent, 0x2a2e40, 0.75).getHex(), // 야간: 외벽 어둡게
        });
        // 창문: 빌딩 단위로 불빛 배리에이션
        const roll = rng();
        let acc = 0;
        let winMat = winVars[winVars.length - 1].mat;
        for (const v of winVars) {
          acc += v.p;
          if (roll < acc) { winMat = v.mat; break; }
        }
        building.traverse((o) => {
          if (o.isMesh) {
            const swap = (m) => (m.name === 'Window' ? winMat : m);
            o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
          }
        });
        building.scale.set(sc, scy, sc);
        building.position.set(x, 0, z);
        building.rotation.y = Math.atan2(-s.left.x * side, -s.left.z * side);
        scene.add(building);
      }
      i += Math.max(3, Math.round((alongWidth + 1.2) / segLen));
    }
  }

  // 8) 원경 산맥 (밤 실루엣)
  const mountainColor = lerpColor(palette.skyHorizon, 0x090b16, 0.7);
  for (let i = 0; i < 26; i++) {
    const angle = (i / 26) * Math.PI * 2 + range(rng, -0.1, 0.1);
    const dist = range(rng, 750, 1050);
    const height = range(rng, 90, 220);
    const mountain = new THREE.Mesh(
      new THREE.ConeGeometry(range(rng, 120, 240), height, 5),
      new THREE.MeshLambertMaterial({ color: mountainColor })
    );
    mountain.position.set(Math.cos(angle) * dist, height / 2 - 8, Math.sin(angle) * dist);
    mountain.rotation.y = rng() * Math.PI;
    scene.add(mountain);
  }
}
