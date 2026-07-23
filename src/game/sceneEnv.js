// 씬 환경(하늘·조명·환경맵) — 시간대(밤/노을) 무드의 소유자.
// 야간: 은은한 도시광(헤미) + 달빛(방향광) / 노을: 낮은 주황 태양 + 보랏빛 헤미.
// 반환 follow()는 매 프레임 태양(그림자 카메라)을 차에, 하늘 돔을 카메라에 붙인다.

import * as THREE from 'three';
import { makeStars, makeMoon, makeSkyLife, makeSky, makeDuskSun, makeDuskClouds } from './sky.js';

// quality: { shadow } — 그림자맵 해상도
export function buildSkyAndLights(scene, renderer, palette, rng, quality) {
  const dusk = palette.tod === 'dusk';
  const hemi = dusk
    ? new THREE.HemisphereLight(0x9a7fb8, 0x3a2a22, 0.5)
    : new THREE.HemisphereLight(palette.skyHorizon, 0x0a0c16, 0.32);
  const sun = dusk
    ? new THREE.DirectionalLight(palette.sunColor, 1.3)
    : new THREE.DirectionalLight(0xaabdf5, 0.7);
  // 노을 태양은 서쪽(목적지 방향 = -X) 지평선에 낮게 — 석양을 향해 달린다
  const sunDir = dusk
    ? new THREE.Vector3(-0.86, 0.16, 0.28).normalize()
    : new THREE.Vector3(0.5, 0.72, 0.34).normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadow, quality.shadow);
  sun.shadow.camera.left = -95;
  sun.shadow.camera.right = 95;
  sun.shadow.camera.top = 95;
  sun.shadow.camera.bottom = -95;
  sun.shadow.camera.near = 30;
  sun.shadow.camera.far = 600;
  sun.shadow.camera.updateProjectionMatrix(); // 속성 변경 후 필수
  sun.shadow.bias = -0.0006;
  scene.add(hemi, sun, sun.target);

  // 밤하늘: 돔 + 별 필드 + 달을 한 그룹으로 묶어 카메라를 따라가게 한다
  // (무한히 먼 것처럼 보이게 해 시차로 흔들리지 않도록. 달은 달빛 방향과 일치)
  const skyDome = new THREE.Group();
  skyDome.add(makeSky(palette, 4200, sunDir));
  if (dusk) {
    // 노을: 태양 원반 + 낮은 구름 띠 + 초저녁 별 몇 개
    const dimStars = makeStars(220);
    dimStars.material.opacity = 0.4;
    dimStars.material.transparent = true;
    skyDome.add(dimStars);
    skyDome.add(makeDuskSun(sunDir));
    skyDome.add(makeDuskClouds(rng, sunDir));
  } else {
    skyDome.add(makeStars());
    skyDome.add(makeMoon(sunDir));
  }
  const skyLife = makeSkyLife(); // 비행기 점멸등 + 유성
  skyDome.add(skyLife.group);
  scene.add(skyDome);

  // 하늘을 환경맵으로 구워 젖은 노면·차체에 은은한 시트(sheen) 반사
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(makeSky(palette, 50, sunDir));
  scene.environment = pmrem.fromScene(envScene, 0.05, 0.1, 100).texture;
  // 노을 환경맵은 밝아서 젖은 노면이 통째로 주황으로 타오른다 — 세게 낮춘다
  scene.environmentIntensity = dusk ? 0.3 : 0.35;
  pmrem.dispose();

  return {
    sunDir,
    skyLife,
    // 태양(그림자 카메라)이 차량을 따라다니며 주변에만 고해상도 그림자를 드리우고,
    // 하늘 돔(별·달)은 카메라를 따라가 무한히 먼 것처럼 보이게 (시차 제거)
    follow(carPos, cameraPos) {
      sun.position.copy(carPos).addScaledVector(sunDir, 280);
      sun.target.position.copy(carPos);
      sun.target.updateMatrixWorld();
      skyDome.position.copy(cameraPos);
    },
  };
}
