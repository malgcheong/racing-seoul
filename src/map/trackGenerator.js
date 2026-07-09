// 동적 맵(트랙) 생성 엔진 (명세 1.2)
// 시드 난수로 폐곡선 컨트롤 포인트를 잡고 Catmull-Rom 스플라인으로
// 레이싱 트랙을 만든다. 같은 사진 세트여도 시드가 달라 매번 다른 맵이 나온다.

import * as THREE from 'three';
import { range } from '../utils/rng.js';

export const TRACK_WIDTH = 16;
export const SAMPLE_COUNT = 900;
export const DECK_HEIGHT = 14; // 고가도로 데크 높이

export function generateTrack(rng) {
  const pointCount = 10 + Math.floor(rng() * 4);
  const baseRadius = 230;
  const points = [];
  for (let i = 0; i < pointCount; i++) {
    const angle = (i / pointCount) * Math.PI * 2 + range(rng, -0.12, 0.12);
    const radius = baseRadius * range(rng, 0.55, 1.25);
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }

  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.6);

  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    const pos = curve.getPointAt(t);
    pos.y = DECK_HEIGHT; // 고가도로: 트랙 전체를 데크 높이로
    const tangent = curve.getTangentAt(t).normalize();
    // 평면 트랙: 좌측 법선은 접선을 90도 회전
    const left = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    samples.push({ pos, tangent, left });
  }

  return { curve, samples, width: TRACK_WIDTH };
}

// 아스팔트 + 중앙 점선 + 양측 흰 라인 텍스처
function createRoadTexture() {
  const canvas = document.createElement('canvas');
  const S = 512;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  // 베이스 아스팔트
  ctx.fillStyle = '#2b2d34';
  ctx.fillRect(0, 0, S, S);

  // 고운 알갱이(2톤): 밝은 자갈 + 어두운 알갱이
  for (let i = 0; i < 6000; i++) {
    const v = 55 + Math.random() * 45;
    ctx.fillStyle = `rgba(${v},${v},${v + 5},${0.12 + Math.random() * 0.18})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  for (let i = 0; i < 4000; i++) {
    const v = 18 + Math.random() * 18;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.15 + Math.random() * 0.2})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  // 큰 얼룩(보수 자국·오일)
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 30 + Math.random() * 90;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    const dark = Math.random() < 0.5;
    g.addColorStop(0, dark ? 'rgba(20,20,24,0.35)' : 'rgba(70,72,80,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.5), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 미세 크랙
  ctx.strokeStyle = 'rgba(12,12,14,0.5)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 22; i++) {
    let x = Math.random() * S, y = Math.random() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 3 + Math.floor(Math.random() * 4);
    for (let j = 0; j < segs; j++) {
      x += (Math.random() - 0.5) * 60;
      y += (Math.random() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 차선 마모 효과: 라인 위에 불규칙 지움
  const wear = (lx, lw) => {
    const scratches = 40;
    for (let i = 0; i < scratches; i++) {
      ctx.fillStyle = `rgba(43,45,52,${0.25 + Math.random() * 0.4})`;
      ctx.fillRect(lx + Math.random() * lw, Math.random() * S, 1 + Math.random() * 2, 3 + Math.random() * 8);
    }
  };
  // 양측 흰 라인 (약간 누런 마모)
  ctx.fillStyle = '#dcdcd2';
  ctx.fillRect(12, 0, 12, S);
  ctx.fillRect(S - 24, 0, 12, S);
  wear(12, 12); wear(S - 24, 12);
  // 중앙 점선(노랑, 마모)
  ctx.fillStyle = '#e8bc44';
  const cx = S / 2 - 7;
  for (let y = 0; y < S; y += 128) {
    ctx.fillRect(cx, y, 14, 74);
  }
  wear(cx, 14);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// 젖은 노면용 러프니스 맵: 어두운 얼룩 = 물웅덩이(매끈=반사↑), 밝은 부분 = 마른 아스팔트
function createRoughnessTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b4b4b4';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 16; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 26 + Math.random() * 52;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, 'rgba(28,28,28,0.9)');
    g.addColorStop(0.6, 'rgba(48,48,48,0.5)');
    g.addColorStop(1, 'rgba(90,90,90,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r * (0.7 + Math.random() * 0.6), r, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function buildRoadMesh(samples, width) {
  const half = width / 2;
  const positions = [];
  const uvs = [];
  const indices = [];
  const n = samples.length;

  let dist = 0;
  for (let i = 0; i <= n; i++) {
    const s = samples[i % n];
    if (i > 0) {
      const prev = samples[(i - 1) % n];
      dist += s.pos.distanceTo(prev.pos);
    }
    const l = s.pos.clone().addScaledVector(s.left, half);
    const r = s.pos.clone().addScaledVector(s.left, -half);
    positions.push(l.x, l.y + 0.02, l.z, r.x, r.y + 0.02, r.z);
    const v = dist / 18;
    uvs.push(0, v, 1, v);
    if (i < n) {
      const a = i * 2;
      // 위(+Y)를 향하도록 반시계 winding
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // 젖은 노면: 물웅덩이 패치는 매끈해서 가로등/헤드라이트 스페큘러가 어린다
  const mat = new THREE.MeshStandardMaterial({
    map: createRoadTexture(),
    roughnessMap: createRoughnessTexture(),
    roughness: 1.0,   // roughnessMap 값이 그대로 적용되도록
    metalness: 0.06,
    color: 0xaeb2bc,  // 젖은 아스팔트는 살짝 어둡고 차갑게
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// 출발/결승 체커 라인
export function buildStartLine(samples, width) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const cell = 16;
  for (let x = 0; x < 128 / cell; x++) {
    for (let y = 0; y < 32 / cell; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);

  const s = samples[0];
  const geo = new THREE.PlaneGeometry(width, 4);
  // 야간 눈부심 방지: 체커를 톤다운
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0x8a8a8a });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(s.pos).setY(s.pos.y + 0.05);
  // 트랙 진행 방향에 맞춰 회전
  mesh.rotation.z = Math.atan2(s.tangent.x, s.tangent.z);
  return mesh;
}
