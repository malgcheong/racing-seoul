// 아케이드 차량 물리 + 로우폴리 차량 모델

import * as THREE from 'three';

const ACCEL = 42;
const BRAKE = 70;
const MAX_SPEED = 58;          // m/s (표시상 약 200km/h)
const MAX_REVERSE = -14;
const FRICTION = 12;
const OFFROAD_FACTOR = 0.45;   // 오프로드 시 최고 속도 배율
const STEER_RATE = 2.2;

export class Car {
  constructor(color = 0xff5533) {
    this.group = this.buildModel(color);
    this.speed = 0;
    this.heading = 0;
    this.boostTimer = 0;
    this.wheels = this.group.userData.wheels;
  }

  buildModel(color) {
    const group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.8, 4.4),
      new THREE.MeshLambertMaterial({ color })
    );
    body.position.y = 0.85;
    group.add(body);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.7, 2.0),
      new THREE.MeshLambertMaterial({ color: 0x1c2333 })
    );
    cabin.position.set(0, 1.55, -0.2);
    group.add(cabin);

    const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x14151c });
    const wheels = [];
    for (const [x, z] of [[-1.15, 1.4], [1.15, 1.4], [-1.15, -1.4], [1.15, -1.4]]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, 0.5, z);
      group.add(w);
      wheels.push(w);
    }

    // 헤드라이트
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c9 });
    for (const x of [-0.7, 0.7]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.1), lightMat);
      l.position.set(x, 0.9, 2.2);
      group.add(l);
    }

    group.userData.wheels = wheels;
    return group;
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
