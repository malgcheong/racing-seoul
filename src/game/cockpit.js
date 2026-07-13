// 1인칭 콕핏 (좌핸들 운전석 뷰) — Blender 제작 GLB 셸 + 런타임 화면/거울.
// 셸(대시·비나클·핸들·필러·루프·도어·미러 하우징)은 cockpit.glb,
// 화면류는 UV/flipY 함정을 피해 런타임 THREE 평면으로 얹는다:
//   계기판(속도 바늘 캔버스) / 내비(정적 캔버스) / 사이드·룸미러(후방 렌더타깃).
// 좌표계: 차 전방 = 로컬 +Z, 로컬 +X = 차의 왼쪽(주의!). 운전석 X=+0.45.
// 1인칭 카메라는 로컬 (0.45, 1.42, 0.55) — 게임 카메라(game.js FP)와 일치해야 함.

import * as THREE from 'three';
import { instantiate } from '../utils/assets.js';

const MIRROR_W = 256, MIRROR_H = 128;
const DX = 0.45;          // 운전석 좌측 오프셋
const WHEEL_TILT = -0.5;  // 스티어링 칼럼 기울기(상단이 운전자 쪽)

export function buildCockpit() {
  const group = new THREE.Group();
  group.visible = false;

  // ── GLB 셸: 야간 장면광이 약해도 톤이 살도록 자체 발광을 약하게 섞는다 ──
  const model = instantiate('cockpit');
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    const m = o.material;
    if (m?.name && m.name.startsWith('Ck') && m.name !== 'CkAmber' && !m.userData.ckGlow) {
      m.emissive.copy(m.color).multiplyScalar(1);
      m.emissiveIntensity = 0.22;
      m.userData.ckGlow = true; // 캐시 원본 공유 — 중복 적용 방지
    }
  });
  group.add(model);

  // 센터스택(하우징·송풍구·공조)이 카메라에서 0.47m — 너무 가까워 화면을 압도한다.
  // 익스포트가 버텍스에 위치를 굽지만 노드는 남아 있으므로 노드 오프셋으로 밀어넣는다.
  const STACK_PARTS = ['CkStackHousing', 'CkStackBezel', 'CkVentF', 'CkVentB',
    'CkSlat', 'CkClimate', 'CkAmberDisp', 'CkKnob'];
  model.traverse((o) => {
    if (STACK_PARTS.some((p) => o.name.startsWith(p))) {
      o.position.y -= 0.05;
      o.position.z += 0.24;
    }
  });

  // 핸들: 로드 시 recenterPivot으로 허브 피벗 복원됨(assets.js).
  // 기울기(x)와 조향(z)을 오일러 XYZ 하나로 — X(기울기)·Z(스핀) 순서라 축이 맞는다.
  const wheelSpin = model.getObjectByName('WheelSpin');
  if (wheelSpin) wheelSpin.rotation.set(WHEEL_TILT, 0, 0);

  // ── 계기판: 아날로그 게이지 캔버스(비나클 안) — drawCluster를 주기 호출 ──
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
  const drawCluster = (kmh) => {
    cCtx.clearRect(0, 0, 256, 96);
    cCtx.fillStyle = 'rgba(6,8,12,0.95)';
    cCtx.fillRect(0, 6, 256, 84);
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
  cluster.position.set(DX, 1.185, 1.01); // 비나클 후드 안
  cluster.rotation.set(0.3, Math.PI, 0);
  group.add(cluster);

  // ── 내비 화면: 센터스택 하우징 위 (지도 캔버스 — 색 포인트) ──
  const sCv = document.createElement('canvas');
  sCv.width = 192; sCv.height = 96;
  const sCtx = sCv.getContext('2d');
  sCtx.fillStyle = '#0a1526';
  sCtx.fillRect(0, 0, 192, 96);
  sCtx.strokeStyle = '#22314a';
  sCtx.lineWidth = 1.5;
  for (let gx = 0; gx < 192; gx += 24) { sCtx.beginPath(); sCtx.moveTo(gx, 0); sCtx.lineTo(gx, 96); sCtx.stroke(); }
  for (let gy = 0; gy < 96; gy += 24) { sCtx.beginPath(); sCtx.moveTo(0, gy); sCtx.lineTo(192, gy); sCtx.stroke(); }
  sCtx.strokeStyle = '#4fd8c8';
  sCtx.lineWidth = 4;
  sCtx.beginPath(); sCtx.moveTo(20, 84); sCtx.quadraticCurveTo(90, 60, 176, 22); sCtx.stroke();
  sCtx.strokeStyle = '#e8a13c';
  sCtx.lineWidth = 2.5;
  sCtx.beginPath(); sCtx.moveTo(8, 40); sCtx.lineTo(150, 78); sCtx.stroke();
  sCtx.fillStyle = '#5fb4ff';
  sCtx.beginPath(); sCtx.arc(96, 62, 5, 0, Math.PI * 2); sCtx.fill();
  sCtx.fillStyle = 'rgba(150,200,255,0.8)';
  sCtx.font = 'bold 11px sans-serif';
  sCtx.textAlign = 'left';
  sCtx.fillText('올림픽대로', 104, 56);
  const navTex = new THREE.CanvasTexture(sCv);
  navTex.colorSpace = THREE.SRGBColorSpace;
  const nav = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.24),
    new THREE.MeshBasicMaterial({ map: navTex })
  );
  nav.position.set(0, 1.19, 1.235); // 스택 하우징(노드 오프셋 후) 표면
  nav.rotation.set(0.21, Math.PI, 0);
  group.add(nav);

  // ── 미러: 후방 카메라 1대를 렌더타깃에 그려 두 거울이 공유 ──
  const rt = new THREE.WebGLRenderTarget(MIRROR_W, MIRROR_H);
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.repeat.x = -1; // 거울 좌우 반전
  const rearCam = new THREE.PerspectiveCamera(60, MIRROR_W / MIRROR_H, 0.5, 900);
  const mirrorMat = new THREE.MeshBasicMaterial({ map: rt.texture });

  // 좌측 사이드미러 거울면: CkSideMirror 하우징(1.16, 1.27, 1.30) 뒷면
  const sideGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.12), mirrorMat);
  sideGlass.position.set(1.15, 1.27, 1.245);
  sideGlass.rotation.y = Math.PI + 0.3; // 운전자 쪽으로
  group.add(sideGlass);

  // 룸미러 거울면: CkRoomMirror 하우징(0, 1.60, 1.15) 뒷면
  const roomGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.10), mirrorMat);
  roomGlass.position.set(0, 1.60, 1.122);
  roomGlass.rotation.set(0.2, Math.PI, 0);
  group.add(roomGlass);

  return { group, wheelSpin, rt, rearCam, drawCluster };
}
