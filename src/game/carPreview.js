// 차량 선택 화면용 회전 3D 프리뷰 (쇼룸 스튜디오 조명)
// 각 카드마다 경량 씬 하나 — dispose로 컨텍스트 정리.

import * as THREE from 'three';
import { instantiate } from '../utils/assets.js';

export function createCarPreview(canvas, modelName) {
  const w = canvas.clientWidth || 400;
  const h = canvas.clientHeight || 250;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 100);

  // 스튜디오 조명: 키 + 필 + 하부 반사광 + 헤미
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(5, 7, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 1.1);
  fill.position.set(-6, 3, -3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffd9a0, 1.6);
  rim.position.set(-2, 4, -7);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x0a0c16, 0.9));

  // 차량
  const model = instantiate(modelName);
  const pivot = new THREE.Group();
  pivot.add(model);
  scene.add(pivot);

  // 모델 중심/크기에 맞춰 카메라 프레이밍
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(center); // 피벗 원점 = 차량 중심
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 180 / 2) * 1.15;
  const camY = size.y * 0.55;
  camera.position.set(dist * 0.62, camY + dist * 0.32, dist * 0.72);
  camera.lookAt(0, 0, 0);

  let raf = null;
  let angle = Math.PI * 0.15;
  let last = performance.now();
  let active = true;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (active) angle += dt * 0.6;
    pivot.rotation.y = angle;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setSpin(on) {
      active = on;
    },
    resize() {
      const nw = canvas.clientWidth || w;
      const nh = canvas.clientHeight || h;
      renderer.setSize(nw, nh, false);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      scene.traverse((o) => {
        if (o.isMesh) o.geometry?.dispose();
      });
      renderer.dispose();
    },
  };
}
