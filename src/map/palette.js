// 야간 도심 팔레트 생성기 (사진 대신 시드 난수로 무드 결정)
// 매 판 색조(네온 강조색)가 조금씩 달라져 같은 트랙도 다른 분위기가 된다.

import * as THREE from 'three';
import { range } from '../utils/rng.js';

const NEON_HUES = [0.58, 0.62, 0.72, 0.83, 0.95, 0.08, 0.13]; // 청록·파랑·보라·핑크·주황

function hsl(h, s, l) {
  return new THREE.Color().setHSL(h, s, l).getHex();
}

function makeAccents(rng) {
  const accents = [];
  for (let i = 0; i < 5; i++) {
    const hue = NEON_HUES[Math.floor(rng() * NEON_HUES.length)];
    accents.push(hsl(hue, range(rng, 0.55, 0.85), range(rng, 0.5, 0.62)));
  }
  return accents;
}

export function nightCityPalette(rng) {
  // 하늘 지평선의 미묘한 색조 (도시 광공해 느낌: 남색~보라~암청)
  const baseHue = range(rng, 0.58, 0.72);

  return {
    skyTop: 0x02030a,
    skyHorizon: hsl(baseHue, range(rng, 0.35, 0.5), range(rng, 0.09, 0.14)),
    fog: hsl(baseHue, 0.4, 0.07),
    ground: 0x05060c,
    accents: makeAccents(rng),
    isNight: true,
    tod: 'night',
  };
}

// 노을(해질녘) 팔레트: 도시 불빛이 막 켜지기 시작한 시간.
// 하늘은 서쪽(목적지 방향) 지평선이 주황으로 달궈지고 위로 갈수록 남보라.
export function duskCityPalette(rng) {
  const warmHue = range(rng, 0.02, 0.07);   // 주황~살구
  const upperHue = range(rng, 0.7, 0.78);   // 남보라

  return {
    skyTop: hsl(upperHue, 0.45, 0.13),
    skyHorizon: hsl(warmHue, 0.72, 0.34),
    // 태양 방위 지평선 글로우 (makeSky 셰이더에서 사용)
    sunGlow: hsl(range(rng, 0.04, 0.08), 0.95, 0.55),
    fog: hsl(range(rng, 0.8, 0.88), 0.22, 0.13), // 모브(연보라) 헤이즈
    ground: 0x0c0a12,
    sunColor: 0xffa055,
    accents: makeAccents(rng),
    isNight: false,
    tod: 'dusk',
  };
}
