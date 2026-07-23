// 트랙 샘플 최근접 탐색 — 인접 구간만 훑는 O(1) 윈도우 탐색(개방 트랙: 클램프).
// 두 변형을 제공한다:
//  - nearestSample3D: 3D 거리(메인 트랙에서 플레이어 추적용, 기존 동작 유지)
//  - nearestSampleXZ: 수평 거리(분기는 본선과 고도가 달라 XZ로만 판정)

export function nearestSample3D(samples, guess, win, pos) {
  const n = samples.length;
  let bestIdx = guess;
  let bestDist = Infinity;
  const lo = Math.max(0, guess - win);
  const hi = Math.min(n - 1, guess + win);
  for (let i = lo; i <= hi; i++) {
    const d = pos.distanceToSquared(samples[i].pos);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dist: Math.sqrt(bestDist) };
}

export function nearestSampleXZ(samples, guess, win, pos) {
  let bi = guess, bd = Infinity;
  const lo = Math.max(0, guess - win);
  const hi = Math.min(samples.length - 1, guess + win);
  for (let i = lo; i <= hi; i++) {
    const dx = pos.x - samples[i].pos.x, dz = pos.z - samples[i].pos.z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bi = i; }
  }
  return { idx: bi, dist: Math.sqrt(bd) };
}
