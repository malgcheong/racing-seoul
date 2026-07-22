// AI 레이서(봇) — 싱글플레이 대결 상대. 플레이어와 같은 규칙으로 달린다:
// 같은 차량 물리(Car), 같은 도로 경계 클램프, 그리고 트래픽 차량과 유효 충돌하면
// 즉시 리타이어(플레이어 하드모드와 동일 임계). 봇 몸체엔 __traffic 플래그가 없어
// 플레이어와 봇, 봇과 봇끼리는 범퍼 카 — 밀치기는 되지만 사고 판정은 아니다.
// 조향은 트래픽과 같은 전방 조준(pure pursuit), 속도는 성향별 순항 목표에
// 커브 한계·앞차 간격 캡. 추월은 차선 단위(왼쪽 우선), 빈 차선만 진입.

import * as THREE from 'three';
import { Car } from './car.js';
import { clampToRoad } from './physics.js';

// 성향 프로필: 순항속도(m/s)·차간 계수(작을수록 바짝 붙는 에이스)
const PROFILES = [
  { name: '서아', cruise: 37.0, headway: 0.5 },
  { name: '준', cruise: 35.0, headway: 0.62 },
  { name: '도윤', cruise: 33.0, headway: 0.72 },
];

// 차 위 이름표 스프라이트 — 봇임이 한눈에 보이게 앰버 톤
function makeLabel(text) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(60, 42, 10, 0.6)';
  ctx.beginPath();
  ctx.roundRect(28, 8, 200, 48, 12);
  ctx.fill();
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd98e';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  sp.scale.set(3.4, 0.85, 1);
  sp.position.set(0, 2.4, 0);
  return sp;
}

export class BotSystem {
  // opts: { count, models[], laneMin, laneMax, laneCenters[], segLen, rng, onEvent(type, bot) }
  constructor(scene, world, samples, opts) {
    this.scene = scene;
    this.world = world;
    this.samples = samples;
    this.n = samples.length;
    this.segLen = opts.segLen;
    this.laneMin = opts.laneMin;
    this.laneMax = opts.laneMax;
    this.laneCenters = opts.laneCenters;
    this.onEvent = opts.onEvent || (() => {});
    const rng = opts.rng || Math.random;

    // 호길이 테이블(트래픽과 동일 샘플 기준) — 봇·트래픽·플레이어 간 간격 판단용
    this.cum = new Float32Array(this.n);
    for (let i = 0; i < this.n - 1; i++) {
      this.cum[i + 1] = this.cum[i] + samples[i].pos.distanceTo(samples[i + 1].pos);
    }

    this.list = [];
    for (let k = 0; k < opts.count; k++) {
      const prof = PROFILES[k % PROFILES.length];
      const car = new Car(opts.models[k % opts.models.length], world,
        { x: 0, y: samples[0].pos.y, z: 0 });
      car.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      car.group.add(makeLabel(`🤖 ${prof.name}`));
      scene.add(car.group);
      const bot = {
        car,
        name: prof.name,
        cruise: prof.cruise * (0.985 + rng() * 0.03), // 시드별 미세 편차
        headway: prof.headway,
        idx: 0, s: 0, lat: 0,
        targetLat: opts.laneCenters[0],
        laneCd: 0, stuckT: 0,
        crashed: false, finished: false, finishTime: null, progress: 0,
      };
      // 리타이어 규칙: 트래픽(__traffic)과 유효 충돌 = 사고 — 플레이어와 동일 임계(1.5)
      car.body.addEventListener('collide', (e) => {
        if (bot.crashed || bot.finished || !e.body?.__traffic) return;
        const rel = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 8;
        if (rel < 1.5) return;
        bot.crashed = true;
        this.onEvent('crash', bot);
      });
      this.list.push(bot);
    }
  }

  arcAtIndex(idx) { return this.cum[Math.max(0, Math.min(this.n - 1, idx))]; }

  // 출발 그리드 배치 — game이 슬롯 좌표를 계산해 호출
  place(bot, pos, heading, idx) {
    bot.car.placeAt(pos, heading);
    bot.idx = idx;
    bot.s = this.arcAtIndex(idx);
    const smp = this.samples[idx];
    const lat = (pos.x - smp.pos.x) * smp.left.x + (pos.z - smp.pos.z) * smp.left.z;
    bot.lat = lat;
    // 그리드 슬롯에서 가장 가까운 차선을 초기 목표로
    let best = this.laneCenters[0], bd = Infinity;
    for (const c of this.laneCenters) {
      const d = Math.abs(c - lat);
      if (d < bd) { bd = d; best = c; }
    }
    bot.targetLat = best;
  }

  // 목표 차선이 비었는지: 옆(-12m)~앞(45m) 범위에 같은 차선 밴드 점유가 없어야 진입.
  // aheadWin을 줄이면 '옆구리만 비면 진입'하는 과감한 판정이 된다(정체 탈출용)
  laneClear(bot, lat, obstacles, backWin = 12, aheadWin = 45) {
    const blocked = (s, olat) =>
      Math.abs(olat - lat) < 2.5 && s - bot.s > -backWin && s - bot.s < aheadWin;
    for (const o of obstacles) if (blocked(o.s, o.lat)) return false;
    for (const o of this.list) if (o !== bot && blocked(o.s, o.lat)) return false;
    return true;
  }

  nearestLaneIdx(lat) {
    let li = 0, ld = Infinity;
    this.laneCenters.forEach((c, k) => {
      const d = Math.abs(c - lat);
      if (d < ld) { ld = d; li = k; }
    });
    return li;
  }

  // 물리 스텝 전: 조향·구동 결정 + 힘 적용.
  // obstacles: [{s, lat, speed}] — 트래픽+플레이어(다른 봇은 내부에서 합산)
  control(dt, obstacles, raceTime) {
    for (const bot of this.list) {
      const car = bot.car;
      // 사고/완주 후: 제동해 도로 위에 선다(장애물로 남음 — 부딪혀도 사고 아님)
      if (bot.crashed || bot.finished) {
        car.update(dt, { steer: 0, throttle: 0, brake: Math.abs(car.speed) > 0.5 ? 1 : 0 });
        continue;
      }
      // 최근접 샘플(윈도우 탐색) → 호길이 s(접선 투영 보정)·횡위치
      const bp = car.body.position;
      let bi = bot.idx, bd = Infinity;
      const lo = Math.max(0, bot.idx - 40), hi = Math.min(this.n - 1, bot.idx + 40);
      for (let i = lo; i <= hi; i++) {
        const dx = bp.x - this.samples[i].pos.x, dz = bp.z - this.samples[i].pos.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = i; }
      }
      bot.idx = bi;
      const smp = this.samples[bi];
      bot.s = this.cum[bi]
        + (bp.x - smp.pos.x) * smp.tangent.x + (bp.z - smp.pos.z) * smp.tangent.z;
      bot.lat = (bp.x - smp.pos.x) * smp.left.x + (bp.z - smp.pos.z) * smp.left.z;
      bot.progress = bi / (this.n - 1);

      // 완주: 플레이어와 같은 결승 판정(끝 10샘플 전)
      if (bi >= this.n - 10) {
        bot.finished = true;
        bot.finishTime = raceTime;
        bot.progress = 1;
        this.onEvent('finish', bot);
        continue;
      }

      const speed = Math.max(0, car.speed);
      let target = bot.cruise;

      // 커브 감속: 전방 30m 곡률 → 횡가속 한계 8.5m/s² (트래픽 6.0보다 과감)
      {
        const ai = Math.min(this.n - 1, bi + Math.max(2, Math.round(30 / this.segLen)));
        const y0 = Math.atan2(smp.tangent.x, smp.tangent.z);
        const y1 = Math.atan2(this.samples[ai].tangent.x, this.samples[ai].tangent.z);
        const dy = Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0)));
        const kappa = dy / 30;
        if (kappa > 1e-4) target = Math.min(target, Math.max(10, Math.sqrt(8.5 / kappa)));
      }

      // 앞차 간격: 같은 차선 밴드의 최근접 전방 장애물까지 감속
      const headway = 10 + speed * bot.headway;
      let aheadDs = Infinity, aheadSpeed = 0;
      const consider = (s, lat, spd) => {
        const ds = s - bot.s;
        if (ds > 0.5 && ds < 70 && Math.abs(lat - bot.lat) < 2.5 && ds < aheadDs) {
          aheadDs = ds;
          aheadSpeed = spd;
        }
      };
      for (const o of obstacles) consider(o.s, o.lat, o.speed);
      for (const o of this.list) {
        if (o !== bot) consider(o.s, o.lat, Math.max(0, o.car.speed));
      }
      if (aheadDs < headway) {
        target = Math.min(target, aheadSpeed * (aheadDs < headway * 0.5 ? 0.55 : 0.9));
      }

      // 추월: 앞이 막히면(간격 < 헤드웨이×1.6) 왼쪽 우선으로 빈 차선 탐색
      bot.laneCd = Math.max(0, bot.laneCd - dt);
      if (aheadDs < headway * 1.6 && bot.laneCd <= 0) {
        const li = this.nearestLaneIdx(bot.targetLat);
        for (const ni of [li - 1, li + 1]) {
          if (ni < 0 || ni >= this.laneCenters.length) continue;
          if (this.laneClear(bot, this.laneCenters[ni], obstacles)) {
            bot.targetLat = this.laneCenters[ni];
            bot.laneCd = 1.6;
            break;
          }
        }
      }

      // 정체 탈출: 정지 장애물(사고 차·리타이어한 봇) 뒤에서 4초 이상 기어가면
      // 옆구리(±8m)만 비어도 과감히 옆 차선으로 — 사고 현장을 돌아 나간다
      bot.stuckT = speed < 3 ? bot.stuckT + dt : 0;
      if (bot.stuckT > 4 && bot.laneCd <= 0) {
        const li = this.nearestLaneIdx(bot.targetLat);
        for (const ni of [li - 1, li + 1]) {
          if (ni < 0 || ni >= this.laneCenters.length) continue;
          if (this.laneClear(bot, this.laneCenters[ni], obstacles, 8, 8)) {
            bot.targetLat = this.laneCenters[ni];
            bot.laneCd = 1.6;
            bot.stuckT = 0;
            break;
          }
        }
      }
      // 정지 장애물까지 여유가 있으면 완전 정지 대신 살살 접근(제자리 굳음 방지)
      if (aheadDs > 14 && target < 4) target = 4;
      // 차선 변경 중(횡 오차 큼)이고 목표 차선이 비었으면 최소 전진 속도 보장 —
      // 앞이 막혀 속도 0이면 조향 자체가 안 먹혀 영원히 못 빠져나가는 교착 방지
      if (Math.abs(bot.targetLat - bot.lat) > 1.2 && target < 5
          && this.laneClear(bot, bot.targetLat, obstacles, 6, 20)) {
        target = 5;
      }

      // 전방 조준(pure pursuit): 속도 비례 거리 앞 지점을 목표 차선 오프셋으로 겨냥
      const lookN = Math.max(3, Math.round((7 + speed * 0.5) / this.segLen));
      const ls = this.samples[Math.min(this.n - 1, bi + lookN)];
      const desYaw = Math.atan2(
        ls.pos.x + ls.left.x * bot.targetLat - bp.x,
        ls.pos.z + ls.left.z * bot.targetLat - bp.z);
      let diff = desYaw - car.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      car.update(dt, {
        steer: THREE.MathUtils.clamp(diff * 2.2, -1, 1),
        throttle: speed < target - 0.4 ? 1 : 0,
        brake: speed > target + 1.5 ? THREE.MathUtils.clamp((speed - target) / 7, 0, 1) : 0,
      });
    }
  }

  // 물리 스텝 후: 도로 경계 클램프(플레이어와 동일 규칙) + 메시 동기화
  postStep() {
    for (const bot of this.list) {
      clampToRoad(bot.car.body, this.samples[bot.idx], this.laneMin, this.laneMax);
      bot.car.sync();
    }
  }

  // 트래픽 AI에 넘길 위치 정보 — 사고 봇도 포함(도로 위 정지 장애물)
  racerInfo() {
    return this.list.map((b) => ({ s: b.s, lat: b.lat, speed: Math.max(0, b.car.speed) }));
  }

  anyRacing() { return this.list.some((b) => !b.crashed && !b.finished); }

  // 선두 봇의 샘플 인덱스 — 플레이어 종료 후 트래픽 시뮬 앵커용
  leadIdx() {
    let m = 0;
    for (const b of this.list) if (!b.crashed && b.idx > m) m = b.idx;
    return m;
  }

  dispose() {
    for (const b of this.list) {
      this.scene.remove(b.car.group);
      this.world.removeBody(b.car.body);
    }
    this.list = [];
  }
}
