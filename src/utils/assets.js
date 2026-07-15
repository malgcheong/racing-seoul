// Blender에서 제작한 GLB 에셋 로더 (public/assets/*.glb)
// instantiate()는 씬을 클론하면서 이름으로 지정한 머티리얼만 팔레트 색으로
// 틴트한다(틴트 머티리얼은 색상별로 캐시해 재사용).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FILES = {
  // 플레이어 차량: 현재 918 단일(사용자 결정 2026-07-15)
  // Sketchfab "Porsche 918 Spyder 2015" by 3D Cars Studio (CC-BY) — 크레딧 표기 필요
  car7: '/assets/car7.glb',
  treeRound: '/assets/tree_round.glb',
  treePine: '/assets/tree_pine.glb',
  buildingA: '/assets/building_a.glb',
  buildingB: '/assets/building_b.glb',
  mountain: '/assets/mountain.glb',
  mountainRange: '/assets/mountain_range.glb',
  assemblyHall: '/assets/landmark_assembly.glb',
  tower63: '/assets/landmark_63.glb',
  // 트래픽 3종: 전부 Sketchfab CC-BY (크레딧 index.html) — 사용자 결정(2026-07-15)으로
  // 자체제작 트럭 3종 제외
  trafficIoniq5: '/assets/traffic_ioniq5.glb',     // "Hyundai Ioniq 5 lowpoly" by andikapratamaw
  trafficSonata: '/assets/traffic_sonata.glb',     // "2017 Hyundai Sonata Hybrid" by m3ika3D
  trafficBus: '/assets/traffic_bus.glb',           // "1998 Hyundai Aero Space" by ImperialBlue3D
  trafficBmw8: '/assets/traffic_bmw8.glb',         // "Bmw 8 car" by itsrit3sh
  // Sketchfab "Car interior" by Gerhald (CC-BY) 기반 — 크레딧 표기 필요
  cockpitSf: '/assets/cockpit_sf.glb',
  // Sketchfab "Porsche 918 Spyder 2015" 실내 추출 (CC-BY) — 크레딧 표기 필요
  cockpit918: '/assets/cockpit_918.glb',
};

const cache = {};
let loadPromise = null;

// GLB 익스포트 방식에 따라 바퀴 지오메트리가 축(axle) 위치에 그대로 구워지는
// 경우가 있다(노드 트랜스폼=0). 그러면 회전 피벗이 원점이 되어 바퀴가 차 주위를
// 공전한다. 지오메트리가 로컬 원점 중심이 아니면(=구워짐) 재중심화하고,
// 이미 노드 트랜스폼으로 축 위치가 분리돼 있으면(=중심이 원점) 그대로 둔다.
// (예전엔 무조건 재중심화해서, 정상 익스포트된 바퀴를 원점으로 몰아넣는 버그가 있었음)
// 캐시된 원본에 1회만 적용 — 클론들은 지오메트리를 공유하므로 중복 적용 금지.
function recenterPivot(node) {
  // 멀티 프리미티브(타이어+휠) 바퀴는 GLTFLoader가 Group으로 만든다 →
  // 자식 메시들의 지오메트리 바운딩박스를 합쳐 중심을 구한다(자식은 그룹 원점 공유).
  const box = new THREE.Box3();
  node.traverse((o) => {
    if (o.isMesh) {
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox);
    }
  });
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  if (c.length() > 0.05) {
    node.traverse((o) => {
      if (o.isMesh) o.geometry.translate(-c.x, -c.y, -c.z);
    });
    node.position.add(c); // 당긴 만큼 노드를 밀어 월드 위치 유지
  }
}

export function loadGameAssets(onProgress) {
  if (!loadPromise) {
    const loader = new GLTFLoader();
    const names = Object.keys(FILES);
    let done = 0;
    loadPromise = Promise.all(
      names.map(async (name) => {
        const gltf = await loader.loadAsync(FILES[name]);
        if (name.startsWith('car')) {
          for (const n of ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']) {
            const wheel = gltf.scene.getObjectByName(n);
            if (wheel) recenterPivot(wheel);
          }
        }
        if (name.startsWith('cockpit')) {
          // 콕핏 핸들: 런타임에서 조향 회전하므로 허브 피벗 복원 필요
          const w = gltf.scene.getObjectByName('WheelSpin');
          if (w) recenterPivot(w);
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
