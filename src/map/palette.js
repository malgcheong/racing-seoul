// 야간 도심 팔레트 생성기 (사진 대신 시드 난수로 무드 결정)
// 매 판 색조(네온 강조색)가 조금씩 달라져 같은 트랙도 다른 분위기가 된다.

import * as THREE from 'three';
import { range } from '../utils/rng.js';

const NEON_HUES = [0.58, 0.62, 0.72, 0.83, 0.95, 0.08, 0.13]; // 청록·파랑·보라·핑크·주황

function hsl(h, s, l) {
  return new THREE.Color().setHSL(h, s, l).getHex();
}

export function nightCityPalette(rng) {
  // 하늘 지평선의 미묘한 색조 (도시 광공해 느낌: 남색~보라~암청)
  const baseHue = range(rng, 0.58, 0.72);

  const accents = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const hue = NEON_HUES[Math.floor(rng() * NEON_HUES.length)];
    accents.push(hsl(hue, range(rng, 0.55, 0.85), range(rng, 0.5, 0.62)));
  }

  return {
    skyTop: 0x02030a,
    skyHorizon: hsl(baseHue, range(rng, 0.35, 0.5), range(rng, 0.09, 0.14)),
    fog: hsl(baseHue, 0.4, 0.07),
    ground: 0x05060c,
    accents,
    isNight: true,
  };
}
