// 추억 오브젝트 배치 (명세 3.1, 3.2)
// - 사진 액자: 트랙을 따라 균등 간격으로 도로 옆에 세워 시각적으로 노출 (최소 5개 보장)
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

// 액자 프레임 + 사진 + 받침 기둥
function makeFrame(photo) {
  const group = new THREE.Group();
  const photoH = 6.5;
  const plane = photoPlane(photo, photoH);
  const w = plane.geometry.parameters.width;

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.8, photoH + 0.8, 0.4),
    new THREE.MeshLambertMaterial({ color: 0xf5efe0 })
  );
  frame.position.y = photoH / 2 + 4;
  plane.position.set(0, photoH / 2 + 4, 0.25);
  group.add(frame, plane);

  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.5, 4, 8),
    new THREE.MeshLambertMaterial({ color: 0x8a8fa8 })
  );
  pillar.position.y = 2;
  group.add(pillar);

  // 은은한 스포트 느낌의 발광 링
  const glow = new THREE.Mesh(
    new THREE.RingGeometry(1.4, 2.2, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  group.add(glow);

  return group;
}

// 사진 액자들을 트랙을 따라 균등 배치. 최소 5개 보장 (명세 3.1.3)
export function placePhotoFrames(scene, photos, samples, rng) {
  const count = Math.max(5, Math.min(photos.length, 14));
  const frames = [];
  const n = samples.length;

  for (let i = 0; i < count; i++) {
    const photo = photos[i % photos.length];
    const idx = Math.floor((i / count) * n + range(rng, -n * 0.02, n * 0.02) + n) % n;
    const s = samples[idx];
    const side = i % 2 === 0 ? 1 : -1;
    const offset = range(rng, 13, 18);

    const group = makeFrame(photo);
    group.position.copy(s.pos).addScaledVector(s.left, offset * side);
    group.lookAt(s.pos.x, group.position.y, s.pos.z);
    scene.add(group);

    frames.push({
      photo,
      group,
      position: group.position.clone(),
      sampleIdx: idx,
      label: photo.memo || `추억 #${(i % photos.length) + 1}`,
      visited: false,
    });
  }
  return frames;
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
