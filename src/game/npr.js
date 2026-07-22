// NPR(셀셰이딩) 렌더 모드 — 시작 화면 '만화 렌더' 토글(또는 ?npr=1/0)로 켠다.
// 기본 룩(PBR)은 불변. 레시피는 물멍/seaside-walk에서 검증한 것:
// ①MeshToonMaterial 변환(4단 gradientMap, 최저 밴드를 올려 밤 장면의 어두운 면이
// 통검정으로 죽지 않게) ②화면공간 뎁스 불연속 잉크 엣지(인버티드 헐은 폐기된 방식).
// 성능 관점: Toon은 env/PBR BRDF를 안 타서 멀티 다인원 시 셰이딩 비용이 줄어든다.

import * as THREE from 'three';

let gradTex = null;
function gradientMap() {
  if (!gradTex) {
    const data = new Uint8Array([115, 165, 210, 255]);
    gradTex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
    gradTex.minFilter = THREE.NearestFilter;
    gradTex.magFilter = THREE.NearestFilter;
    gradTex.needsUpdate = true;
  }
  return gradTex;
}

// MeshStandardMaterial → MeshToonMaterial (공유 재질은 캐시로 1회만 변환).
// 절차 셰이더 주입 재질(빌딩 창문·수면 등 onBeforeCompile 커스텀)은 건드리지
// 않는다 — 변환하면 주입 GLSL이 날아가 창문·물결이 사라진다.
// 반환값은 구재질→신재질 Map — car.js/traffic.js가 미리 수집해 둔 재질 참조
// (브레이크등 emissive 부스트)를 호출측이 이 맵으로 재연결한다.
export function toonifyScene(scene) {
  const cache = new Map();
  const convert = (m) => {
    if (!m || !m.isMeshStandardMaterial) return m;
    if (m.onBeforeCompile && String(m.onBeforeCompile).length > 60) return m;
    if (cache.has(m)) return cache.get(m);
    const t = new THREE.MeshToonMaterial({
      color: m.color.clone(),
      map: m.map || null,
      gradientMap: gradientMap(),
      emissive: m.emissive.clone(),
      emissiveMap: m.emissiveMap || null,
      emissiveIntensity: m.emissiveIntensity,
      transparent: m.transparent,
      opacity: m.opacity,
      side: m.side,
      depthWrite: m.depthWrite,
      alphaTest: m.alphaTest,
      vertexColors: m.vertexColors,
    });
    t.name = m.name;
    cache.set(m, t);
    return t;
  };
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) o.material = o.material.map(convert);
    else o.material = convert(o.material);
  });
  return cache;
}

// 뎁스 불연속 잉크 엣지: 이웃 픽셀과의 뷰공간 깊이 차가 (거리 비례 임계보다)
// 크면 잉크색으로 — 실루엣·건물 모서리에 만화 선이 생긴다.
// 입력 uniform 이름이 tDiffuse가 아닌 tScene인 이유: ShaderPass가 tDiffuse를
// 컴포저 readBuffer로 덮어쓰는데, 우리는 전용 씬 RT를 읽어야 한다(피드백 루프
// 회피 구조 — 컴포저 핑퐁 버퍼엔 뎁스를 부착하지 않는다).
export const InkEdgeShader = {
  uniforms: {
    tScene: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 5200 },
    strength: { value: 0.85 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tScene;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float cameraNear, cameraFar, strength;
    varying vec2 vUv;
    float vz(vec2 uv) {
      return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    }
    void main() {
      vec2 px = 1.0 / resolution;
      float c = vz(vUv);
      float dx = max(abs(vz(vUv + vec2(px.x, 0.0)) - c), abs(vz(vUv - vec2(px.x, 0.0)) - c));
      float dy = max(abs(vz(vUv + vec2(0.0, px.y)) - c), abs(vz(vUv - vec2(0.0, px.y)) - c));
      float d = max(dx, dy);
      // 거리 비례 임계 — 원경(빌딩 숲)에서 온통 선투성이가 되는 걸 억제
      float edge = smoothstep(0.9, 2.2, d / (0.004 * c + 0.05));
      vec3 col = texture2D(tScene, vUv).rgb;
      vec3 ink = vec3(0.012, 0.016, 0.03);
      gl_FragColor = vec4(mix(col, ink, edge * strength), 1.0);
    }`,
};
