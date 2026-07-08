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
};

const cache = {};
let loadPromise = null;

export function loadGameAssets(onProgress) {
  if (!loadPromise) {
    const loader = new GLTFLoader();
    const names = Object.keys(FILES);
    let done = 0;
    loadPromise = Promise.all(
      names.map(async (name) => {
        const gltf = await loader.loadAsync(FILES[name]);
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
