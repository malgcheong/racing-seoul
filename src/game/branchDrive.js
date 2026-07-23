// 플레이어 도로 구속 + 분기(올림픽대로 램프) 주행 상태기계.
// 매 프레임(물리 스텝 후) step()이: 본선 최근접 샘플 갱신 → 분기 진출 창/전환 판정 →
// 도로 폭 클램프(+긁힘 콜백) → 분기 위에선 고도 추종·복귀·종점 완주 판정까지 처리한다.
// 분기 루트는 기본 '폐쇄'(사용자 결정 2026-07-16) — ?branch=open 으로 개발 중 임시 개방.

import * as THREE from 'three';
import { clampToRoad } from './physics.js';
import { nearestSample3D, nearestSampleXZ } from '../utils/trackMath.js';

export class BranchDriver {
  // branch: generateBranchRoute 결과(null 가능) / opts: { segLen, laneMin, laneMax,
  //   edgeLat(본선 가장자리 lat — 이 실선을 넘어야 분기 진입), closed, onScrape() }
  constructor(branch, samples, opts) {
    this.branch = branch;
    this.samples = samples;
    this.segLen = opts.segLen;
    this.laneMin = opts.laneMin;
    this.laneMax = opts.laneMax;
    this.edgeLat = opts.edgeLat;
    this.closed = opts.closed;
    this.onScrape = opts.onScrape || (() => {});
    this.onBranch = false;
    this.idx = 0; // 분기 샘플 인덱스
    // 진출차로(접근부) 길이를 샘플 수로 — 진출 창 판정 기준
    this.winN = branch ? Math.round(branch.approachLen / opts.segLen) + 3 : 0;
    this._notice1 = false;
    this._notice2 = false;
  }

  // 개발·검증(?branch=N): 분기 위에서 시작
  forceOn(idx) {
    this.onBranch = true;
    this.idx = idx;
  }

  // 반환: { mainIdx(본선 최근접 — 복귀 시 갱신), finished(분기 종점 완주) }
  step(car, mainIdx, dt) {
    let finished = false;
    if (!this.onBranch) {
      mainIdx = nearestSample3D(this.samples, mainIdx, 40, car.group.position).idx;
      let maxRight = this.laneMax;
      // 분기 진출 창: 진출차로가 열린 만큼만 우측을 열고, 차가 본선 가장자리
      // 실선을 실제로 넘어 차선에 올라타면 분기 모드로 전환(실도로 진출 방식).
      // 폐쇄 시엔 이 블록을 건너뛰어 우측이 안 열림 → 본선 갓길에서 막힌다.
      if (this.branch && !this.closed) {
        const bofs = mainIdx - this.branch.exitIdx;
        if (bofs > -this.winN && bofs < Math.round(70 / this.segLen)) {
          // 테이퍼 진행에 비례해 우측 한계 확장, 고어 뒤엔 완전 개방
          const dApp = (bofs + this.winN - 3) * this.segLen;
          const laneW = Math.min(this.branch.laneW,
            (this.branch.laneW * Math.max(0.1, dApp)) / this.branch.taperLen);
          maxRight = Math.max(maxRight,
            bofs > 0 ? 30 : this.edgeLat + Math.max(laneW - 1.2, 0.3));
          const bres = nearestSampleXZ(this.branch.samples, this.idx, 90, car.body.position);
          this.idx = bres.idx;
          const ms = this.samples[mainIdx];
          const px = car.body.position.x, pz = car.body.position.z;
          const mDist = Math.hypot(px - ms.pos.x, pz - ms.pos.z);
          const lat = (px - ms.pos.x) * ms.left.x + (pz - ms.pos.z) * ms.left.z;
          if (bres.idx > 4 && lat > this.edgeLat - 0.6 && bres.dist < mDist - 0.6) {
            this.onBranch = true;
          }
        } else {
          this.idx = 0; // 진출 창 밖 — 다음 접근을 위해 리셋
        }
      }
      if (!this.onBranch) {
        // 벽 밀착 감지(클램프 한계 초과) → 가드레일/분리대 긁힘 효과음
        const csm = this.samples[mainIdx];
        const latC = (car.body.position.x - csm.pos.x) * csm.left.x
          + (car.body.position.z - csm.pos.z) * csm.left.z;
        if ((latC > maxRight + 0.05 || latC < this.laneMin - 0.05) && Math.abs(car.speed) > 4) {
          this.onScrape();
        }
        // 좌측 한계는 중앙분리대(왕복 도로) — 대향 차로로 못 넘어간다
        clampToRoad(car.body, this.samples[mainIdx], this.laneMin, maxRight);
      }
    }
    if (this.onBranch) {
      // 분기 주행: 분기 샘플 기준 클램프 + 고도 추종(물리는 XZ 평면이라 y는 수동)
      this.idx = nearestSampleXZ(this.branch.samples, this.idx, 60, car.body.position).idx;
      // 고어 전(진출차로 위)에선 본선 복귀 허용 — 실도로처럼 차선만 걸친 상태라
      // 왼쪽으로 되돌아가면 그대로 직진(강제 진출 방지)
      let backToMain = false;
      if (this.branch.dists[this.idx] < this.branch.approachLen - 4) {
        const mres = nearestSampleXZ(this.samples, mainIdx, 90, car.body.position);
        const ms2 = this.samples[mres.idx];
        const lat2 = (car.body.position.x - ms2.pos.x) * ms2.left.x +
                     (car.body.position.z - ms2.pos.z) * ms2.left.z;
        if (lat2 < this.edgeLat - 1.5) {
          this.onBranch = false;
          mainIdx = mres.idx;
          backToMain = true;
        }
      }
      if (!backToMain) {
        const bs = this.branch.samples[this.idx];
        // 벽 밀착 감지(분기 연석/파라펫) → 긁힘 효과음
        const latB = (car.body.position.x - bs.pos.x) * bs.left.x
          + (car.body.position.z - bs.pos.z) * bs.left.z;
        const bLo = this.branch.clampLo[this.idx];
        const bHi = this.branch.clampHi[this.idx];
        if ((latB > bHi + 0.05 || latB < bLo - 0.05) && Math.abs(car.speed) > 4) {
          this.onScrape();
        }
        // 구간별 비대칭 클램프: 진출차로/램프는 대칭, 합류 차선에선 서쪽(본선 남행
        // 차로)으로 크게 열려 언제든 도로로 건너갈 수 있다
        clampToRoad(car.body, bs, bLo, bHi);
        car.body.position.y += (bs.pos.y - car.body.position.y) * Math.min(1, 10 * dt);
        // 올림픽대로 종점 도착 = 완주 (재합류 없음 — 대체 목적지)
        if (this.idx >= this.branch.samples.length - 30) finished = true;
      }
    }
    return { mainIdx, finished };
  }

  // 진행률: 분기 주행 중엔 진출점→100%(올림픽대로 종점) 구간을 분기 진척도로 보간
  progress(mainIdx, nAll) {
    return this.onBranch && this.branch
      ? THREE.MathUtils.lerp(
          this.branch.exitIdx / nAll, 1,
          this.idx / (this.branch.samples.length - 30))
      : mainIdx / nAll;
  }

  // 분기 사전 안내: 출구 500m/150m 전 1회씩 — flash 객체 반환(없으면 null)
  notice(mainIdx) {
    if (!this.branch || this.closed || this.onBranch) return null;
    const dEx = (this.branch.exitIdx - mainIdx) * this.segLen;
    if (dEx > 0 && dEx < 160 && !this._notice2) {
      this._notice2 = true;
      return { t: 2.2, label: '출구 앞', sub: '지금 우측 차선으로 →' };
    }
    if (dEx > 0 && dEx < 500 && !this._notice1) {
      this._notice1 = true;
      return { t: 2.4, label: '올림픽대로 출구 500m', sub: '우측 진출차로 이용' };
    }
    return null;
  }
}
