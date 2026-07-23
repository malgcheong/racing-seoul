// 월드 조립 — 시드 트랙 + 도로/중앙분리대/출발·결승선 + 분기(램프) 시각물 +
// 발광 노면 화살표 + 도시/강/산 장식(decorations)을 씬에 추가하고,
// 게임이 쓰는 주행 파라미터(차선 한계·샘플 간격·출발 인덱스·가로등 헤드 등)를 반환한다.
// 주행 '로직'(클램프·분기 전환)은 game/branchDrive.js — 여기는 지오메트리만.

import { generateTrack, buildRoadMesh, buildMedian, buildStartLine, MEDIAN_HALF } from './trackGenerator.js';
import { generateBranchRoute, buildBranchRoad } from './branchRoad.js';
import { buildRoadArrows } from './roadArrows.js';
import { buildEnvironment } from './decorations.js';

// opts: { branchClosed } — 분기 폐쇄 여부(시각물: 폐쇄 배리어)
export function buildWorld(scene, rng, palette, { branchClosed }) {
  const dusk = palette.tod === 'dusk';

  // 트랙 (편도 루트: 출발 → 강 다리 → 목적지)
  const track = generateTrack(rng);
  const samples = track.samples;
  const nS = samples.length;
  // 우측 통행: 주행 가능한 측면 범위(중앙분리대 ~ 우측 배리어).
  // 왕복 8차선 — 플레이어·AI 트래픽은 우측 4차선, 좌측 4차선은 장식 대향 차량.
  // 차 반폭(~1.1)+여유 — 1차로 중심(lat 2.0)에 정상적으로 올라탈 수 있어야 한다
  const laneMin = MEDIAN_HALF + 1.15;              // = 1.65, 분리대 연석에 안 닿는 한계
  const laneMax = track.width / 2 - 1.2;           // 우측 갓길 직전
  const laneW = track.width / 8;                   // 차선폭 4m
  const laneCenters = [laneW * 0.5, laneW * 1.5, laneW * 2.5, laneW * 3.5]; // +2,+6,+10,+14
  // 샘플 간 평균 간격(m) — 구간 폭(미터)을 샘플 수로 환산하는 기준
  let trackLen = 0;
  for (let i = 0; i < nS - 1; i++) {
    trackLen += samples[i].pos.distanceTo(samples[i + 1].pos);
  }
  const segLen = trackLen / (nS - 1);
  // 출발선: 도로 시작 단면(끝단 정리 반경 70m)보다 안쪽 45m 지점 —
  // 뒤따라오는 카메라(차 뒤 ~11m)가 도로 밖으로 빠져나가지 않게 여유를 둔다
  const startIdx = Math.max(8, Math.round(45 / segLen));
  scene.add(buildStartLine(samples, track.width, startIdx));
  scene.add(buildStartLine(samples, track.width, nS - 10)); // 결승선
  const roadMesh = buildRoadMesh(samples, track.width);
  // 노을: 물웅덩이(roughnessMap 매끈 패치)가 밝은 하늘을 그대로 비추면 과함
  if (dusk) roadMesh.material.envMapIntensity = 0.35;
  scene.add(roadMesh);
  // 왕복 8차선: 중앙분리대(뉴저지 방호벽+LED)가 대향 차로와 주행 차로를 가른다
  scene.add(buildMedian(samples));

  // 분기 루트: 다리 직후 우측 진출 램프. 노면·비주얼은 유지하되 사용자 결정으로
  // '폐쇄'(2026-07-16) — 진입을 막고 본선 직진만 유일한 결승 경로로 둔다.
  // (?branch=open 으로 개발 중 임시 개방 가능)
  const branch = generateBranchRoute(samples, track.river, track.width);
  // 진출차로 판정용: 본선 가장자리 lat(이 선을 넘어야 분기 진입으로 본다)
  const branchEdgeLat = track.width / 2 - 0.25;
  const gaps = [];
  let branchCoarse = null;
  let branchGroup = null;
  if (branch) {
    branchGroup = buildBranchRoad(branch, samples, track.width, track.river, branchClosed);
    scene.add(branchGroup);
    // 올림픽대로 종점 = 대체 결승선 — 합류 후엔 강변도로 남행 반부만 달리므로 그 폭으로
    scene.add(buildStartLine(branch.samples, 7.2, branch.samples.length - 30));
    branchCoarse = branch.samples.filter((_, i) => i % 3 === 0).map((s) => s.pos);
    // 진출부: 진출차로(테이퍼 시작)부터 램프가 파라펫 라인을 벗어나는 지점까지만
    // 파라펫 개방 — 길게 열어두면 고어 뒤 데크 가장자리가 "벽 없는 낭떠러지"로 보인다
    gaps.push({
      side: 1, idx: branch.exitIdx - Math.round(41 / segLen),
      halfSpan: Math.round(93 / segLen), parapetSpan: Math.round(69 / segLen),
    });
  }

  // 발광 노면 화살표: 출발 직후·다리 서단 이후 주행 4개 차로 직진 유도 +
  // 분기 진출차로(테이퍼 완료~고어)엔 우측 굽음 화살표 3개
  {
    const spots = [];
    const laneLats = [0.5, 1.5, 2.5, 3.5].map((k) => laneW * k);
    const straightAt = [startIdx + Math.round(130 / segLen)];
    for (let i = 0; i < nS; i++) {
      if (samples[i].pos.x < track.river.x0 - 140) { straightAt.push(i); break; }
    }
    for (const ai of straightAt) {
      if (ai < 4 || ai > nS - 30) continue;
      for (const lat of laneLats) spots.push({ i: ai, lat, bend: 0 });
    }
    if (branch) {
      const latX = branchEdgeLat + branch.laneW / 2 - 0.2;
      for (const back of [60, 35, 12]) {
        spots.push({ i: branch.exitIdx - Math.round(back / segLen), lat: latX, bend: 1 });
      }
    }
    scene.add(buildRoadArrows(samples, spots));
  }

  // 도시/강/산 장식 (대향 차량 인스턴스 포함)
  const env = buildEnvironment(scene, rng, samples, palette, track.width,
    gaps, track.river, branchCoarse);
  // 분기 가로등 헤드도 실광원 풀에 합류 — 분기 주행 중에도 노면이 밝게 따라온다
  const lampHeads = branchGroup?.userData.lampHeads.length
    ? env.lampHeads.concat(branchGroup.userData.lampHeads)
    : env.lampHeads;

  return {
    samples,
    width: track.width,
    river: track.river,
    segLen,
    startIdx,
    laneMin,
    laneMax,
    laneCenter: (laneMin + laneMax) / 2,
    laneCenters,
    branch,
    branchEdgeLat,
    lampHeads,
    envUpdate: env.update, // 환경 애니메이션(전광판·점멸등) 훅
  };
}
