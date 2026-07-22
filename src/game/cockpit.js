// 1인칭 콕핏 (좌핸들 운전석 뷰) — Sketchfab GLB 셸 + 런타임 화면/거울.
// 변형 2종: 'sf' XJ220 인테리어(CC-BY, Gerhald) / '918' 포르쉐 918(CC-BY, 3D Cars Studio).
// 기본값: 선택 차량이 car7(918)이면 '918', 아니면 'sf'. ?cockpit=sf|918 로 강제.
// 계기판·내비는 런타임 캔버스(918은 순정 발광 계기판 사용), 거울은 후방 렌더타깃:
//   918 = 순정 거울 메시의 UV를 평면 투영으로 재계산해 RT를 거울 모양에 정확히 맞춤.
//   sf  = 하우징 면에 맞춘 오버레이 평면.
// 거울은 위치(차 로컬 x)로 룸/좌측/우측을 분류해 각자 카메라·렌더타깃을 갖는다
// — 예전엔 후방 카메라 1대를 전부 공유해 사이드미러와 룸미러가 같은 화면이었다.
// 좌표계: 차 전방 = 로컬 +Z, 로컬 +X = 차의 왼쪽(주의!). 운전석 X=+0.45.
// 1인칭 카메라는 반환값 eye 로컬 오프셋 — game.js FP 카메라가 이를 사용한다.

import * as THREE from 'three';
import { findByNamePrefix, instantiate } from '../utils/assets.js';

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

// 변형 정의: 에셋, 눈 위치(로컬), 핸들 칼럼 각도, 캔버스 계기판 위치(순정 계기판 없는 차만)
const VARIANTS = {
  sf: {
    asset: 'cockpitSf', tilt: -0.42, eye: { x: DX, y: 1.42, z: 0.55 },
    cluster: { pos: [DX, 1.19, 1.14], scale: 0.88 },
  },
  // 918 eye: 허브(0.45, 0.72, 0.79) 대비 0.23 위·0.57 뒤(시선각 ~22°) —
  // 핸들 중앙 로고가 화면에 들어오도록 (다른 차들과 동일 기준)
  918: { asset: 'cockpit918', tilt: -0.5, eye: { x: DX, y: 0.95, z: 0.22 } },
  // BlackSnow 3종: 허브 위치·칼럼각은 Blender에서 실측. eye.x는 각 차의 실제 핸들 x.
  // eye는 핸들 중앙(허브 로고)이 화면에 들어오게 허브보다 ~0.2 높고 ~0.5 뒤
  // (FP 카메라가 수평 정면을 보므로 시선각 ~20-22도 아래에 허브가 오도록).
  // 캔버스 클러스터는 사용자 결정으로 미사용 — 순정 대시 그대로.
  // 주의: BlackSnow 3종의 플랫화 베이크는 918/sf와 회전 방향이 반대라
  // tilt가 '양수'다(음수를 주면 핸들이 앞으로 엎어져 찌그러져 보임).
  // 값 = Blender에서 실측한 칼럼각(rad): s63 24.1° / sl63 17.7° / m4 22.6°
  s63: { asset: 'cockpitS63', tilt: 0.42, eye: { x: 0.38, y: 1.13, z: -0.32 } },
  sl63: { asset: 'cockpitSl63', tilt: 0.31, eye: { x: 0.37, y: 1.05, z: -0.38 } },
  m4: { asset: 'cockpitM4', tilt: 0.39, eye: { x: 0.29, y: 1.10, z: -0.18 } },
};
const BY_CAR = { car7: '918', car10: 's63', car11: 'sl63', car12: 'm4' };

export function buildCockpit(carModel = 'car7') {
  const group = new THREE.Group();
  group.visible = false;

  const param = new URLSearchParams(location.search).get('cockpit');
  const variant = VARIANTS[param] ? param : (BY_CAR[carModel] || 'sf');
  const V = VARIANTS[variant];
  const is918 = variant === '918';
  const WHEEL_TILT = V.tilt; // 칼럼 각도(플랫화 베이크의 역각)
  const eye = V.eye;

  // ── GLB 셸 ──
  const mirrorSlots = []; // 거울 유리 재질 슬롯 {mesh, idx|-1} — 분류는 로드 후 위치로
  const model = instantiate(V.asset);
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    const apply = (m, idx) => {
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
      // 거울 유리(변형 공통, sf는 유리면을 GLB에서 분리해둠): UV 재계산만 하고
      // 재질 배정은 뒤로 미룬다 — 룸/좌/우 분류에 메시 최종 위치가 필요해서
      if (m.name === 'Mirror' || m.name.startsWith('Mirror.')) {
        remapMirrorUVs(o);
        mirrorSlots.push({ mesh: o, idx });
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
    o.material = Array.isArray(o.material)
      ? o.material.map((m, i) => apply(m, i))
      : apply(o.material, -1);
  });
  group.add(model);

  // ── 미러: 위치(차 로컬 x)로 룸(중앙)/좌(+)/우(-)를 분류해 각자 RT·카메라 부여 ──
  // 실제 후방 카메라 배치·렌더는 game.updateCockpit이 프레임 분할로 수행한다
  const mirrors = []; // { rt, cam, mat, side(0=룸, 1=좌, -1=우), pos(차 로컬 유리 중심) }
  group.updateMatrixWorld(true); // 아직 씬 밖 — group 원점 기준 = 차 로컬
  const mirrorOf = (side, pos) => {
    let mir = mirrors.find((m) => m.side === side);
    if (mir) return mir;
    const rt = new THREE.WebGLRenderTarget(MIRROR_W, MIRROR_H);
    rt.texture.wrapS = THREE.RepeatWrapping;
    rt.texture.repeat.x = -1; // 거울 좌우 반전
    mir = {
      rt,
      cam: new THREE.PerspectiveCamera(side === 0 ? 60 : 50, MIRROR_W / MIRROR_H, 0.5, 900),
      mat: new THREE.MeshBasicMaterial({ map: rt.texture }),
      side,
      pos,
    };
    mirrors.push(mir);
    return mir;
  };
  const _c = new THREE.Vector3();
  for (const { mesh, idx } of mirrorSlots) {
    mesh.geometry.computeBoundingBox();
    mesh.geometry.boundingBox.getCenter(_c);
    mesh.localToWorld(_c); // = 차 로컬 (+X 왼쪽, +Z 전방)
    const side = _c.x > 0.55 ? 1 : _c.x < -0.55 ? -1 : 0;
    const mir = mirrorOf(side, _c.clone());
    if (idx >= 0) mesh.material[idx] = mir.mat;
    else mesh.material = mir.mat;
  }
  mirrors.sort((a, b) => Math.abs(a.side) - Math.abs(b.side)); // 룸미러 먼저

  // 핸들: 로드 시 recenterPivot으로 허브 피벗 복원됨(assets.js).
  // 기울기(x)와 조향(z)을 오일러 XYZ 하나로 — X(기울기)·Z(스핀) 순서라 축이 맞는다.
  const wheelSpin = findByNamePrefix(model, 'WheelSpin');
  if (wheelSpin) wheelSpin.rotation.set(WHEEL_TILT, 0, 0);

  // ── 계기판 캔버스: 순정 발광 계기판이 없는 변형(sf·엘란트라·코나)에만 ──
  let drawCluster = () => {};
  if (V.cluster) {
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
    cluster.position.set(...V.cluster.pos); // 변형별 비나클 위치
    cluster.rotation.set(0.3, Math.PI, 0);
    cluster.scale.setScalar(V.cluster.scale);
    group.add(cluster);

    // (거울 유리 = GLB의 SfMirrorRoom/SfGlassSide가 Mirror 재질로 UV 리맵 RT를 받고,
    //  천장 = GLB의 CkCanopy 헤드라이너가 담당 — 런타임 오버레이 불필요)
  }

  return {
    group, wheelSpin, drawCluster, eye,
    mirrors,
    roomMirror: mirrors.find((m) => m.side === 0) || null,
    sideMirrors: mirrors.filter((m) => m.side !== 0),
  };
}
