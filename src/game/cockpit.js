// 1인칭 콕핏 (좌핸들 운전석 뷰) — Sketchfab GLB 셸 + 런타임 화면/거울.
// 변형 2종: 'sf' XJ220 인테리어(CC-BY, Gerhald) / '918' 포르쉐 918(CC-BY, 3D Cars Studio).
// 기본값: 선택 차량이 car7(918)이면 '918', 아니면 'sf'. ?cockpit=sf|918 로 강제.
// 계기판·내비는 런타임 캔버스(918은 순정 발광 계기판 사용), 거울은 후방 렌더타깃:
//   918 = 순정 거울 메시의 UV를 평면 투영으로 재계산해 RT를 거울 모양에 정확히 맞춤.
//   sf  = 하우징 면에 맞춘 오버레이 평면.
// 좌표계: 차 전방 = 로컬 +Z, 로컬 +X = 차의 왼쪽(주의!). 운전석 X=+0.45.
// 1인칭 카메라는 반환값 eye 로컬 오프셋 — game.js FP 카메라가 이를 사용한다.

import * as THREE from 'three';
import { instantiate } from '../utils/assets.js';

const MIRROR_W = 256, MIRROR_H = 128;
const DX = 0.45; // 운전석 좌측 오프셋

// 거울 메시 UV 재계산: 정점을 평균법선의 접평면에 투영해 0..1로 정규화 —
// 렌더타깃이 거울 유리 모양 그대로 채워진다 (원본 UV는 0..1 아니라 못 씀)
function remapMirrorUVs(mesh) {
  const g = mesh.geometry;
  if (g.userData.ckMirrorUV) return; // 클론 간 지오메트리 공유 — 1회만
  g.userData.ckMirrorUV = true;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < nor.count; i++) n.add(tmp.fromBufferAttribute(nor, i));
  n.normalize();
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t = new THREE.Vector3().crossVectors(up, n).normalize(); // 수평 접선
  const b = new THREE.Vector3().crossVectors(n, t);              // 수직 접선
  const us = new Float32Array(pos.count);
  const vs = new Float32Array(pos.count);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    const u = tmp.dot(t), v = tmp.dot(b);
    us[i] = u; vs[i] = v;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (us[i] - minU) / (maxU - minU || 1);
    uv[i * 2 + 1] = (vs[i] - minV) / (maxV - minV || 1);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export function buildCockpit(carModel = 'car2') {
  const group = new THREE.Group();
  group.visible = false;

  const param = new URLSearchParams(location.search).get('cockpit');
  const variant = ['sf', '918'].includes(param) ? param : (carModel === 'car7' ? '918' : 'sf');
  const is918 = variant === '918';
  const WHEEL_TILT = is918 ? -0.5 : -0.42; // 칼럼 각도(XJ220 원래 각 ≈24°)
  // 눈 위치(로컬): 918은 시트포지션이 낮은 로드스터
  const eye = is918 ? { x: DX, y: 1.02, z: 0.34 } : { x: DX, y: 1.42, z: 0.55 };

  // ── 미러 렌더타깃: 후방 카메라 1대를 거울들이 공유 ──
  const rt = new THREE.WebGLRenderTarget(MIRROR_W, MIRROR_H);
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.repeat.x = -1; // 거울 좌우 반전
  const rearCam = new THREE.PerspectiveCamera(60, MIRROR_W / MIRROR_H, 0.5, 900);
  const mirrorMat = new THREE.MeshBasicMaterial({ map: rt.texture });

  // ── GLB 셸 ──
  const model = instantiate(is918 ? 'cockpit918' : 'cockpitSf');
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    const apply = (m) => {
      if (!m?.name) return m;
      // XJ220 셸(Ck*): 야간에도 톤이 살게 자기색 발광.
      // 루프/패널 법선이 바깥(위)을 향해 실내에서 뚫려 보인다 → 양면 렌더
      // (Blender는 기본 양면이라 검증 렌더에선 안 보였던 함정)
      if (m.name.startsWith('Ck') && !m.userData.ckGlow) {
        m.emissive.copy(m.color);
        m.emissiveIntensity = 0.22;
        m.side = THREE.DoubleSide;
        m.userData.ckGlow = true; // 캐시 원본 공유 — 중복 적용 방지
      }
      // 거울 유리(두 변형 공통, sf는 유리면을 GLB에서 분리해둠) →
      // UV 재계산 후 렌더타깃 — 거울 모양에 딱 맞는 반사
      // (우측 사이드미러는 만들었다가 사용자 합의로 제거 — 좌측+룸미러만)
      if (m.name === 'Mirror' || m.name.startsWith('Mirror.')) {
        remapMirrorUVs(o);
        return mirrorMat;
      }
      // 918: 유리(alpha 0.75로 어두움) → 거의 투명하게
      if (is918 && m.name.startsWith('Glass') && !m.userData.ckGlass) {
        m.transparent = true;
        m.opacity = 0.1;
        m.depthWrite = false;
        m.userData.ckGlass = true;
      }
      // 918: 검정 카본 실내가 밤에 완전히 죽지 않게 아주 약한 발광 플로어
      if (is918 && !m.userData.ckLift && !m.emissiveMap
        && m.emissive && m.emissive.getHex() === 0) {
        m.emissive.setRGB(0.022, 0.024, 0.03);
        m.userData.ckLift = true;
      }
      return m;
    };
    o.material = Array.isArray(o.material) ? o.material.map(apply) : apply(o.material);
  });
  group.add(model);

  // 핸들: 로드 시 recenterPivot으로 허브 피벗 복원됨(assets.js).
  // 기울기(x)와 조향(z)을 오일러 XYZ 하나로 — X(기울기)·Z(스핀) 순서라 축이 맞는다.
  const wheelSpin = model.getObjectByName('WheelSpin');
  if (wheelSpin) wheelSpin.rotation.set(WHEEL_TILT, 0, 0);

  // ── 계기판/내비 캔버스: sf 전용 (918은 순정 3-다이얼+LCD가 있음) ──
  let drawCluster = () => {};
  if (!is918) {
    const cCv = document.createElement('canvas');
    cCv.width = 256; cCv.height = 96;
    const cCtx = cCv.getContext('2d');
    const clusterTex = new THREE.CanvasTexture(cCv);
    clusterTex.colorSpace = THREE.SRGBColorSpace; // 미지정 시 어두운 색이 뿌옇게 뜬다
    const gauge = (cx, cy, r, frac) => {
      cCtx.beginPath();
      cCtx.arc(cx, cy, r, 0, Math.PI * 2);
      cCtx.fillStyle = 'rgba(14,16,21,0.97)';
      cCtx.fill();
      cCtx.strokeStyle = 'rgba(215,222,235,0.55)';
      cCtx.lineWidth = 2.5;
      cCtx.stroke();
      cCtx.strokeStyle = 'rgba(215,222,235,0.5)';
      cCtx.lineWidth = 1.5;
      for (let k = 0; k <= 8; k++) {
        const a = ((135 + (270 * k) / 8) * Math.PI) / 180;
        cCtx.beginPath();
        cCtx.moveTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
        cCtx.lineTo(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94);
        cCtx.stroke();
      }
      const a = ((135 + 270 * Math.min(1, Math.max(0, frac))) * Math.PI) / 180;
      cCtx.strokeStyle = '#ff4038';
      cCtx.lineWidth = 2.5;
      cCtx.beginPath();
      cCtx.moveTo(cx, cy);
      cCtx.lineTo(cx + Math.cos(a) * r * 0.74, cy + Math.sin(a) * r * 0.74);
      cCtx.stroke();
      cCtx.fillStyle = '#e8ecf4';
      cCtx.beginPath();
      cCtx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      cCtx.fill();
    };
    drawCluster = (kmh) => {
      cCtx.clearRect(0, 0, 256, 96);
      // 배경판 없이 다이얼만 — 셸(GLB) 계기판 자리에 자연스럽게 얹힌다
      gauge(96, 48, 38, kmh / 220);                     // 속도계
      gauge(178, 48, 38, Math.min(1, kmh / 190) * 0.9); // 타코(속도 연동 연출)
      gauge(28, 48, 16, 0.62);                          // 연료
      gauge(240, 48, 16, 0.45);                         // 수온
      cCtx.fillStyle = 'rgba(200,230,255,0.85)';
      cCtx.textAlign = 'center';
      cCtx.font = 'bold 13px sans-serif';
      cCtx.fillText(String(kmh), 96, 76);
      clusterTex.needsUpdate = true;
    };
    drawCluster(0);
    const cluster = new THREE.Mesh(
      new THREE.PlaneGeometry(0.36, 0.135),
      new THREE.MeshBasicMaterial({ map: clusterTex, transparent: true })
    );
    cluster.position.set(DX, 1.19, 1.14); // XJ220 비나클 개구부 앞
    cluster.rotation.set(0.3, Math.PI, 0);
    cluster.scale.setScalar(0.88);
    group.add(cluster);

    // (거울 유리 = GLB의 SfMirrorRoom/SfGlassSide가 Mirror 재질로 UV 리맵 RT를 받고,
    //  천장 = GLB의 CkCanopy 헤드라이너가 담당 — 런타임 오버레이 불필요)
  }

  return { group, wheelSpin, rt, rearCam, drawCluster, eye };
}
