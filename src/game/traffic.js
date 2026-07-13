// 일방통행 4차선 트래픽: 모든 차가 플레이어와 같은 방향으로 주행.
// - 각 차선 중심을 지키고, 가끔 인접 차선으로 변경(깜빡이 점등)
// - 앞차가 가까우면 감속(브레이크등 점등) — 차간 거리 유지
// - 강체(cannon-es)라 충돌은 엔진이 처리(서로 밀림)
// 니어미스(아슬아슬 스치기) 판정은 게임 콤보용으로 콜백 제공.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { makeCarBody } from './physics.js';
import { getAssetTemplate } from '../utils/assets.js';

const TRAFFIC_COLORS = [
  0xcfd3da, 0x9aa0ad, 0xb14a3a, 0x3a5ea8, 0xd8d8d8,
  0x556070, 0x7a8290, 0xc9a23a, 0x2e3138, 0x8a5a2a,
];

const CONTAINER_COLORS = [0x2f6db5, 0xb14a3a, 0x3f7d4e, 0xd07a2c, 0x3b8a8f, 0x8a4f9e];

// posAt() 스크래치 (할당 없는 경로 조회)
const _posAtPos = new THREE.Vector3();
const _posAtLeft = new THREE.Vector3();
const _posAtTan = new THREE.Vector3();

// ── Blender 제작 GLB 트래픽 차량 ──
// 머티리얼 이름 계약: TBody(차체 틴트), TCont(컨테이너 틴트), TTail(브레이크 —
// 차량별 클론해 emissiveIntensity 개별 제어), 노드 이름 *_BlinkL/*_BlinkR(깜빡이
// visible 토글). 앞면은 GLB에서 +Z를 향한다(Blender에서 -Y로 제작).

// 틴트 머티리얼 캐시: 같은 색은 차량끼리 공유(드로우콜엔 무관, 메모리 절약)
const _tintCache = new Map();
function tintedMat(orig, hex) {
  const key = orig.name + ':' + hex;
  if (!_tintCache.has(key)) {
    const m = orig.clone();
    m.color.set(hex);
    _tintCache.set(key, m);
  }
  return _tintCache.get(key);
}

function buildFromTemplate(tplName, tints) {
  const g = getAssetTemplate(tplName).clone(true);
  let tailMat = null;
  const blinkL = [], blinkR = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    const remap = (m) => {
      if (m.name === 'TTail') {
        if (!tailMat) tailMat = m.clone();
        return tailMat;
      }
      return tints[m.name] !== undefined ? tintedMat(m, tints[m.name]) : m;
    };
    o.material = Array.isArray(o.material) ? o.material.map(remap) : remap(o.material);
    if (o.name.includes('BlinkL')) { o.visible = false; blinkL.push(o); }
    else if (o.name.includes('BlinkR')) { o.visible = false; blinkR.push(o); }
  });
  return { group: g, tailMat, blinkL, blinkR };
}

function makeSimpleCar(rng) {
  const color = TRAFFIC_COLORS[Math.floor(rng() * TRAFFIC_COLORS.length)];
  return {
    ...buildFromTemplate('trafficSedan', { TBody: color }),
    dims: { w: 2.0, l: 4.3, mass: 1000, slow: false },
  };
}

function makeBoxTruck(rng) {
  const cab = TRAFFIC_COLORS[Math.floor(rng() * TRAFFIC_COLORS.length)];
  return {
    ...buildFromTemplate('trafficBoxTruck', { TBody: cab }),
    dims: { w: 2.2, l: 6.4, mass: 3200, slow: true },
  };
}

function makeContainerTruck(rng) {
  const cab = TRAFFIC_COLORS[Math.floor(rng() * TRAFFIC_COLORS.length)];
  const cont = CONTAINER_COLORS[Math.floor(rng() * CONTAINER_COLORS.length)];
  return {
    ...buildFromTemplate('trafficContainer', { TBody: cab, TCont: cont }),
    dims: { w: 2.4, l: 9.0, mass: 4500, slow: true },
  };
}

function makeDumpTruck(rng) {
  const cab = TRAFFIC_COLORS[Math.floor(rng() * TRAFFIC_COLORS.length)];
  return {
    ...buildFromTemplate('trafficDump', { TBody: cab }),
    dims: { w: 2.4, l: 7.0, mass: 3800, slow: true },
  };
}

export class TrafficSystem {
  constructor(scene, samples, opts = {}) {
    this.scene = scene;
    this.world = opts.world;
    this.samples = samples;
    this.n = samples.length;
    this.deckY = samples[0].pos.y;
    this.lanes = opts.laneCenters || [-8, -3, 3, 8]; // 4차선 중심(모두 같은 방향)
    this.rng = opts.rng || Math.random;
    this.debugClose = !!opts.debugClose;
    this.river = opts.river || null; // 다리 구간 정체 판정용

    // 개방 트랙(편도): 끝→시작 연결 없음. cum[i] = 샘플 i까지의 호길이.
    this.cum = new Float32Array(this.n);
    for (let i = 0; i < this.n - 1; i++) {
      this.cum[i + 1] = this.cum[i] + samples[i].pos.distanceTo(samples[i + 1].pos);
    }
    this.L = this.cum[this.n - 1];

    this.cars = [];
    const count = opts.count ?? 8;
    for (let i = 0; i < count; i++) {
      // 차종 믹스: 승용차 위주 + 탑차/컨테이너/덤프트럭
      const roll = this.rng();
      let built;
      if (roll < 0.60) built = makeSimpleCar(this.rng);
      else if (roll < 0.75) built = makeBoxTruck(this.rng);
      else if (roll < 0.88) built = makeContainerTruck(this.rng);
      else built = makeDumpTruck(this.rng);
      const wrap = new THREE.Group();
      wrap.add(built.group);
      wrap.visible = false;
      scene.add(wrap);
      const d = built.dims;
      const body = makeCarBody(this.world, { w: d.w, h: 1.0, l: d.l, mass: d.mass, pos: { x: 0, y: this.deckY, z: 0 } });
      body.__traffic = true;
      this.cars.push({
        wrap, body, tailMat: built.tailMat, blinkL: built.blinkL, blinkR: built.blinkR,
        len: d.l, slow: d.slow,
        s: 0, lane: 0, speed: 0, effSpeed: 0, laneIdx: 0, targetLane: 0,
        laneChangeTimer: 0, blinkSide: 0, blinkPhase: 0, active: false,
        signalTimer: 0, pendingIdx: 0, pendingLane: 0, // 차선변경 사전 신호
        nearActive: false, nearMin: 999,
      });
    }
  }

  arcAtIndex(idx) { return this.cum[Math.min(idx, this.n)]; }

  // 주의: 반환 벡터는 공용 스크래치 재사용(매 프레임 차량 수×3 할당 → GC 스터터 방지).
  // 다음 posAt 호출 전에 값을 소비할 것. 개방 트랙: s는 [0, L]로 클램프.
  posAt(s) {
    s = Math.max(0, Math.min(this.L - 1e-3, s));
    let lo = 0, hi = this.n - 1;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] <= s) lo = mid; else hi = mid; }
    const i = lo;
    const seg = Math.max(1e-4, this.cum[i + 1] - this.cum[i]);
    const t = (s - this.cum[i]) / seg;
    const a = this.samples[i], b = this.samples[i + 1];
    const pos = _posAtPos.copy(a.pos).lerp(b.pos, t);
    const left = _posAtLeft.copy(a.left).lerp(b.left, t).normalize();
    const tan = _posAtTan.copy(a.tangent).lerp(b.tangent, t).normalize();
    return { pos, left, tan };
  }

  spawnAhead(car, playerS) {
    // 팝인 방지: 야간 안개에 묻히는 거리(140m~)에서만 등장시킨다.
    // 개방 트랙: 목적지 부근이면 앞에 자리가 없으므로 플레이어 뒤쪽에 배치(안 보임).
    const ahead = this.debugClose ? 14 + this.rng() * 22 : 140 + this.rng() * 130;
    if (playerS + ahead < this.L - 60) {
      car.s = playerS + ahead;
    } else {
      car.s = Math.max(0, playerS - 80 - this.rng() * 120);
    }
    car.laneIdx = Math.floor(this.rng() * this.lanes.length);
    // 트럭류는 느리게(10~17), 승용차는 12~26 m/s (플레이어가 추월)
    car.speed = car.slow ? 10 + this.rng() * 7 : 12 + this.rng() * 14;

    // 종종 다른 차 옆에 나란히 스폰 — 단, 그 차가 플레이어 시야 밖(140m+)일 때만
    if (!this.debugClose && this.rng() < 0.35) {
      const buddy = this.cars.find((c) => {
        if (!c.active || c === car) return false;
        const bAhead = c.s - playerS;
        return bAhead > 140;
      });
      if (buddy) {
        car.s = Math.max(0, Math.min(this.L - 40, buddy.s + (this.rng() - 0.5) * 5));
        car.laneIdx = Math.max(0, Math.min(this.lanes.length - 1,
          buddy.laneIdx + (this.rng() < 0.5 ? -1 : 1))); // 인접 차선
        if (car.laneIdx === buddy.laneIdx) car.laneIdx = (buddy.laneIdx + 1) % this.lanes.length;
        car.speed = buddy.speed * (0.97 + this.rng() * 0.06);
      }
    }

    car.lane = this.lanes[car.laneIdx];
    car.targetLane = car.lane;
    car.effSpeed = car.speed;
    car.laneChangeTimer = 3 + this.rng() * 6;
    car.blinkSide = 0;
    car.blinkPhase = 0;
    car.signalTimer = 0;
    car.active = true;
    car.wrap.visible = true;
    car.nearActive = false;
    car.nearMin = 999;
    for (const m of car.blinkL) m.visible = false;
    for (const m of car.blinkR) m.visible = false;
    const p = this.posAt(car.s);
    const b = car.body;
    b.position.set(p.pos.x + p.left.x * car.lane, this.deckY, p.pos.z + p.left.z * car.lane);
    b.velocity.set(p.tan.x * car.speed, 0, p.tan.z * car.speed);
    b.angularVelocity.setZero();
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(p.tan.x, p.tan.z));
  }

  // 물리 스텝 전: 차선변경/깜빡이 + 차간거리(브레이크등) + 추종 힘
  control(dt, playerS, playerLat = 0, playerSpeed = 0) {
    const L = this.L;
    for (const car of this.cars) {
      if (!car.active) this.spawnAhead(car, playerS);

      // 차선 변경: 먼저 깜빡이만 켜고(사전 신호), 1~1.8초 뒤 실제로 이동 시작
      car.laneChangeTimer -= dt;
      if (car.signalTimer <= 0 && car.blinkSide === 0 && car.laneChangeTimer <= 0) {
        car.laneChangeTimer = 3 + this.rng() * 6;
        if (this.lanes.length > 1 && this.rng() < 0.5) {
          const step = this.rng() < 0.5 ? -1 : 1;
          let ni = car.laneIdx + step;
          if (ni < 0) ni = 1;
          if (ni >= this.lanes.length) ni = this.lanes.length - 2;
          if (ni !== car.laneIdx) {
            car.pendingIdx = ni;
            car.pendingLane = this.lanes[ni];
            car.blinkSide = car.pendingLane > car.lane ? 1 : -1; // +lateral 이동=1
            car.signalTimer = 1.0 + this.rng() * 0.8;            // 이 시간 뒤 이동
          }
        }
      }
      if (car.signalTimer > 0) {
        car.signalTimer -= dt;
        if (car.signalTimer <= 0) { // 신호 끝 → 실제 차선 이동 개시
          car.laneIdx = car.pendingIdx;
          car.targetLane = car.pendingLane;
        }
      }
      car.lane += (car.targetLane - car.lane) * Math.min(1, 1.6 * dt);
      // 이동 완료(신호대기 아님) 시 깜빡이 끔
      if (car.blinkSide !== 0 && car.signalTimer <= 0 && Math.abs(car.lane - car.targetLane) < 0.15) {
        car.blinkSide = 0;
      }

      // 깜빡이 점멸(약 1.4Hz). +lateral 이동=로컬 -X(blinkL), -lateral=로컬 +X(blinkR)
      car.blinkPhase += dt;
      const on = car.blinkSide !== 0 && (car.blinkPhase % 0.7) < 0.38;
      for (const m of car.blinkL) m.visible = car.blinkSide > 0 && on;
      for (const m of car.blinkR) m.visible = car.blinkSide < 0 && on;

      // 차간 거리: 같은 차선 앞차가 가까우면 감속(브레이크등)
      // 트럭류는 길어서 차 길이 절반씩을 안전거리에 반영
      let cap = car.speed;
      for (const o of this.cars) {
        if (!o.active || o === car) continue;
        const ds = o.s - car.s;                            // 앞쪽 거리(개방 트랙)
        const gap = 8.5 + (car.len + o.len) * 0.5;
        if (ds > 0 && ds < gap && Math.abs(o.lane - car.lane) < 2.4) {
          cap = Math.min(cap, o.speed * (ds < gap * 0.55 ? 0.7 : 0.92));
        }
      }
      // 플레이어도 앞차로 취급 — 충돌 1회=실패 규칙에서 뒤에서 들이받는
      // 억울한 사고가 나지 않게, 같은 차선이면 플레이어 속도까지 감속
      {
        const dsP = playerS - car.s;
        const gapP = 12 + car.len * 0.5;
        if (dsP > 0 && dsP < gapP && Math.abs(playerLat - car.lane) < 2.8) {
          cap = Math.min(cap, Math.max(0, playerSpeed) * (dsP < gapP * 0.55 ? 0.6 : 0.85));
        }
      }
      // 다리 위 정체: 교량 구간에선 흐름이 느려져 차들이 자연스레 밀집한다
      if (this.river) {
        const bx = this.posAt(car.s).pos.x;
        if (bx > this.river.x0 - 60 && bx < this.river.x1 + 60) {
          cap = Math.min(cap, car.speed * 0.62);
        }
      }
      car.effSpeed += (cap - car.effSpeed) * Math.min(1, 3 * dt); // 부드럽게 가감속
      const braking = car.effSpeed < car.speed - 1.5;
      car.tailMat.emissiveIntensity = braking ? 4.2 : 1.3;

      car.s = Math.min(this.L - 6, car.s + car.effSpeed * dt);

      const p = this.posAt(car.s);
      const b = car.body;
      const tx = p.pos.x + p.left.x * car.lane, tz = p.pos.z + p.left.z * car.lane;
      const desVx = p.tan.x * car.effSpeed + (tx - b.position.x) * 1.6;
      const desVz = p.tan.z * car.effSpeed + (tz - b.position.z) * 1.6;
      let fx = (desVx - b.velocity.x) * 8 * b.mass;
      let fz = (desVz - b.velocity.z) * 8 * b.mass;
      // 힘 상한은 질량 비례(최대 가속도 24m/s²) — 고정값이면 무거운 트럭이
      // 커브에서 원심력을 못 이기고 도로 밖으로 밀려난다.
      const fm = Math.hypot(fx, fz), fmax = 24 * b.mass;
      if (fm > fmax) { fx *= fmax / fm; fz *= fmax / fm; }
      b.force.x += fx;
      b.force.z += fz;
      const desYaw = Math.atan2(p.tan.x, p.tan.z);
      const diff = ((desYaw - Math.atan2(2 * (b.quaternion.w * b.quaternion.y), 1 - 2 * b.quaternion.y * b.quaternion.y) + Math.PI) % (2 * Math.PI)) - Math.PI;
      b.angularVelocity.y = THREE.MathUtils.lerp(b.angularVelocity.y, diff * 2.5, Math.min(1, 4 * dt));

      // 플레이어 뒤로 멀어졌거나 목적지에 다다르면 재활용(앞쪽에 재배치)
      if (car.s < playerS - 60 || car.s >= this.L - 10) this.spawnAhead(car, playerS);
    }
  }

  // 물리 스텝 후: 도로 밖 클램프 + 메시 동기화
  postStep(maxLat) {
    for (const car of this.cars) {
      if (!car.active) continue;
      const b = car.body;
      const p = this.posAt(car.s);
      // 충돌·힘부족 등으로 논리 위치(car.s)에서 너무 벗어나면 강제 복귀.
      // (클램프가 car.s 기준이라, 크게 뒤처진 차는 커브에서 잘못된 방향으로
      //  보정돼 도로 밖으로 새는 원인이 됐다)
      const tx = p.pos.x + p.left.x * car.lane, tz = p.pos.z + p.left.z * car.lane;
      if (Math.hypot(b.position.x - tx, b.position.z - tz) > 16) {
        b.position.x = tx; b.position.z = tz;
        b.velocity.set(p.tan.x * car.effSpeed, 0, p.tan.z * car.effSpeed);
        b.angularVelocity.setZero();
        b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(p.tan.x, p.tan.z));
      }
      const dxr = b.position.x - p.pos.x, dzr = b.position.z - p.pos.z;
      const lat = dxr * p.left.x + dzr * p.left.z;
      if (Math.abs(lat) > maxLat) {
        const over = lat - Math.sign(lat) * maxLat;
        b.position.x -= p.left.x * over; b.position.z -= p.left.z * over;
        // 바깥으로 향하는 속도 성분 제거 — 안 지우면 다음 프레임에 또 밀려남
        const latVel = b.velocity.x * p.left.x + b.velocity.z * p.left.z;
        if (latVel * lat > 0) {
          b.velocity.x -= p.left.x * latVel;
          b.velocity.z -= p.left.z * latVel;
        }
      }
      car.wrap.position.set(b.position.x, b.position.y, b.position.z);
      car.wrap.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
  }

  // 니어미스(칼치기 콤보용)
  collectNearMisses(playerPos, cb) {
    const NEAR = 5.0, EXIT = 6.8, COLLIDE = 2.7;
    for (const car of this.cars) {
      if (!car.active) continue;
      // 분기(강변도로)가 본선 고가 밑을 지날 때 위층 차량에 반응하지 않게 고도 차 필터
      if (Math.abs(car.wrap.position.y - playerPos.y) > 4) continue;
      const dx = car.wrap.position.x - playerPos.x;
      const dz = car.wrap.position.z - playerPos.z;
      const d = Math.hypot(dx, dz);
      if (d < NEAR) {
        car.nearActive = true;
        if (d < car.nearMin) car.nearMin = d;
      } else if (car.nearActive && d > EXIT) {
        if (car.nearMin > COLLIDE && car.nearMin < NEAR) cb(car.nearMin, 1, NEAR, COLLIDE);
        car.nearActive = false;
        car.nearMin = 999;
      }
    }
  }

  dispose() {
    for (const c of this.cars) {
      this.scene.remove(c.wrap);
      if (this.world && c.body) this.world.removeBody(c.body);
    }
    this.cars = [];
  }
}
