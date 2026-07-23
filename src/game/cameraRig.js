// 카메라 리그 — 1인칭(콕핏)/3인칭(추격)/조감(개발용 ?top=) 시점과
// 속도감 연출(FOV 벌어짐), 사고 셰이크를 담당한다.

import * as THREE from 'three';

export const BASE_FOV = 68;
const MAX_SPEED_ABS = 36; // car.js MAX_SPEED와 동일 (속도감 연출 기준)

export class CameraRig {
  // topViewH: 개발·검증용 조감 높이 (?top=220 — 배치 문제 확인용), 0이면 비활성
  constructor(camera, { topViewH = 0 } = {}) {
    this.camera = camera;
    this.topViewH = topViewH;
    this.shake = 0; // 사고 임팩트 셰이크 (감쇠는 update가 처리)
  }

  addShake(v) {
    this.shake = Math.max(this.shake, v);
  }

  // car: Car 인스턴스 / fpView: 1인칭 여부 / eye: 콕핏 눈 위치(차 로컬) / snap: 즉시 이동
  update(car, { fpView, eye, snap = false } = {}) {
    const group = car.group;
    if (this.topViewH > 0) {
      this.camera.position.set(group.position.x + 1, group.position.y + this.topViewH, group.position.z);
      this.camera.lookAt(group.position);
      this.camera.updateProjectionMatrix();
      return;
    }
    let lookAt;
    if (fpView) {
      // 1인칭(운전석 뷰): 지연 없이 차에 고정 — 카메라 랙이 있으면 멀미난다.
      // 좌핸들 운전석 = 차 로컬 +X(왼쪽) 오프셋. cockpit.js의 DX와 맞춘다.
      const h = car.heading;
      const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
      const leftV = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)); // 로컬 +X
      const e = eye || { x: 0.45, y: 1.42, z: 0.55 };
      this.camera.position.copy(group.position)
        .addScaledVector(fwd, e.z)
        .addScaledVector(leftV, e.x)
        .add(new THREE.Vector3(0, e.y, 0));
      lookAt = this.camera.position.clone().addScaledVector(fwd, 40);
    } else {
      const back = new THREE.Vector3(-Math.sin(car.heading), 0, -Math.cos(car.heading));
      const target = group.position
        .clone()
        .addScaledVector(back, 11 + car.speed * 0.08)
        .add(new THREE.Vector3(0, 5.5, 0));
      if (snap) this.camera.position.copy(target);
      else this.camera.position.lerp(target, 0.08);
      lookAt = group.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    }

    // 속도감: 고속에서 시야각이 벌어진다
    const speedRatio = Math.min(1, Math.abs(car.speed) / MAX_SPEED_ABS);
    const targetFov = BASE_FOV + speedRatio * speedRatio * 9;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 0.07);
    this.camera.updateProjectionMatrix();

    // 화면 흔들림은 '내 차 충돌' 때만 (속도·부스터 셰이크 제거). 1인칭에선 미적용(사용자 피드백)
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.03);
    const shake = fpView ? 0 : this.shake;
    if (shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * shake;
    }

    this.camera.lookAt(lookAt);
  }
}
