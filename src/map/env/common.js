// 환경 장식 공용 헬퍼 — 상수·색 보간·트랙 근접 판정·리본 지오메트리·
// 캔버스 텍스처(간판·광고·빛 웅덩이)·대향차 지오메트리·인스턴싱 유틸.
// decorations(도시 오케스트레이터)·env/* 모듈들이 함께 쓴다.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const SHOULDER = 2.2;        // 도로 가장자리 → 파라펫까지 갓길 폭
export const PARAPET_HEIGHT = 1.15;
export const CONE_HEIGHT = 5.3;
export const UP = new THREE.Vector3(0, 1, 0);

export function lerpColor(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

export function minDistToTrack(x, z, coarse) {
  let min = Infinity;
  for (const p of coarse) {
    const dx = x - p.x;
    const dz = z - p.z;
    const d = dx * dx + dz * dz;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}

// 자기 도로 구간(코스 인덱스 ci±skip)을 제외한 트랙까지의 최소 거리.
// 도로변 건물은 자기 구간에서는 당연히 가깝기 때문에 minDistToTrack만으로는
// S자 커브에서 "다른 트랙 가지" 위에 떨어지는 걸 못 잡는다 — 이 함수로 걸러낸다.
export function minDistToTrackFar(x, z, coarse, ci, skip) {
  let min = Infinity;
  for (let k = 0; k < coarse.length; k++) {
    if (Math.abs(k - ci) <= skip) continue;
    const dx = x - coarse[k].x;
    const dz = z - coarse[k].z;
    const d = dx * dx + dz * dz;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}

// 트랙을 따라가는 리본 지오메트리 (개방 루트: 끝→시작 연결 없음)
// height>0: 수직 벽 / offset>0 && side!=0: 사이드 밴드 / 그 외: 중심 수평 리본
// gap: {idx, halfSpan} 또는 그 배열 — 해당 인덱스 구간의 세그먼트를 비운다(입구 등)
export function trackRibbon(samples, { offset = 0, side = 0, wHalf = 0, height = 0, yBase = 0, gap = null }) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const n = samples.length;
  let dist = 0;
  const gapList = gap ? (Array.isArray(gap) ? gap : [gap]) : [];
  const inGapSeg = (i) => gapList.some((g) => Math.abs(i - g.idx) < g.halfSpan);

  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (i > 0) dist += s.pos.distanceTo(samples[i - 1].pos);
    if (height > 0) {
      const bx = s.pos.x + s.left.x * offset * side;
      const bz = s.pos.z + s.left.z * offset * side;
      const y0 = s.pos.y + yBase;
      positions.push(bx, y0, bz, bx, y0 + height, bz);
      uvs.push(dist / 6, 0, dist / 6, 1);
    } else if (offset > 0 && side !== 0) {
      const l = s.pos.clone().addScaledVector(s.left, (offset + wHalf) * side);
      const r = s.pos.clone().addScaledVector(s.left, (offset - wHalf) * side);
      positions.push(l.x, l.y + yBase, l.z, r.x, r.y + yBase, r.z);
      uvs.push(0, dist / 10, 1, dist / 10);
    } else {
      const l = s.pos.clone().addScaledVector(s.left, wHalf);
      const r = s.pos.clone().addScaledVector(s.left, -wHalf);
      positions.push(l.x, l.y + yBase, l.z, r.x, r.y + yBase, r.z);
      uvs.push(0, dist / 10, 1, dist / 10);
    }
    if (i < n - 1 && !inGapSeg(i)) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// 가로등 빛 웅덩이 데칼 텍스처 — 가우시안처럼 완만하게 감쇠해야 원판 티가 안 남
export function lightPoolTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 2, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,232,195,0.34)');
  g.addColorStop(0.25, 'rgba(255,222,175,0.20)');
  g.addColorStop(0.55, 'rgba(255,210,155,0.08)');
  g.addColorStop(0.8, 'rgba(255,200,140,0.025)');
  g.addColorStop(1, 'rgba(255,195,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

// 볼륨 라이트 콘 셰이더 — 실루엣에서 소멸시켜 폴리곤 고깔 윤곽을 지운다
// InstancedMesh 대응: USE_INSTANCING 분기
export function makeConeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(0xffdfae) },
      uIntensity: { value: 0.38 },
      uHeight: { value: CONE_HEIGHT },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying float vH; // 0=바닥, 1=램프 헤드
      uniform float uHeight;
      void main() {
        vec4 pos = vec4(position, 1.0);
        vec3 nrm = normal;
        #ifdef USE_INSTANCING
          pos = instanceMatrix * pos;
          nrm = mat3(instanceMatrix) * nrm;
        #endif
        vNormal = normalize(normalMatrix * nrm);
        vec4 mv = modelViewMatrix * pos;
        vViewDir = normalize(-mv.xyz);
        vH = clamp(position.y / uHeight + 0.5, 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying float vH;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float edgeFade = pow(facing, 2.4);   // 실루엣 가장자리 소멸
        float vertical = pow(vH, 1.7);       // 아래로 갈수록 소멸
        gl_FragColor = vec4(uColor, edgeFade * vertical * uIntensity);
      }
    `,
  });
}

// 캔버스 텍스처 공통 헬퍼
export function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  return new THREE.CanvasTexture(cv);
}

// 네온 간판 캔버스 텍스처 (어두운 판 + 글로우 텍스트)
export function neonSignTexture(text, color) {
  return canvasTex(256, 96, (ctx) => {
    ctx.fillStyle = 'rgba(8,10,16,0.94)';
    ctx.fillRect(0, 0, 256, 96);
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, 244, 84);
    ctx.font = 'bold 42px "Malgun Gothic", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = color; ctx.shadowBlur = 16;
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 50);
  });
}

export const NEON_SIGNS = [
  ['24시 편의점', '#57e0a0'], ['노래방', '#ff5da2'], ['HOTEL', '#6fb7ff'],
  ['치킨 · 호프', '#ffb347'], ['CAFE', '#c88cff'], ['PC방', '#59d8e6'],
  ['사우나', '#ff8a5c'], ['약국', '#7dffa8'],
];

// 고속도로 문형(갠트리) 녹색 방향표지판
export function gantrySignTexture(line1, line2) {
  return canvasTex(512, 224, (ctx, w, h) => {
    ctx.fillStyle = '#0d5a2e'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#eef6ef'; ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 64px "Malgun Gothic", sans-serif';
    ctx.fillText(line1, w / 2, 74);
    ctx.font = 'bold 46px "Malgun Gothic", sans-serif';
    ctx.fillText(line2, w / 2, 158);
  });
}

// 대형 전광판용 광고 스트립: 광고 4개를 가로로 이어 붙인 와이드 캔버스.
// repeat.x=0.25 + offset 애니메이션으로 한 장씩 슬라이드된다.
export function adStripTexture() {
  const ADS = [
    ['NIGHT DRIVE', '#101826', '#6fb7ff'],
    ['별빛 극장', '#1a0f22', '#ff5da2'],
    ['NEON OIL', '#101c14', '#57e0a0'],
    ['한강 크루즈', '#1c1410', '#ffb347'],
  ];
  return canvasTex(2048, 216, (ctx, w, h) => {
    ADS.forEach(([text, bg, fg], i) => {
      const x0 = i * 512;
      ctx.fillStyle = bg; ctx.fillRect(x0, 0, 512, h);
      ctx.strokeStyle = fg; ctx.lineWidth = 6; ctx.strokeRect(x0 + 8, 8, 496, h - 16);
      ctx.font = 'bold 84px "Malgun Gothic", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = fg; ctx.shadowBlur = 26;
      ctx.fillStyle = fg;
      ctx.fillText(text, x0 + 256, h / 2 + 4);
    });
  });
}

// 장식 차량 지오메트리(차체+캐빈 / 전조·후미등 쌍) — 강변도로·본선 대향 차로 공용
export function mkCarGeo() {
  const g1 = new THREE.BoxGeometry(1.72, 0.62, 4.3); g1.translate(0, 0.62, 0);
  const g2 = new THREE.BoxGeometry(1.5, 0.5, 2.1); g2.translate(0, 1.12, -0.25);
  return mergeGeometries([g1, g2]);
}
export function mkPairGeo(r, y, z) {
  const a = new THREE.SphereGeometry(r, 6, 5); a.translate(-0.55, y, z);
  const b = new THREE.SphereGeometry(r, 6, 5); b.translate(0.55, y, z);
  return mergeGeometries([a, b]);
}
export const GHOST_CAR_TONES = [0x2e3138, 0x3a3f4a, 0x23262e, 0x424855, 0x555b66, 0x2b2f3d];

export function composeMatrix(pos, yaw, scale = new THREE.Vector3(1, 1, 1)) {
  return new THREE.Matrix4().compose(
    pos,
    new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    scale
  );
}

export function addInstanced(scene, geometry, material, matrices, { colors = null, castShadow = false } = {}) {
  const im = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((m, i) => {
    im.setMatrixAt(i, m);
    if (colors) im.setColorAt(i, colors[i]);
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = castShadow;
  im.frustumCulled = false; // 트랙 전체에 퍼져 있어 컬링 이득이 없음
  scene.add(im);
  return im;
}

// 절차적 창문 외벽 머티리얼: object 공간 좌표로 창 격자를 계산해
// 스케일·회전에 뭉개지지 않는 깔끔한 창문. 창마다 랜덤 점등(따뜻/차가운 빛)되고
// 켜진 창은 발광(bloom)한다. instanceColor로 외벽 색을, aSeed로 창 패턴을 개별화.
