// Blender에서 제작한 GLB 에셋 로더 (public/assets/*.glb)
// instantiate()는 씬을 클론하면서 이름으로 지정한 머티리얼만 팔레트 색으로
// 틴트한다(틴트 머티리얼은 색상별로 캐시해 재사용).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FILES = {
  car: '/assets/car.glb',
  treeRound: '/assets/tree_round.glb',
  treePine: '/assets/tree_pine.glb',
  buildingA: '/assets/building_a.glb',
  buildingB: '/assets/building_b.glb',
  mountain: '/assets/mountain.glb',
};

const cache = {};
let loadPromise = null;

// 익스포트 시 오브젝트 위치가 노드가 아닌 버텍스에 구워진 경우,
// 회전 피벗이 원점이 되어버린다(바퀴가 차 주위를 공전하는 버그).
// 지오메트리를 중심만큼 당기고 노드를 그만큼 밀어 피벗을 재중심화한다.
// 캐시된 원본에 1회만 적용 — 클론들은 지오메트리를 공유하므로 중복 적용 금지.
function recenterPivot(node) {
  const box = new THREE.Box3().setFromObject(node);
  const center = box.getCenter(new THREE.Vector3());
  node.traverse((o) => {
    if (o.isMesh) o.geometry.translate(-center.x, -center.y, -center.z);
  });
  node.position.copy(center);
}

export function loadGameAssets(onProgress) {
  if (!loadPromise) {
    const loader = new GLTFLoader();
    const names = Object.keys(FILES);
    let done = 0;
    loadPromise = Promise.all(
      names.map(async (name) => {
        const gltf = await loader.loadAsync(FILES[name]);
        if (name === 'car') {
          for (const n of ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']) {
            const wheel = gltf.scene.getObjectByName(n);
            if (wheel) recenterPivot(wheel);
          }
        }
        cache[name] = gltf.scene;
        done++;
        onProgress?.(done / names.length);
      })
    );
  }
  return loadPromise;
}

const tintedMats = new Map();

function tinted(original, hex) {
  const key = `${original.name}:${hex}`;
  if (!tintedMats.has(key)) {
    const mat = original.clone();
    mat.color.set(hex);
    tintedMats.set(key, mat);
  }
  return tintedMats.get(key);
}

// 인스턴싱용: 캐시된 원본 씬을 그대로 반환 (수정 금지, 지오메트리/머티리얼 참조용)
export function getAssetTemplate(name) {
  const src = cache[name];
  if (!src) throw new Error(`에셋 미로드: ${name} (loadGameAssets 선행 필요)`);
  return src;
}

// tints: { 머티리얼이름: 0xRRGGBB }
export function instantiate(name, tints = {}) {
  const src = cache[name];
  if (!src) throw new Error(`에셋 미로드: ${name} (loadGameAssets 선행 필요)`);
  const clone = src.clone(true);
  clone.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const apply = (m) => (tints[m.name] !== undefined ? tinted(m, tints[m.name]) : m);
    o.material = Array.isArray(o.material) ? o.material.map(apply) : apply(o.material);
  });
  return clone;
}
