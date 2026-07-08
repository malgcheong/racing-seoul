// 맵 장식(지면·나무·건물·원경 산) 배치 (명세 1.2.3)
// 사진에서 뽑은 팔레트 색으로 구조물을 칠해 "그 사진들의 분위기"가 배어나게 한다.

import * as THREE from 'three';
import { pick, range } from '../utils/rng.js';
import { instantiate } from '../utils/assets.js';

function lerpColor(a, b, t) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return ca.lerp(cb, t);
}

// 트랙 중심선에서 최소 거리 확인 (코스를 침범하지 않도록)
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

// Blender 에셋 기반: 잎/외벽 머티리얼만 사진 팔레트 색으로 틴트
function makeTree(rng, palette) {
  const kind = rng() > 0.45 ? 'treeRound' : 'treePine';
  const accent = pick(rng, palette.accents);
  const leafColor = lerpColor(accent, 0x2e8b3d, 0.55).getHex();
  const tree = instantiate(kind, { Foliage: leafColor });
  tree.scale.setScalar(range(rng, 1.3, 2.4));
  return tree;
}

function makeBuilding(rng, palette) {
  const kind = rng() > 0.5 ? 'buildingA' : 'buildingB';
  const accent = pick(rng, palette.accents);
  const facadeColor = lerpColor(accent, 0x8890a8, 0.45).getHex();
  const building = instantiate(kind, { Facade: facadeColor });
  building.scale.set(range(rng, 0.7, 1.5), range(rng, 0.6, 1.8), range(rng, 0.7, 1.5));
  return building;
}

export function scatterDecorations(scene, rng, samples, palette) {
  // 지면
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1400, 48),
    new THREE.MeshLambertMaterial({ color: palette.ground })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // 거리 판정용 성긴 샘플
  const coarse = samples.filter((_, i) => i % 8 === 0).map((s) => s.pos);

  // 트랙 주변 나무/건물: 랜덤 샘플 지점에서 옆으로 밀어 배치
  const count = 130;
  for (let i = 0; i < count; i++) {
    const s = samples[Math.floor(rng() * samples.length)];
    const side = rng() > 0.5 ? 1 : -1;
    const offset = range(rng, 26, 130);
    const x = s.pos.x + s.left.x * offset * side + range(rng, -10, 10);
    const z = s.pos.z + s.left.z * offset * side + range(rng, -10, 10);
    if (minDistToTrack(x, z, coarse) < 20) continue;

    const obj = rng() > 0.65 ? makeBuilding(rng, palette) : makeTree(rng, palette);
    obj.position.x = x;
    obj.position.z = z;
    obj.rotation.y = rng() * Math.PI * 2;
    scene.add(obj);
  }

  // 원경 산맥
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
