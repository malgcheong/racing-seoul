// 추억 오브젝트 배치 (명세 3.1, 3.2)
// - 추억 게이트: 도로를 가로지르는 대형 사진 아치. 피해갈 수 없게 만들어
//   통과 순간 플래시백 연출의 트리거가 된다. 트랙 순서 = 추억 여정 순서. (최소 5개 보장)
// - 홀로그램: 반투명 사진 패널을 공중에 띄워 천천히 회전
// - 수집 아이템: 트랙 위 오브(구슬), 획득 시 점수/부스터

import * as THREE from 'three';
import { range } from '../utils/rng.js';

const textureLoader = new THREE.TextureLoader();

function photoPlane(photo, height, opts = {}) {
  const tex = textureLoader.load(photo.textureUrl);
  tex.colorSpace = THREE.SRGBColorSpace;
  const aspect = photo.width && photo.height ? photo.width / photo.height : 4 / 3;
  const geo = new THREE.PlaneGeometry(height * aspect, height);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.DoubleSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
  });
  return new THREE.Mesh(geo, mat);
}

const GATE_CLEARANCE = 6.5; // 사진 패널 하단 높이 (차량이 아래로 통과)

// 도로를 가로지르는 사진 아치 게이트
function makeGate(photo, roadWidth) {
  const group = new THREE.Group();

  // 사진 패널: 도로 폭을 덮는 크기, 세로 사진은 높이 제한에 맞춰 축소
  const aspect = photo.width && photo.height ? photo.width / photo.height : 4 / 3;
  let w = roadWidth + 6;
  let h = w / aspect;
  if (h > 13) {
    h = 13;
    w = h * aspect;
  }
  const centerY = GATE_CLEARANCE + h / 2;

  // 사진은 양면에: 접근할 때(-Z)와 지나친 뒤(+Z) 모두 좌우 반전 없이 보이도록
  // (-Z 쪽 패널은 앞면이 접근 방향을 향하게 180° 회전)
  for (const z of [-0.35, 0.35]) {
    const plane = photoPlane(photo, h);
    plane.position.set(0, centerY, z);
    if (z < 0) plane.rotation.y = Math.PI;
    group.add(plane);
  }

  // 흰 테두리(폴라로이드 느낌) 프레임 박스
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 1.6, h + 1.6, 0.5),
    new THREE.MeshLambertMaterial({ color: 0xf7f2e6 })
  );
  frame.position.y = centerY;
  group.add(frame);

  // 은은한 후광 (접근 방향, 프레임 가장자리 글로우)
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 5, h + 5),
    new THREE.MeshBasicMaterial({
      color: 0xfff3cf,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  halo.position.set(0, centerY, -0.26);
  group.add(halo);

  // 양쪽 기둥
  const pillarH = GATE_CLEARANCE + h + 0.8;
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0xe8e2d2 });
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.1, pillarH, 1.1), pillarMat);
    pillar.position.set(side * (roadWidth / 2 + 2.5), pillarH / 2, 0);
    group.add(pillar);
  }

  return group;
}

// 추억 게이트를 트랙 진행 순서대로 균등 배치. 최소 5개 보장 (명세 3.1.3)
// 사진 순서(업로드/선택 순) = 트랙에서 만나는 순서 → "추억 여정"
export function placePhotoGates(scene, photos, samples, rng, roadWidth) {
  const count = Math.max(5, Math.min(photos.length, 12));
  const gates = [];
  const n = samples.length;

  for (let i = 0; i < count; i++) {
    const photo = photos[i % photos.length];
    // (i+0.5)/count: 출발선과 겹치지 않게 반 칸 밀어서 배치
    const idx = Math.floor(((i + 0.5) / count) * n + range(rng, -n * 0.01, n * 0.01) + n) % n;
    const s = samples[idx];

    const group = makeGate(photo, roadWidth);
    group.position.copy(s.pos);
    group.lookAt(s.pos.clone().add(s.tangent));
    scene.add(group);

    gates.push({
      photo,
      group,
      sampleIdx: idx,
      order: i,
      label: photo.memo || `추억 #${(i % photos.length) + 1}`,
      flashed: false,
    });
  }
  // 진행 방향 기준 정렬 (통과 판정용)
  gates.sort((a, b) => a.sampleIdx - b.sampleIdx);
  return gates;
}

// 홀로그램: 공중에 떠서 회전하는 반투명 사진 (명세 3.1.2)
export function placeHolograms(scene, photos, samples, rng) {
  const holos = [];
  const count = Math.min(4, photos.length);
  const n = samples.length;

  for (let i = 0; i < count; i++) {
    const photo = photos[(i * 3 + 1) % photos.length];
    const idx = Math.floor(rng() * n);
    const s = samples[idx];

    const plane = photoPlane(photo, 7, { transparent: true, opacity: 0.72 });
    plane.position.copy(s.pos).setY(range(rng, 9, 13));
    plane.userData.spin = range(rng, 0.2, 0.5) * (rng() > 0.5 ? 1 : -1);
    plane.userData.baseY = plane.position.y;
    plane.userData.bobPhase = rng() * Math.PI * 2;
    scene.add(plane);
    holos.push(plane);
  }
  return holos;
}

// 수집 아이템(오브) 배치 (명세 3.3 간이 구현 — 상징물 3D 모델화는 백엔드 AI 단계)
export function placeItems(scene, samples, rng, palette) {
  const items = [];
  const count = 24;
  const n = samples.length;

  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i / count) * n + range(rng, -6, 6) + n) % n;
    const s = samples[idx];
    const lateral = range(rng, -5, 5);
    const isBoost = i % 6 === 5;

    const mesh = new THREE.Mesh(
      isBoost
        ? new THREE.OctahedronGeometry(1.1)
        : new THREE.SphereGeometry(0.8, 12, 12),
      new THREE.MeshBasicMaterial({
        color: isBoost ? 0xff8c3a : palette.accents[i % palette.accents.length],
      })
    );
    mesh.position.copy(s.pos).addScaledVector(s.left, lateral).setY(1.4);
    mesh.userData.bobPhase = rng() * Math.PI * 2;
    scene.add(mesh);

    items.push({ mesh, isBoost, collected: false, points: isBoost ? 30 : 10 });
  }
  return items;
}

// 매 프레임 애니메이션 (홀로그램 회전/부유, 아이템 부유)
export function animatePhotoObjects(holograms, items, time) {
  for (const h of holograms) {
    h.rotation.y += h.userData.spin * 0.016;
    h.position.y = h.userData.baseY + Math.sin(time * 1.2 + h.userData.bobPhase) * 0.6;
  }
  for (const it of items) {
    if (it.collected) continue;
    it.mesh.rotation.y += 0.03;
    it.mesh.position.y = 1.4 + Math.sin(time * 2 + it.mesh.userData.bobPhase) * 0.3;
  }
}
