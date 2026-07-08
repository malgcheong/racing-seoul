// 아케이드 차량 물리 + Blender 제작 로우폴리 차량 모델

import * as THREE from 'three';
import { instantiate } from '../utils/assets.js';

const ACCEL = 42;
const BRAKE = 70;
const MAX_SPEED = 58;          // m/s (표시상 약 200km/h)
const MAX_REVERSE = -14;
const FRICTION = 12;
const OFFROAD_FACTOR = 0.45;   // 오프로드 시 최고 속도 배율
const STEER_RATE = 2.2;

export class Car {
  constructor(color = 0xff5533) {
    // Blender 에셋(car.glb): Body + Wheel_FL/FR/RL/RR, CarPaint 머티리얼을 팔레트 색으로 틴트
    this.group = new THREE.Group();
    const model = instantiate('car', { CarPaint: color });
    this.group.add(model);
    this.wheels = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']
      .map((n) => model.getObjectByName(n))
      .filter(Boolean);
    this.speed = 0;
    this.heading = 0;
    this.boostTimer = 0;
  }

  placeAt(position, heading) {
    this.group.position.copy(position);
    this.heading = heading;
    this.speed = 0;
    this.group.rotation.set(0, heading, 0);
  }

  boost(duration = 2) {
    this.boostTimer = Math.max(this.boostTimer, duration);
  }

  update(dt, input, onRoad) {
    const boosting = this.boostTimer > 0;
    if (boosting) this.boostTimer -= dt;

    let maxSpeed = MAX_SPEED * (onRoad ? 1 : OFFROAD_FACTOR);
    let accel = ACCEL;
    if (boosting) {
      maxSpeed *= 1.45;
      accel *= 2;
    }

    if (input.forward) {
      this.speed += accel * dt;
    } else if (input.backward) {
      this.speed -= (this.speed > 0 ? BRAKE : ACCEL * 0.6) * dt;
    } else {
      // 자연 감속
      const decel = FRICTION * (onRoad ? 1 : 2.4) * dt;
      if (this.speed > 0) this.speed = Math.max(0, this.speed - decel);
      else this.speed = Math.min(0, this.speed + decel);
    }
    this.speed = Math.min(maxSpeed, Math.max(MAX_REVERSE, this.speed));

    // 속도가 있어야 조향 (저속에서 더 민감)
    const speedRatio = Math.min(1, Math.abs(this.speed) / 20);
    const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    const drift = input.drift ? 1.5 : 1;
    if (Math.abs(this.speed) > 0.3) {
      this.heading += steer * STEER_RATE * drift * speedRatio * dt * Math.sign(this.speed);
    }

    this.group.position.x += Math.sin(this.heading) * this.speed * dt;
    this.group.position.z += Math.cos(this.heading) * this.speed * dt;
    this.group.rotation.y = this.heading;

    // 시각 효과: 바퀴 회전, 코너링 시 바디 롤
    for (const w of this.wheels) w.rotation.x += this.speed * dt * 2;
    this.group.rotation.z = THREE.MathUtils.lerp(
      this.group.rotation.z,
      steer * speedRatio * 0.06,
      0.15
    );
  }

  get speedKmh() {
    return Math.abs(Math.round(this.speed * 3.6));
  }
}
