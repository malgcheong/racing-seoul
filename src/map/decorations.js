// 코리도(도심 서킷) 환경 구성
// 도로 양쪽을 연속 배리어 + 빌딩/나무 행렬로 항상 채워서
// 시야에 맨땅이 보이지 않게 하고, 도로 밖을 시각적으로도 막는다.
// (물리적 차단은 game.js의 측면 클램프가 담당)

import * as THREE from 'three';
import { pick, range } from '../utils/rng.js';
import { instantiate } from '../utils/assets.js';

const BARRIER_HEIGHT = 2.3;
const SHOULDER = 2.2;          // 도로 가장자리 → 배리어까지 갓길 폭

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

// 배리어 스트라이프 텍스처 (팔레트 색 + 흰색 교차)
function barrierTexture(accentHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + new THREE.Color(accentHex).getHexString();
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#f2f0ea';
  ctx.fillRect(32, 0, 32, 32);
  // 하단 어두운 밑단
  ctx.fillStyle = 'rgba(20,22,30,0.35)';
  ctx.fillRect(0, 24, 64, 8);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// 트랙을 따라가는 리본 지오메트리 (평면: y 고정 폭 wHalf / 수직: 높이 h)
function trackRibbon(samples, { offset = 0, side = 0, wHalf = 0, height = 0, y = 0 }) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const n = samples.length;
  let dist = 0;

  for (let i = 0; i <= n; i++) {
    const s = samples[i % n];
    if (i > 0) dist += s.pos.distanceTo(samples[(i - 1) % n].pos);
    if (height > 0) {
      // 수직 리본 (배리어)
      const bx = s.pos.x + s.left.x * offset * side;
      const bz = s.pos.z + s.left.z * offset * side;
      positions.push(bx, y, bz, bx, y + height, bz);
      uvs.push(dist / 6, 0, dist / 6, 1);
    } else {
      // 수평 리본 (갓길 포장)
      const l = s.pos.clone().addScaledVector(s.left, wHalf);
      const r = s.pos.clone().addScaledVector(s.left, -wHalf);
      positions.push(l.x, y, l.z, r.x, y, r.z);
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

export function buildEnvironment(scene, rng, samples, palette, roadWidth) {
  const halfW = roadWidth / 2;
  const barrierOffset = halfW + SHOULDER;
  const n = samples.length;
  const segLen = (() => {
    let total = 0;
    for (let i = 0; i < n; i++) total += samples[i].pos.distanceTo(samples[(i + 1) % n].pos);
    return total / n;
  })();

  // 1) 지면: 어둡게 처리해 울타리 너머로 보여도 "맨땅"으로 읽히지 않게
  const groundColor = lerpColor(palette.ground, 0x0c0e18, 0.62);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1400, 48),
    new THREE.MeshLambertMaterial({ color: groundColor })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // 2) 갓길 포장 (도로보다 살짝 아래, 콘크리트색)
  const apron = new THREE.Mesh(
    trackRibbon(samples, { wHalf: barrierOffset + 0.3, y: 0.005 }),
    new THREE.MeshLambertMaterial({ color: lerpColor(0x8d8f96, palette.ground, 0.2) })
  );
  apron.receiveShadow = true;
  scene.add(apron);

  // 3) 연속 배리어 (양쪽, 스트라이프)
  const stripeTex = barrierTexture(palette.accents[0]);
  const barrierMat = new THREE.MeshBasicMaterial({ map: stripeTex, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const barrier = new THREE.Mesh(
      trackRibbon(samples, { offset: barrierOffset, side, height: BARRIER_HEIGHT }),
      barrierMat
    );
    scene.add(barrier);
  }

  // 4) 배리어 뒤 빌딩/나무 행렬 — 양쪽을 빈틈 없이 채운다
  const coarse = samples.filter((_, i) => i % 8 === 0).map((s) => s.pos);

  for (const side of [-1, 1]) {
    let i = Math.floor(rng() * 6);
    while (i < n) {
      const s = samples[i];
      const isTree = rng() < 0.28;
      let alongWidth;

      if (isTree) {
        // 나무 클러스터: 배리어 바로 뒤에 2그루
        alongWidth = 9;
        for (const dAlong of [-2.2, 2.4]) {
          const scale = range(rng, 1.7, 2.6);
          const off = barrierOffset + range(rng, 2.2, 4.5);
          const x = s.pos.x + s.left.x * off * side + s.tangent.x * dAlong;
          const z = s.pos.z + s.left.z * off * side + s.tangent.z * dAlong;
          const accent = pick(rng, palette.accents);
          const tree = instantiate(rng() > 0.45 ? 'treeRound' : 'treePine', {
            Foliage: lerpColor(accent, 0x2e8b3d, 0.55).getHex(),
          });
          tree.scale.setScalar(scale);
          tree.position.set(x, 0, z);
          tree.rotation.y = rng() * Math.PI * 2;
          scene.add(tree);
        }
      } else {
        // 빌딩: 정면(창문)이 도로를 향하도록 정렬
        const sc = range(rng, 0.85, 1.35);
        const scy = range(rng, 0.6, 1.6);
        const depthHalf = 4.4 * sc;
        const off = barrierOffset + 0.4 + depthHalf;
        const x = s.pos.x + s.left.x * off * side;
        const z = s.pos.z + s.left.z * off * side;
        alongWidth = 8.6 * sc;

        // 다른 트랙 구간을 침범하면 이 자리는 배리어만 남기고 건너뜀
        if (minDistToTrack(x, z, coarse) >= Math.min(off - 1, 11)) {
          const accent = pick(rng, palette.accents);
          const building = instantiate(rng() > 0.5 ? 'buildingA' : 'buildingB', {
            Facade: lerpColor(accent, 0x8890a8, 0.45).getHex(),
          });
          building.scale.set(sc, scy, sc);
          building.position.set(x, 0, z);
          // 로컬 Z(창문 면)가 도로 쪽을 보도록
          building.rotation.y = Math.atan2(-s.left.x * side, -s.left.z * side);
          scene.add(building);
        }
      }
      i += Math.max(3, Math.round((alongWidth + 0.8) / segLen));
    }
  }

  // 5) 원경 산맥 (빌딩 위 스카이라인)
  const mountainColor = lerpColor(palette.skyHorizon, 0x30364f, 0.6);
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
