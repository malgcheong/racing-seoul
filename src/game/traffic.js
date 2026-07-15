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
    this._pS = -999; // 플레이어 위치 캐시(laneBlocked용) — control에서 매 프레임 갱신
    this._pLat = 0;
    // 멀티 게스트: 방장이 시뮬한 트래픽 스냅샷을 재생만 한다(applyNet).
    // 바디는 KINEMATIC — 로컬에서 밀리지 않고 방장 좌표에 고정, 충돌 판정은 유지
    this.puppet = !!opts.puppet;
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
      body.__traffic = true; // 충돌 즉시 실패 규칙 대상(퍼펫에도 동일 적용)
      if (this.puppet) body.type = CANNON.Body.KINEMATIC;
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
    // 지정차로제 스폰: 트럭류는 3~4차로(하위), 승용차는 2~4차로 —
    // 1차로(인덱스 0, 중분대 쪽)는 추월 전용이라 순항 스폰 금지.
    // 단 ~18% 승용차는 '1차로 정속 빌런' — 추월차로를 계속 점거한다(상향등으로 쫓아낼 것)
    const maxIdx = this.lanes.length - 1;
    car.villain = !car.slow && this.rng() < 0.18;
    if (car.villain) {
      car.laneIdx = 0;
      car.speed = 13 + this.rng() * 5; // 정속(느긋) — 추월차로에서 길을 막는다
    } else {
      car.laneIdx = car.slow
        ? Math.min(maxIdx, 2) + Math.floor(this.rng() * Math.max(1, maxIdx - 1))
        : Math.min(maxIdx, 1) + Math.floor(this.rng() * Math.max(1, maxIdx));
      car.laneIdx = Math.min(maxIdx, car.laneIdx);
      // 트럭류는 느리게(10~17), 승용차는 12~26 m/s (플레이어가 추월)
      car.speed = car.slow ? 10 + this.rng() * 7 : 12 + this.rng() * 14;
    }
    car.yieldReq = 0; // 상향등 양보 요구 누적(초)
    car.escapeT = 0;  // 1차로 복귀용 임시 가속 타이머

    // 종종 다른 차 옆에 나란히 스폰 — 단, 그 차가 플레이어 시야 밖(140m+)일 때만
    if (!this.debugClose && !car.villain && this.rng() < 0.35) {
      const buddy = this.cars.find((c) => {
        if (!c.active || c === car) return false;
        const bAhead = c.s - playerS;
        return bAhead > 140;
      });
      if (buddy) {
        car.s = Math.max(0, Math.min(this.L - 40, buddy.s + (this.rng() - 0.5) * 5));
        // 인접 차선 — 지정차로 하한(트럭 3차로·승용 2차로) 준수
        const lo = Math.min(maxIdx, car.slow ? 2 : 1);
        car.laneIdx = Math.max(lo, Math.min(maxIdx,
          buddy.laneIdx + (this.rng() < 0.5 ? -1 : 1)));
        if (car.laneIdx === buddy.laneIdx) car.laneIdx = Math.min(maxIdx, buddy.laneIdx + 1);
        if (car.laneIdx === buddy.laneIdx) car.laneIdx = Math.max(lo, buddy.laneIdx - 1);
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

  // 목표 차선의 옆자리 점유 검사 — 옆에 차가 있으면(또는 그 차선으로 이동 중이거나,
  // 플레이어가 그 자리에 있으면) 차선변경 금지. 종방향 겹침은 차 길이+여유로 판정.
  laneBlocked(car, laneCenter) {
    for (const o of this.cars) {
      if (o === car || !o.active) continue;
      if (Math.abs(o.s - car.s) > (car.len + o.len) / 2 + 7) continue;
      if (Math.abs(o.lane - laneCenter) < 2.2 || Math.abs(o.targetLane - laneCenter) < 0.6) return true;
    }
    // 플레이어 차량도 장애물로 취급 — AI가 플레이어 옆구리로 파고들지 않게
    if (Math.abs(this._pS - car.s) < (car.len + 5) / 2 + 7 &&
        Math.abs(this._pLat - laneCenter) < 2.2) return true;
    return false;
  }

  // 멀티: 방장(시뮬 주체) 퇴장 시 얼어붙은 퍼펫 차량 정리 — 보이지 않게 치우고
  // 바디도 지하로 내려 보이지 않는 충돌이 남지 않게 한다
  despawnAll() {
    for (const car of this.cars) {
      car.active = false;
      car.wrap.visible = false;
      car._net = null;
      car.body.position.y = -500;
      car.body.velocity.set(0, 0, 0);
    }
  }

  // 멀티: 서버 지정 방장이 따로 있을 때(내가 늦게 입장) 시뮬 주체 양보 — 퍼펫으로 전환
  demote() {
    if (this.puppet) return;
    this.puppet = true;
    for (const car of this.cars) {
      car.body.type = CANNON.Body.KINEMATIC;
      car._net = null;
    }
  }

  // 멀티 방장 승계: 퍼펫(재생) 모드 → 실제 AI 시뮬로 승격.
  // 마지막 수신 위치에서 각 차의 논리 상태(호길이 s·차선·속도)를 복원한다
  promote() {
    if (!this.puppet) return;
    this.puppet = false;
    for (const car of this.cars) {
      const b = car.body;
      b.type = CANNON.Body.DYNAMIC;
      b.updateMassProperties();
      car._net = null;
      if (!car.active) { car.wrap.visible = false; continue; }
      // 호길이 s: 전 구간 성긴 탐색(승격 시 1회) 후 지역 정밀화
      let bi = 0, bd = Infinity;
      for (let i = 0; i < this.n; i += 4) {
        const dx = b.position.x - this.samples[i].pos.x;
        const dz = b.position.z - this.samples[i].pos.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = i; }
      }
      for (let i = Math.max(0, bi - 4); i < Math.min(this.n, bi + 5); i++) {
        const dx = b.position.x - this.samples[i].pos.x;
        const dz = b.position.z - this.samples[i].pos.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = i; }
      }
      car.s = this.cum[bi];
      const p = this.posAt(car.s);
      const lat = (b.position.x - p.pos.x) * p.left.x + (b.position.z - p.pos.z) * p.left.z;
      let li = 0, ld = Infinity;
      this.lanes.forEach((L, k) => {
        const d = Math.abs(L - lat);
        if (d < ld) { ld = d; li = k; }
      });
      car.laneIdx = li;
      car.lane = lat; // 현재 횡위치에서 지정 차선으로 자연히 수렴
      car.targetLane = this.lanes[li];
      car.speed = car.slow ? 11 + this.rng() * 5 : 14 + this.rng() * 9;
      car.effSpeed = car.speed * 0.8;
      car.laneChangeTimer = 2 + this.rng() * 5;
      car.signalTimer = 0;
      car.blinkSide = 0;
      car.villain = false; // 승계 후엔 일반 차로(상태 불명 빌런 재지정 안 함)
      car.yieldReq = 0;
      car.escapeT = 0;
      b.velocity.set(p.tan.x * car.effSpeed, 0, p.tan.z * car.effSpeed);
    }
  }

  // ── 멀티 동기화: 방장이 트래픽 상태를 직렬화(getNet) → 게스트가 재생(applyNet) ──
  getNet() {
    return this.cars.map((c) => {
      if (!c.active) return 0;
      const b = c.body;
      const yaw = Math.atan2(2 * (b.quaternion.w * b.quaternion.y), 1 - 2 * b.quaternion.y * b.quaternion.y);
      return [
        Math.round(b.position.x * 10) / 10, Math.round(b.position.y * 10) / 10,
        Math.round(b.position.z * 10) / 10, Math.round(yaw * 100) / 100,
        c.effSpeed < c.speed - 1.5 ? 1 : 0, c.blinkSide,
      ];
    });
  }

  applyNet(arr) {
    for (let i = 0; i < this.cars.length && i < arr.length; i++) {
      const car = this.cars[i];
      const s = arr[i];
      if (!s) { car.active = false; car.wrap.visible = false; car._net = null; continue; }
      car.active = true;
      car.wrap.visible = true;
      car._net = { x: s[0], y: s[1], z: s[2], yaw: s[3], brake: s[4], blink: s[5] };
    }
  }

  // 물리 스텝 전: 차선변경/깜빡이 + 차간거리(브레이크등) + 추종 힘
  control(dt, playerS, playerLat = 0, playerSpeed = 0, highBeam = false) {
    const L = this.L;
    // 퍼펫(멀티 게스트): 방장 스냅샷(~10Hz)으로 보간 이동만 — AI 로직 전부 스킵
    if (this.puppet) {
      for (const car of this.cars) {
        const n = car._net;
        if (!car.active || !n) continue;
        const b = car.body;
        const k = Math.min(1, 10 * dt);
        b.position.x += (n.x - b.position.x) * k;
        b.position.y += (n.y - b.position.y) * k;
        b.position.z += (n.z - b.position.z) * k;
        b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), n.yaw);
        car.tailMat.emissiveIntensity = n.brake ? 4.2 : 1.3;
        car.blinkPhase += dt;
        const on = n.blink !== 0 && (car.blinkPhase % 0.7) < 0.38;
        for (const m of car.blinkL) m.visible = n.blink > 0 && on;
        for (const m of car.blinkR) m.visible = n.blink < 0 && on;
      }
      return;
    }
    this._pS = playerS;      // laneBlocked에서 플레이어 위치 참조용
    this._pLat = playerLat;
    for (const car of this.cars) {
      if (!car.active) this.spawnAhead(car, playerS);

      // 상향등 양보 요구: 플레이어가 같은 차선 바로 뒤(4~55m)에서 상향등을 쏘면
      // 누적 — 0.4초 이상 받으면 옆 차선으로 비켜준다(1차로 빌런 퇴치 수단)
      const dsBeam = car.s - playerS;
      if (highBeam && dsBeam > 4 && dsBeam < 55 && Math.abs(playerLat - car.lane) < 2.6) {
        car.yieldReq = Math.min(2, (car.yieldReq || 0) + dt);
      } else {
        car.yieldReq = Math.max(0, (car.yieldReq || 0) - dt * 2);
      }

      // 차선 변경(대한민국 지정차로제 반영):
      //  · 인덱스 0(중분대 쪽) = 1차로 = 추월 전용 — 순항 시 우측 복귀 의무
      //    (단 villain은 예외 — 1차로를 계속 점거하는 정속 빌런, 상향등에만 반응)
      //  · 트럭류(slow)는 3~4차로만 순항, 추월도 3차로까지
      //  · 추월(앞차에 막힘)은 왼쪽으로만 — 우측 추월 금지
      //  · 옆자리 점유 시 금지(laneBlocked), 깜빡이 신호 후 이동은 기존과 동일
      car.laneChangeTimer -= dt;
      if (car.signalTimer <= 0 && car.blinkSide === 0 && car.laneChangeTimer <= 0
          && this.lanes.length > 1) {
        car.laneChangeTimer = 3 + this.rng() * 6;
        const maxI = this.lanes.length - 1;
        const minCruise = Math.min(maxI, car.slow ? 2 : 1); // 순항 허용 최상위(왼쪽) 인덱스
        const blockedAhead = car.effSpeed < car.speed * 0.9; // 직전 프레임 기준 앞막힘
        let ni = -1;
        let sigT = 1.0 + this.rng() * 0.8;
        if (car.yieldReq > 0.4) {
          // 상향등 받음 — 오른쪽 우선, 막혀 있으면 왼쪽으로라도 비켜준다
          const r = car.laneIdx + 1, l = car.laneIdx - 1;
          if (r <= maxI && !this.laneBlocked(car, this.lanes[r])) ni = r;
          else if (l >= 0 && !this.laneBlocked(car, this.lanes[l])) ni = l;
          sigT = 0.45 + this.rng() * 0.3;  // 빠릿하게 깜빡이 켜고 비킴
          car.laneChangeTimer = 0.8;       // 양쪽 다 막혔으면 곧 재시도
        } else if (car.laneIdx < minCruise && !car.villain) {
          // 추월차로(또는 트럭의 상위 차로)에 있음 — 복귀는 의무(무조건 오른쪽).
          // 옆이 막혔으면 잠시 가속해 자리를 만들면서 짧은 주기로 계속 재시도
          ni = car.laneIdx + 1;
          car.laneChangeTimer = 0.6 + this.rng() * 0.8;
          if (this.laneBlocked(car, this.lanes[ni])) {
            car.escapeT = 1.6; // 복귀 자리 확보용 임시 가속(아래 속도 계산에서 +18%)
            ni = -1;
          }
        } else if (blockedAhead && this.rng() < 0.75) {
          // 앞이 막힘 → 왼쪽으로 추월 (트럭은 3차로가 한계)
          const minOvertake = car.slow ? Math.min(maxI, 2) : 0;
          if (car.laneIdx - 1 >= minOvertake) ni = car.laneIdx - 1;
        } else if (car.villain && car.laneIdx > 0 && this.rng() < 0.35) {
          // 빌런: 쫓겨났어도 슬금슬금 다시 1차로로 기어들어간다
          ni = car.laneIdx - 1;
        } else if (!car.villain && this.rng() < 0.3) {
          // 한가한 차선 이동 — 순항 허용 범위 안에서만
          const cand = car.laneIdx + (this.rng() < 0.5 ? -1 : 1);
          if (cand >= minCruise && cand <= maxI) ni = cand;
        }
        if (ni >= 0 && ni !== car.laneIdx && !this.laneBlocked(car, this.lanes[ni])) {
          car.pendingIdx = ni;
          car.pendingLane = this.lanes[ni];
          car.blinkSide = car.pendingLane > car.lane ? 1 : -1; // +lateral 이동=1
          car.signalTimer = sigT;                              // 이 시간 뒤 이동
        }
      }
      if (car.signalTimer > 0) {
        car.signalTimer -= dt;
        if (car.signalTimer <= 0) { // 신호 끝 → 옆이 여전히 비었으면 실제 이동 개시
          if (this.laneBlocked(car, car.pendingLane)) {
            car.blinkSide = 0; // 신호 중 옆자리가 막힘 — 변경 취소, 깜빡이 끔
          } else {
            car.laneIdx = car.pendingIdx;
            car.targetLane = car.pendingLane;
          }
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
      // 1차로 복귀 자리 확보 중이면 임시 가속(+18%) — 앞차 안전거리는 그대로 적용
      car.escapeT = Math.max(0, (car.escapeT || 0) - dt);
      let cap = car.speed * (car.escapeT > 0 ? 1.18 : 1);
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
      // 커브 감속: 전방 곡률 기준 횡가속 한계(≈6m/s²) — 급커브에 직선 속도로
      // 진입하면 추종 힘이 원심력을 못 이겨 바깥으로 미끄러진다
      {
        const t0 = this.posAt(car.s);
        const y0 = Math.atan2(t0.tan.x, t0.tan.z);
        const t1 = this.posAt(car.s + 24); // posAt 스크래치 공유 — t0 값은 먼저 소비
        let dy = Math.atan2(t1.tan.x, t1.tan.z) - y0;
        dy = Math.abs(Math.atan2(Math.sin(dy), Math.cos(dy)));
        const kappa = dy / 24;
        if (kappa > 1e-4) cap = Math.min(cap, Math.max(8, Math.sqrt(6.0 / kappa)));
      }
      car.effSpeed += (cap - car.effSpeed) * Math.min(1, 3 * dt); // 부드럽게 가감속
      const braking = car.effSpeed < car.speed - 1.5;
      car.tailMat.emissiveIntensity = braking ? 4.2 : 1.3;

      car.s = Math.min(this.L - 6, car.s + car.effSpeed * dt);

      // 전방 조준점 추종(pure pursuit): 현재 접선이 아니라 경로 위 앞쪽 지점을
      // 향해 속도를 만든다 — 커브를 미리 조준해서 반응 지연으로 바깥으로 밀리는
      // '미끄러짐'이 사라진다. 조준 거리는 속도 비례(고속일수록 멀리 본다)
      const b = car.body;
      const look = 5 + car.effSpeed * 0.5;
      const pa = this.posAt(car.s + look);
      const ax = pa.pos.x + pa.left.x * car.lane;
      const az = pa.pos.z + pa.left.z * car.lane;
      const dx = ax - b.position.x, dz = az - b.position.z;
      const dl = Math.hypot(dx, dz) || 1;
      const desVx = (dx / dl) * car.effSpeed;
      const desVz = (dz / dl) * car.effSpeed;
      let fx = (desVx - b.velocity.x) * 8 * b.mass;
      let fz = (desVz - b.velocity.z) * 8 * b.mass;
      // 힘 상한은 질량 비례(최대 가속도 24m/s²) — 고정값이면 무거운 트럭이
      // 커브에서 원심력을 못 이기고 도로 밖으로 밀려난다.
      const fm = Math.hypot(fx, fz), fmax = 24 * b.mass;
      if (fm > fmax) { fx *= fmax / fm; fz *= fmax / fm; }
      b.force.x += fx;
      b.force.z += fz;
      // 차체 방향도 조준점을 향해 — 커브에서 살짝 안쪽을 보고, 차선변경 때
      // 자연스럽게 이동 방향으로 기운다
      const desYaw = Math.atan2(dx, dz);
      const diff = ((desYaw - Math.atan2(2 * (b.quaternion.w * b.quaternion.y), 1 - 2 * b.quaternion.y * b.quaternion.y) + Math.PI) % (2 * Math.PI)) - Math.PI;
      b.angularVelocity.y = THREE.MathUtils.lerp(b.angularVelocity.y, diff * 2.5, Math.min(1, 4 * dt));

      // 플레이어 뒤로 멀어졌거나 목적지에 다다르면 재활용(앞쪽에 재배치)
      if (car.s < playerS - 60 || car.s >= this.L - 10) this.spawnAhead(car, playerS);
    }
  }

  // 물리 스텝 후: 도로 밖 클램프 + 메시 동기화
  postStep(maxLat) {
    // 퍼펫: 좌표는 방장 권한 — 클램프 없이 메시 동기화만
    if (this.puppet) {
      for (const car of this.cars) {
        if (!car.active) continue;
        const b = car.body;
        car.wrap.position.set(b.position.x, b.position.y, b.position.z);
        car.wrap.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      }
      return;
    }
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
