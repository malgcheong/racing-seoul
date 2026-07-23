// 원경 산맥 — GLB 산 템플릿을 도시 외곽 링에 인스턴싱 배치.

import * as THREE from 'three';
import { range } from '../../utils/rng.js';
import { getAssetTemplate } from '../../utils/assets.js';
import { UP } from './common.js';

export function buildMountainRanges(scene, rng, center = new THREE.Vector3(), targetRadius = 1250, river = null) {
  let geo = null;
  getAssetTemplate('mountainRange').traverse((o) => { if (o.isMesh && !geo) geo = o.geometry; });
  if (!geo) return;

  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, fog: true, side: THREE.DoubleSide,
  });
  mat.color.setRGB(3.2, 3.2, 3.2);
  mat.emissive.setRGB(0.04, 0.07, 0.05);

  const mats = [];
  const N = 15; // 링을 도는 세그먼트 수 (겹치며 이어지는 능선들)
  for (let k = 0; k < N; k++) {
    const ang = (k / N) * Math.PI * 2 + range(rng, -0.08, 0.08);
    const rr = targetRadius + range(rng, -140, 160);
    const px = center.x + Math.cos(ang) * rr;
    const pz = center.z + Math.sin(ang) * rr;
    const yaw = -ang + Math.PI / 2 + range(rng, -0.2, 0.2); // 접선 방향(+X 길이축)
    const sl = range(rng, 14, 24);   // 길이 스케일 (40u → 560~960m)
    const sy = range(rng, 16, 28);   // 높이 스케일 (봉우리 ~70~125m)
    // 강 회랑 회피: 세그먼트 중심·양 끝점의 x가 회랑에 걸리면 스킵
    if (river) {
      const dx = Math.cos(yaw) * 20 * sl; // 로컬 +X(길이축 절반)의 월드 x 성분
      const lo = river.x0 - 90, hi = river.x1 + 90;
      const inCorr = (x) => x > lo && x < hi;
      if (inCorr(px) || inCorr(px + dx) || inCorr(px - dx)) continue;
    }
    mats.push(new THREE.Matrix4().compose(
      new THREE.Vector3(px, -2, pz),
      new THREE.Quaternion().setFromAxisAngle(UP, yaw),
      new THREE.Vector3(sl, sy, sl * range(rng, 0.9, 1.5))
    ));
    // 뒷열 보조 능선(멀리 겹쳐 보이는 깊이감), 확률적으로
    if (rng() < 0.5) {
      mats.push(new THREE.Matrix4().compose(
        new THREE.Vector3(
          center.x + Math.cos(ang + 0.06) * (rr + range(rng, 180, 320)), -2,
          center.z + Math.sin(ang + 0.06) * (rr + range(rng, 180, 320))),
        new THREE.Quaternion().setFromAxisAngle(UP, yaw + range(rng, -0.3, 0.3)),
        new THREE.Vector3(sl * 1.2, sy * 1.25, sl * 1.4)
      ));
    }
  }
  if (!mats.length) return;
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((m, i) => im.setMatrixAt(i, m));
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false;
  im.renderOrder = -10;
  scene.add(im);
}
