// 물리 엔진(cannon-es) 기반 차량. 평면 강체 + 아케이드 구동 모델.
// 공개 인터페이스는 기존과 동일(group, speed, heading, speedKmh, placeAt, boost, update)

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { instantiate } from '../utils/assets.js';
import { makeCarBody } from './physics.js';

// ── 튜닝 상수(브라우저에서 조작감 보고 조절) ──
const MASS = 1200;
const ENGINE = 15500;       // 구동력(N) — 0→최고속 도달이 답답하지 않게
const BRAKE = 20000;
const REVERSE = 5000;
const MAX_SPEED = 42;       // m/s
const MAX_YAW = 1.0;        // 최대 요 회전속도(rad/s) — 너무 높으면 휙휙 돎
const GRIP = 11;            // 측면 접지(클수록 안 미끄러짐)
const DRIFT_GRIP = 2.6;     // 드리프트 시 접지

const _v1 = new CANNON.Vec3();

export class Car {
  constructor(modelName = 'car7', world, startPos = { x: 0, y: 0, z: 0 }) {
    this.group = new THREE.Group();
    const model = instantiate(modelName);
    model.rotation.y = Math.PI; // 에셋 앞 보정(기존과 동일)
    this.model = model;
    this.group.add(model);
    this.wheels = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']
      .map((n) => model.getObjectByName(n))
      .filter(Boolean);
    this.body = makeCarBody(world, { w: 2.2, h: 1.0, l: 5.2, mass: MASS, pos: startPos });
    // 실사 PBR 모델(car7): metalness 1.0 재질은 어두운 야간 환경맵에서 새까맣게 죽는다
    // (금속은 환경반사가 광원의 전부) — 메탈 낮춰 실광원(헤드라이트·가로등)에 반응시키고 env 부스트.
    // 오픈탑이라 추격 카메라에 실내 가죽이 크게 보인다 — 밝은 웜톤이 튀지 않게 감쇠.
    if (modelName === 'car7') {
      model.traverse((o) => {
        if (!o.isMesh) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => {
          if (!m || !('envMapIntensity' in m)) return;
          m.envMapIntensity = 2.2;
          if (m.metalness !== undefined && m.metalness > 0.6) m.metalness = 0.55;
          if (!m.userData.p918Toned && /Leather|Fabric|Alcantara|Interior|Belt/.test(m.name || '')) {
            m.color.multiplyScalar(0.42);
            m.userData.p918Toned = true; // 캐시 원본 공유 — 중복 감쇠 방지
          }
        });
      });
    }
    this.boostTimer = 0;
    this.roll = 0;

    // 후미등: Blender에서 모델에 넣은 발광 재질(LightR*)을 찾아 사용.
    // 평소엔 은은한 러닝라이트, 감속 시 밝게. (재질은 복제해 프리뷰 등에 영향 없게)
    // car7(Sketchfab 918)은 재질명이 'tail_light.001' — 하우징(Tail_Light_Base)은 제외
    this.tailMats = [];
    this.tailBase = 1.0;
    model.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((mat, i) => {
        const nm = (mat && mat.name) || '';
        if (!mat || !(/^LightR/.test(nm) || /^tail_light(\.\d+)?$/i.test(nm))) return;
        const cl = mat.clone();
        cl.emissive = new THREE.Color(0xff1414);
        cl.emissiveIntensity = this.tailBase;
        if (Array.isArray(o.material)) o.material[i] = cl;
        else o.material = cl;
        this.tailMats.push(cl);
      });
    });

    this.sync();
  }

  // 월드 전방 단위벡터(로컬 +Z)
  forward(out = _v1) {
    out.set(0, 0, 1);
    return this.body.quaternion.vmult(out, out);
  }

  get speed() {
    const f = this.forward();
    return this.body.velocity.x * f.x + this.body.velocity.z * f.z; // 전진 성분(부호 포함)
  }
  get speedKmh() {
    return Math.abs(Math.round(this.speed * 3.6));
  }
  get heading() {
    const f = this.forward();
    return Math.atan2(f.x, f.z);
  }

  placeAt(position, heading) {
    const b = this.body;
    b.position.set(position.x, position.y, position.z);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading);
    this.sync();
  }

  boost(duration = 2) {
    this.boostTimer = Math.max(this.boostTimer, duration);
  }

  update(dt, input) {
    const b = this.body;
    const f = this.forward();
    const fx = f.x, fz = f.z; // _v1은 아래서 재사용되므로 성분을 미리 복사
    const fwd = b.velocity.x * fx + b.velocity.z * fz;

    // 구동/제동
    let drive = 0;
    if (input.forward) drive = ENGINE;
    else if (input.backward) drive = fwd > 0.5 ? -BRAKE : -REVERSE;
    const boosting = this.boostTimer > 0;
    if (boosting) { drive *= 1.6; this.boostTimer -= dt; }
    if (fwd > (boosting ? MAX_SPEED * 1.4 : MAX_SPEED) && drive > 0) drive = 0;
    // 무게중심에 순수 선형력(토크 X). applyForce의 상대점 인자 오용 금지.
    b.force.x += fx * drive;
    b.force.z += fz * drive;

    // 조향: 속도 있을 때 요 회전속도를 목표치로 부드럽게.
    // 고속일수록 민감도를 낮춰(10m/s 초과분 비례 감쇠) 살짝만 눌러도 휙 도는 느낌 제거.
    const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    const speedFactor = Math.min(1, Math.abs(fwd) / 7);
    const highDamp = 1 / (1 + Math.max(0, Math.abs(fwd) - 10) * 0.03);
    const targetYaw = steer * MAX_YAW * speedFactor * highDamp * (fwd < -0.5 ? -1 : 1) * (input.drift ? 1.35 : 1);
    b.angularVelocity.y = THREE.MathUtils.lerp(b.angularVelocity.y, targetYaw, Math.min(1, 6 * dt));

    // 측면 접지(그립): 옆으로 미끄러지는 속도를 제거 → 드리프트 시 약하게
    const rx = fz, rz = -fx; // 오른쪽 벡터(수평)
    const lat = b.velocity.x * rx + b.velocity.z * rz;
    const k = input.drift ? DRIFT_GRIP : GRIP;
    const frac = Math.min(1, k * dt);
    b.velocity.x -= rx * lat * frac;
    b.velocity.z -= rz * lat * frac;

    // 폭주 방지: 총 속도 상한
    const sp = Math.hypot(b.velocity.x, b.velocity.z);
    const cap = boosting ? 70 : 58;
    if (sp > cap) { b.velocity.x *= cap / sp; b.velocity.z *= cap / sp; }

    // 후미등: 브레이크(↓/S)로 감속하거나, 스로틀 뗀 채 달려 감속 중일 때 밝게
    const braking = (input.backward && fwd > 0.3) || (!input.forward && !boosting && fwd > 5);
    const ti = braking ? this.tailBase * 3.5 : this.tailBase;
    for (const m of this.tailMats) m.emissiveIntensity = ti;

    // 시각 효과
    const spin = THREE.MathUtils.clamp(fwd * 2, -9, 9);
    for (const w of this.wheels) w.rotateX(spin * dt);
    this.roll = THREE.MathUtils.lerp(this.roll, -steer * speedFactor * 0.06, 0.15);
    this.model.rotation.z = this.roll;
  }

  // 물리 바디 → 메시 동기화
  sync() {
    const p = this.body.position;
    this.group.position.set(p.x, p.y, p.z);
    const q = this.body.quaternion;
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.model.rotation.z = this.roll; // yaw는 그룹, roll은 모델
  }
}
