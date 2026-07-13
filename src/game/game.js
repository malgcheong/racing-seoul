// 게임 루프: 씬 구성, 주행, 랩/점수, 추억 근접 팝업

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateTrack, buildRoadMesh, buildStartLine, straightenTrackWindow, MEDIAN_HALF } from '../map/trackGenerator.js';
import { generateBranchRoute, buildBranchRoad } from '../map/branchRoad.js';
import { TrafficSystem } from './traffic.js';
import { ParticleSystem } from './particles.js';
import { buildEnvironment } from '../map/decorations.js';
import { buildRestArea } from '../map/restArea.js';
import { Car } from './car.js';
import { buildCockpit } from './cockpit.js';
import { createWorld, clampToRoad } from './physics.js';
import { sounds } from './sounds.js';
import { createRng } from '../utils/rng.js';

const BASE_FOV = 68;
const MAX_SPEED_ABS = 36;       // car.js MAX_SPEED와 동일 (속도감 연출 기준)

// 별 필드: 상반구에 랜덤 분포, 밝기·색온도(푸름/노람) 배리에이션
function makeStars(count = 900) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const R = 4000; // 산맥 링(루트 스케일)보다 바깥
  const warm = new THREE.Color(0xfff2d0);
  const cool = new THREE.Color(0xcfd8ff);
  for (let i = 0; i < count; i++) {
    const azimuth = Math.random() * Math.PI * 2;
    const y = 0.04 + Math.pow(Math.random(), 0.7) * 0.96; // 위쪽에 살짝 더 밀집
    const r = Math.sqrt(1 - y * y);
    positions[i * 3] = Math.cos(azimuth) * r * R;
    positions[i * 3 + 1] = y * R;
    positions[i * 3 + 2] = Math.sin(azimuth) * r * R;
    const tint = warm.clone().lerp(cool, Math.random());
    const brightness = 0.25 + Math.pow(Math.random(), 2.2) * 0.75; // 대부분 흐리고 일부만 밝게
    colors[i * 3] = tint.r * brightness;
    colors[i * 3 + 1] = tint.g * brightness;
    colors[i * 3 + 2] = tint.b * brightness;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // 부드러운 원형 점 텍스처
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);

  const mat = new THREE.PointsMaterial({
    size: 2.4,
    sizeAttenuation: false, // 픽셀 고정 크기 (거리 무관)
    map: new THREE.CanvasTexture(canvas),
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false, // 안개 거리(800) 밖이므로 필수
  });
  const stars = new THREE.Points(geo, mat);
  stars.frustumCulled = false;
  return stars;
}

// 달: 크레이터 텍스처 원판 + 은은한 달무리. 방향광과 같은 방향에 배치해
// 그림자가 달에서 오는 것처럼 보이게 한다.
function makeMoon(dir) {
  const group = new THREE.Group();

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4efdf';
  ctx.beginPath();
  ctx.arc(64, 64, 62, 0, Math.PI * 2);
  ctx.fill();
  // 크레이터 얼룩
  for (const [x, y, r, a] of [
    [45, 42, 14, 0.16], [82, 58, 10, 0.13], [58, 85, 16, 0.14],
    [90, 88, 8, 0.11], [36, 70, 8, 0.1], [70, 30, 7, 0.12],
  ]) {
    ctx.fillStyle = `rgba(150,145,135,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const moonTex = new THREE.CanvasTexture(canvas);

  const disc = new THREE.Mesh(
    new THREE.PlaneGeometry(150, 150),
    new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, fog: false })
  );
  group.add(disc);

  // 달무리 (halo): 은은한 냉백색, 달을 중심으로
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = 128;
  haloCanvas.height = 128;
  const hctx = haloCanvas.getContext('2d');
  const hg = hctx.createRadialGradient(64, 64, 24, 64, 64, 64);
  hg.addColorStop(0, 'rgba(220,228,245,0.28)');
  hg.addColorStop(0.45, 'rgba(190,205,240,0.08)');
  hg.addColorStop(1, 'rgba(180,200,240,0)');
  hctx.fillStyle = hg;
  hctx.fillRect(0, 0, 128, 128);
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(340, 340),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(haloCanvas),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
  );
  halo.position.z = -1;
  group.add(halo);

  group.position.copy(dir).multiplyScalar(3800);
  group.lookAt(0, 0, 0);
  group.scale.setScalar(2.7); // 멀어진 만큼 크기 보정(각크기 유지)
  return group;
}

// 밤하늘 생명감: 천천히 가로지르는 비행기(점멸등) + 가끔 떨어지는 유성.
// skyDome(카메라 추종 그룹)에 넣어 무한히 먼 하늘처럼 보이게 한다.
function makeSkyLife() {
  const group = new THREE.Group();

  // 비행기: 좌현 빨강 / 우현 초록 / 흰 스트로브 점 3개
  const plane = new THREE.Group();
  const dotG = new THREE.SphereGeometry(1.5, 6, 4);
  const red = new THREE.Mesh(dotG, new THREE.MeshBasicMaterial({ color: 0xff4040, fog: false }));
  red.position.x = -5;
  const green = new THREE.Mesh(dotG, new THREE.MeshBasicMaterial({ color: 0x3aff6a, fog: false }));
  green.position.x = 5;
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(2.0, 6, 4),
    new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  plane.add(red, green, strobe);
  group.add(plane);
  const A = new THREE.Vector3(-950, 330, -520);
  const B = new THREE.Vector3(950, 380, 430);

  // 유성: 가늘고 긴 additive 스트릭이 잠깐 떨어졌다 사라짐
  const meteorMat = new THREE.MeshBasicMaterial({
    color: 0xcfe4ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const meteor = new THREE.Mesh(new THREE.PlaneGeometry(50, 1.2), meteorMat);
  group.add(meteor);
  let meteorNext = 14;
  let meteorT = -1;

  function update(t, dt) {
    // 비행기 왕복 순환 (편도 ~95초)
    const T = 95;
    const k = (t % T) / T;
    plane.position.lerpVectors(A, B, k);
    strobe.visible = (t % 1.3) < 0.09; // 스트로브 번쩍
    // 유성 스폰/애니메이션
    meteorNext -= dt;
    if (meteorNext <= 0 && meteorT < 0) {
      meteorT = 0;
      meteorNext = 18 + Math.random() * 26;
      meteor.position.set((Math.random() - 0.5) * 1300, 430 + Math.random() * 170, -650);
      meteor.lookAt(0, meteor.position.y * 0.4, 0); // 대략 카메라 쪽을 향한 판
      meteor.rotateZ(-0.62);                        // 떨어지는 기울기
    }
    if (meteorT >= 0) {
      meteorT += dt;
      const p = meteorT / 0.9;
      if (p >= 1) { meteorT = -1; meteorMat.opacity = 0; }
      else {
        meteor.position.x += dt * 300;
        meteor.position.y -= dt * 210;
        meteorMat.opacity = (p < 0.25 ? p / 0.25 : 1 - (p - 0.25) / 0.75) * 0.85;
      }
    }
  }
  return { group, update };
}

// 화면 가장자리를 살짝 어둡게 (비네트)
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.4 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      color.rgb *= 1.0 - smoothstep(0.3, 0.8, d) * strength;
      gl_FragColor = color;
    }
  `,
};

function makeSky(palette, radius = 1600, sunDir = null) {
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const azim = sunDir
    ? new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize()
    : new THREE.Vector3(0, 0, 1);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor: { value: new THREE.Color(palette.skyTop) },
      bottomColor: { value: new THREE.Color(palette.skyHorizon) },
      glowColor: { value: new THREE.Color(palette.sunGlow ?? 0x000000) },
      sunAzim: { value: azim },
      // 노을: 태양 방위 지평선이 달궈진다 (밤엔 0 → 기존과 동일)
      glowStrength: { value: palette.tod === 'dusk' ? 1.0 : 0.0 },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform vec3 glowColor;
      uniform vec3 sunAzim;
      uniform float glowStrength;
      varying vec3 vPos;
      void main() {
        vec3 dir = normalize(vPos);
        float h = dir.y * 0.5 + 0.5;
        vec3 col = mix(bottomColor, topColor, pow(h, 0.8));
        if (glowStrength > 0.0) {
          float facing = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), sunAzim), 0.0);
          float low = pow(1.0 - clamp(dir.y, 0.0, 1.0), 3.0);
          col += glowColor * pow(facing, 2.4) * low * glowStrength;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

// 노을 태양: 지평선 근처의 큰 주황 원반 + 넓은 웜 헤일로
function makeDuskSun(dir) {
  const group = new THREE.Group();
  const mk = (size, draw) => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    draw(c.getContext('2d'));
    return new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
  };
  const disc = mk(240, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 58);
    g.addColorStop(0, 'rgba(255,236,190,1)');
    g.addColorStop(0.55, 'rgba(255,166,80,0.95)');
    g.addColorStop(1, 'rgba(255,120,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  const halo = mk(950, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,160,80,0.34)');
    g.addColorStop(0.5, 'rgba(255,130,70,0.1)');
    g.addColorStop(1, 'rgba(255,110,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  halo.position.z = -1;
  group.add(disc, halo);
  group.position.copy(dir).multiplyScalar(3800);
  group.lookAt(0, 0, 0);
  group.scale.setScalar(2.7);
  return group;
}

// 노을 구름: 태양 쪽 하늘에 깔린 길쭉한 구름 띠 — 밑면이 주황으로 달궈짐
function makeDuskClouds(rng, sunDir) {
  const group = new THREE.Group();
  const tex = (() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 26; i++) { // 겹친 타원 블롭 → 길쭉한 구름
      const x = 20 + Math.random() * 216;
      const y = 22 + Math.random() * 22;
      const r = 14 + Math.random() * 26;
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      const warm = y > 34; // 아랫면일수록 주황
      g.addColorStop(0, warm ? 'rgba(255,150,95,0.34)' : 'rgba(212,180,205,0.30)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.7, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  })();
  const azim = Math.atan2(sunDir.x, sunDir.z);
  for (let k = 0; k < 9; k++) {
    const a = azim + (rng() - 0.5) * 2.4;         // 태양 방위 주변에 몰림
    const el = 0.06 + rng() * 0.2;                // 낮은 고도각
    const R = 3500;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(700 + rng() * 700, 90 + rng() * 110),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, fog: false,
        opacity: 0.5 + rng() * 0.4,
      }));
    m.position.set(Math.sin(a) * R * Math.cos(el), Math.sin(el) * R, Math.cos(a) * R * Math.cos(el));
    m.lookAt(0, m.position.y * 0.5, 0);
    group.add(m);
  }
  return group;
}

export class Game {
  // palette: nightCityPalette 결과
  constructor(container, palette, ui, opts = {}) {
    this.container = container;
    this.palette = palette;
    this.ui = ui; // { onHud, onLap, onFinish, onCountdown, onBoost }
    this.carModel = opts.carModel || 'car2'; // 선택된 차량 에셋 이름

    this.running = false;
    this.disposed = false;
    this.input = { forward: false, backward: false, left: false, right: false, drift: false };
    this.clock = new THREE.Clock();

    this.raceTime = 0;
    this.totalDist = 0;   // 주행 거리(전진분) — 평균속도 산출용
    this.maxSpeed = 0;    // 최고 속도(km/h) — 결과 화면용
    this.finished = false;
  }

  build(seed) {
    const rng = createRng(seed);

    // 렌더러/씬
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    // 성능: 고DPI에서 픽셀 수가 제곱으로 늘어 포스트프로세싱 비용이 커짐 → 1.5로 캡
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // Soft 대비 저렴(야간이라 차이 미미)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // 야간: 안개(원경 깊이감). 배경 산맥까지 바닥이 이어지고 산은 헤이즈에 녹아들도록
    this.scene.fog = new THREE.Fog(this.palette.fog, 220, 2800);

    this.camera = new THREE.PerspectiveCamera(
      BASE_FOV,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      5200 // 하늘 돔(4200)·원경 산맥까지 커버
    );

    // 조명: 하늘/지면 색을 반영한 헤미스피어 + 그림자 태양광
    // 야간: 은은한 도시광(헤미) + 달빛(방향광) / 노을: 낮은 주황 태양 + 보랏빛 헤미
    const dusk = this.palette.tod === 'dusk';
    const hemi = dusk
      ? new THREE.HemisphereLight(0x9a7fb8, 0x3a2a22, 0.5)
      : new THREE.HemisphereLight(this.palette.skyHorizon, 0x0a0c16, 0.32);
    const sun = dusk
      ? new THREE.DirectionalLight(this.palette.sunColor, 1.3)
      : new THREE.DirectionalLight(0xaabdf5, 0.7);
    // 노을 태양은 서쪽(목적지 방향 = -X) 지평선에 낮게 — 석양을 향해 달린다
    this.sunDir = dusk
      ? new THREE.Vector3(-0.86, 0.16, 0.28).normalize()
      : new THREE.Vector3(0.5, 0.72, 0.34).normalize();
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -95;
    sun.shadow.camera.right = 95;
    sun.shadow.camera.top = 95;
    sun.shadow.camera.bottom = -95;
    sun.shadow.camera.near = 30;
    sun.shadow.camera.far = 600;
    sun.shadow.camera.updateProjectionMatrix(); // 속성 변경 후 필수
    sun.shadow.bias = -0.0006;
    this.sun = sun;
    this.scene.add(hemi, sun, sun.target);

    // 밤하늘: 돔 + 별 필드 + 달을 한 그룹으로 묶어 카메라를 따라가게 한다
    // (무한히 먼 것처럼 보이게 해 시차로 흔들리지 않도록. 달은 달빛 방향과 일치)
    this.skyDome = new THREE.Group();
    this.skyDome.add(makeSky(this.palette, 4200, this.sunDir));
    if (dusk) {
      // 노을: 태양 원반 + 낮은 구름 띠 + 초저녁 별 몇 개
      const dimStars = makeStars(220);
      dimStars.material.opacity = 0.4;
      dimStars.material.transparent = true;
      this.skyDome.add(dimStars);
      this.skyDome.add(makeDuskSun(this.sunDir));
      this.skyDome.add(makeDuskClouds(rng, this.sunDir));
    } else {
      this.skyDome.add(makeStars());
      this.skyDome.add(makeMoon(this.sunDir));
    }
    this.skyLife = makeSkyLife(); // 비행기 점멸등 + 유성
    this.skyDome.add(this.skyLife.group);
    this.scene.add(this.skyDome);

    // 하늘을 환경맵으로 구워 젖은 노면·차체에 은은한 시트(sheen) 반사
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(makeSky(this.palette, 50, this.sunDir));
    this.scene.environment = pmrem.fromScene(envScene, 0.05, 0.1, 100).texture;
    // 노을 환경맵은 밝아서 젖은 노면이 통째로 주황으로 타오른다 — 세게 낮춘다
    this.scene.environmentIntensity = dusk ? 0.3 : 0.35;
    pmrem.dispose();

    // 포스트프로세싱: bloom(빛 번짐) + 비네트
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      // 절반 해상도 — 블룸은 블러라 반해상도로도 차이가 안 보이고 비용은 크게 줆
      new THREE.Vector2(this.container.clientWidth / 2, this.container.clientHeight / 2),
      // 야간: 광원만 은은하게 / 노을: 노면이 밝아 빛 웅덩이가 과하게 타므로 임계값 상향
      dusk ? 0.3 : 0.38, 0.45, dusk ? 0.88 : 0.72
    );
    this.composer.addPass(this.bloomPass);
    this.vignettePass = new ShaderPass(VignetteShader);
    this.vignettePass.uniforms.strength.value = 0.4; // 야간 무드용 고정 비네트
    this.composer.addPass(this.vignettePass);
    this.composer.addPass(new OutputPass());

    this.particles = new ParticleSystem(this.scene);

    // 트랙 + 장식 + 추억 오브젝트 (편도 루트: 출발 → 강 다리 → 목적지)
    const track = generateTrack(rng);
    this.samples = track.samples;
    this.trackWidth = track.width;
    this.river = track.river;
    // 도로 메시는 쉼터 구간 직선화(아래) 이후에 생성한다
    // 우측 통행: 주행 가능한 측면 범위(중앙선 ~ 우측 배리어), lateral<0이 우측.
    // 중앙분리대는 제거됐지만 플레이어는 우측 차로에, 대향차는 좌측 차로에 유지.
    this.laneMin = MEDIAN_HALF + 1.4;               // 중앙에서 최소 이격
    this.laneMax = track.width / 2 - 1.2;           // 우측 갓길 직전
    this.laneCenter = (this.laneMin + this.laneMax) / 2;
    // 졸음쉼터 위치: 루트 20~60% 중 가장 직선이면서 다리(강) 위가 아닌 구간.
    // (플랫폼이 긴 직사각형이라 곡선 구간에 걸리면 도로를 덮어버림)
    const nS = track.samples.length;
    // 샘플 간 평균 간격(m) — 구간 폭(미터)을 샘플 수로 환산하는 기준
    let trackLen = 0;
    for (let i = 0; i < nS - 1; i++) {
      trackLen += track.samples[i].pos.distanceTo(track.samples[i + 1].pos);
    }
    const segLen = trackLen / (nS - 1);
    // 출발선: 도로 시작 단면(끝단 정리 반경 70m)보다 안쪽 45m 지점 —
    // 뒤따라오는 카메라(차 뒤 ~11m)가 도로 밖으로 빠져나가지 않게 여유를 둔다
    this.startIdx = Math.max(8, Math.round(45 / segLen));
    this.scene.add(buildStartLine(track.samples, track.width, this.startIdx));
    this.scene.add(buildStartLine(track.samples, track.width, nS - 10)); // 결승선
    const spanBody = Math.round(40 / segLen);   // 쉼터 본체 z±40m
    const spanRamp = Math.round(80 / segLen);   // 램프 끝 z±80m
    const onBridge = (i) => {
      const x = track.samples[Math.max(0, Math.min(nS - 1, i))].pos.x;
      return x > this.river.x0 - 110 && x < this.river.x1 + 110;
    };
    let restIdx = Math.floor(nS * 0.35);
    let bestCurve = Infinity;
    for (let i = Math.floor(nS * 0.2); i < Math.floor(nS * 0.6); i++) {
      if (onBridge(i - spanRamp) || onBridge(i) || onBridge(i + spanRamp)) continue;
      let curve = 0;
      for (let k = -spanRamp; k < spanRamp; k++) {
        const ta = track.samples[Math.max(0, Math.min(nS - 1, i + k))].tangent;
        const tb = track.samples[Math.max(0, Math.min(nS - 1, i + k + 1))].tangent;
        curve += 1 - ta.dot(tb);
      }
      if (curve < bestCurve) { bestCurve = curve; restIdx = i; }
    }
    // 시드에 따라 "가장 직선인 구간"도 S커브일 수 있다 — 쉼터 창을 직선으로
    // 눌러붙인 뒤에 도로 메시를 만들어 진입로가 항상 곧게 뻗게 한다
    straightenTrackWindow(track.samples, restIdx, Math.round(130 / segLen));
    const roadMesh = buildRoadMesh(track.samples, track.width);
    // 노을: 물웅덩이(roughnessMap 매끈 패치)가 밝은 하늘을 그대로 비추면 과함
    if (dusk) roadMesh.material.envMapIntensity = 0.35;
    this.scene.add(roadMesh);
    this.restIdx = restIdx;
    this.restOuter = 30;          // 졸음쉼터 구간에서 허용되는 우측 최대 이격(확장 플랫폼)
    this.restSpan = spanBody;     // 본체 구간 인덱스 반경
    this.restRampSpan = spanRamp; // 램프 끝까지의 반경 — 이 사이에서 허용 폭이 선형 테이퍼
    this.segLen = segLen;

    // 분기 루트: 다리 직후 우측 진출 → 루프 하강 → 강변도로 크루즈 → 본선 재합류
    this.branch = generateBranchRoute(track.samples, track.river);
    this.onBranch = false;
    this.branchIdx = 0;
    // push: 쉼터 구간은 건물을 없애지 않고 플랫폼(중심선 기준 ~32.5m) 뒤로 물려 세운다
    const gaps = [{ side: 1, idx: restIdx, halfSpan: spanRamp + 3, parapetSpan: spanRamp, push: 37 }];
    let branchCoarse = null;
    if (this.branch) {
      this.scene.add(buildBranchRoad(this.branch, track.samples, track.width));
      // 올림픽대로 종점 = 대체 결승선 (분기는 재합류 없이 쭉 간다)
      this.scene.add(buildStartLine(this.branch.samples, this.branch.width,
        this.branch.samples.length - 30));
      branchCoarse = this.branch.samples.filter((_, i) => i % 3 === 0).map((s) => s.pos);
      // 진출부: 갈라지는 ~60m 파라펫·스커트 개방
      gaps.push({
        side: 1, idx: this.branch.exitIdx + Math.round(25 / segLen),
        halfSpan: Math.round(48 / segLen), parapetSpan: Math.round(32 / segLen),
      });
    }
    const env = buildEnvironment(this.scene, rng, track.samples, this.palette, track.width,
      gaps, track.river, branchCoarse);
    buildRestArea(this.scene, track.samples, restIdx); // 졸음쉼터(우측 장식)
    this.lampHeads = env.lampHeads;
    this.envUpdate = env.update;   // 환경 애니메이션(전광판·점멸등) 훅
    this.worldTime = 0;            // 레이스와 무관하게 항상 흐르는 시계
    // 실제 광원은 3개만 풀링: 매 프레임 차에서 가장 가까운 가로등 3개로 이동
    this.lampLights = [];
    for (let i = 0; i < 3; i++) {
      // 노을: 하늘이 밝아 가로등 실광원이 노면을 태우면 과함 — 절반으로
      const light = new THREE.PointLight(0xffdfae, dusk ? 85 : 170, 32, 1.9);
      this.scene.add(light);
      this.lampLights.push(light);
    }

    // 물리 월드(평면 강체) — 차-차 충돌은 엔진이 처리
    this.world = createWorld();

    // 차량: 우측통행 — 플레이어는 +lateral(우측 차로), 대향차는 -lateral(좌측)
    const s0 = this.samples[this.startIdx]; // 출발선 위치와 일치
    const heading = Math.atan2(s0.tangent.x, s0.tangent.z);
    const startPos = s0.pos.clone().addScaledVector(s0.left, this.laneCenter); // 우측 차로
    this.car = new Car(this.carModel, this.world, startPos);
    this.car.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.car.placeAt(startPos, heading);
    this.scene.add(this.car.group);
    // 시점: 3인칭 추격(기본) ↔ 1인칭 콕핏뷰. C 키 토글, ?cam=fp 로 시작 지정
    this.cockpit = buildCockpit();
    this.car.group.add(this.cockpit.group);
    this.setView(new URLSearchParams(location.search).get('cam') === 'fp');
    // 대향차와 충돌 시 스파크/셰이크(밀림은 엔진이 처리)
    this.car.body.addEventListener('collide', (e) => {
      if (e.body && e.body.__traffic) this.onCarCollide(e);
    });

    // 야간 헤드라이트 (차와 함께 이동하는 스포트라이트)
    const headlight = new THREE.SpotLight(0xffedc4, 1000, 85, 0.44, 0.5, 1.7);
    headlight.position.set(0, 2.0, 1.5);
    headlight.target.position.set(0, -1.5, 32);
    this.car.group.add(headlight, headlight.target);

    // 대향 차량: 맞은편(좌측, -lateral) 차선에서 플레이어 쪽으로 랜덤하게 달려옴
    // 일방통행 4차선: 폭/4 기준 4개 차선 중심(모두 같은 방향)
    const laneW = track.width / 4;
    this.traffic = new TrafficSystem(this.scene, this.samples, {
      world: this.world,
      laneCenters: [-laneW * 1.5, -laneW * 0.5, laneW * 0.5, laneW * 1.5], // -8.25,-2.75,+2.75,+8.25
      count: 16,
      river: track.river, // 다리 구간 정체(구간별 밀도감)용
      debugClose: new URLSearchParams(location.search).get('tclose') === '1',
    });
    this.crashShake = 0;
    // 니어미스 칼치기 → 부스터 게이지 충전(점수 없음)
    this.boostGauge = 0;   // 0~1, 차면 부스터 발동
    this.flash = null;     // 중앙 팝업 { t, label, sub?, close? }

    this.currentSampleIdx = 0;

    // 개발·검증: ?rest=1 → 졸음쉼터 직전에서 시작
    if (new URLSearchParams(location.search).get('rest') === '1') {
      const ri = Math.max(0, restIdx - Math.round(40 / segLen));
      const rs = track.samples[ri];
      this.currentSampleIdx = ri;
      this.car.placeAt(
        rs.pos.clone().addScaledVector(rs.left, this.laneCenter),
        Math.atan2(rs.tangent.x, rs.tangent.z)
      );
    }
    // 개발·검증: ?branch=1 → 분기 진출점 직전에서 시작 / ?branch=N(≥2) → 분기 샘플 N에서 시작
    const branchParam = new URLSearchParams(location.search).get('branch');
    if (this.branch && branchParam === '1') {
      const bi = Math.max(0, this.branch.exitIdx - Math.round(70 / segLen));
      const bsmp = track.samples[bi];
      this.currentSampleIdx = bi;
      this.car.placeAt(
        bsmp.pos.clone().addScaledVector(bsmp.left, this.laneCenter),
        Math.atan2(bsmp.tangent.x, bsmp.tangent.z)
      );
    } else if (this.branch && parseInt(branchParam, 10) >= 2) {
      const bi = Math.min(this.branch.samples.length - 20, parseInt(branchParam, 10));
      const bsmp = this.branch.samples[bi];
      this.onBranch = true;
      this.branchIdx = bi;
      this.currentSampleIdx = this.branch.exitIdx;
      this.car.placeAt(bsmp.pos.clone(), Math.atan2(bsmp.tangent.x, bsmp.tangent.z));
    }
    // 개발·검증: ?at=0.45 → 루트의 해당 지점에서 시작 (다리 등 특정 구간 확인용)
    const atParam = parseFloat(new URLSearchParams(location.search).get('at'));
    if (!Number.isNaN(atParam)) {
      const ai = Math.max(0, Math.min(nS - 2, Math.floor(nS * atParam)));
      const asmp = track.samples[ai];
      this.currentSampleIdx = ai;
      this.car.placeAt(
        asmp.pos.clone().addScaledVector(asmp.left, this.laneCenter),
        Math.atan2(asmp.tangent.x, asmp.tangent.z)
      );
    }

    // 개발용 렌더 통계 (?stats=1): 드로우콜/삼각형 수를 좌상단 힌트에 표시
    // 컴포저가 패스마다 info를 리셋하므로 수동 리셋으로 프레임 전체를 집계
    this.showStats = new URLSearchParams(location.search).get('stats') === '1';
    if (this.showStats) this.renderer.info.autoReset = false;

    this.bindInput();
    this.onResize = () => {
      if (this.disposed) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.composer.setSize(w, h);
    };
    window.addEventListener('resize', this.onResize);

    // 첫 프레임 렌더 (카운트다운 배경)
    this.updateCamera(true);
    this.updateSun();
    this.composer.render();
  }

  bindInput() {
    this.onKey = (e, down) => {
      switch (e.code) {
        case 'ArrowUp': case 'KeyW': this.input.forward = down; break;
        case 'ArrowDown': case 'KeyS': this.input.backward = down; break;
        case 'ArrowLeft': case 'KeyA': this.input.left = down; break;
        case 'ArrowRight': case 'KeyD': this.input.right = down; break;
        case 'ShiftLeft': case 'ShiftRight': this.input.drift = down; break;
        case 'KeyC': if (down && !e.repeat) this.setView(!this.fpView); break;
        default: return;
      }
      e.preventDefault();
    };
    this.keydown = (e) => this.onKey(e, true);
    this.keyup = (e) => this.onKey(e, false);
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
  }

  async countdown() {
    for (const n of [3, 2, 1]) {
      this.ui.onCountdown(String(n));
      sounds.countdown();
      await new Promise((r) => setTimeout(r, 800));
    }
    this.ui.onCountdown('GO!');
    sounds.go();
    setTimeout(() => this.ui.onCountdown(null), 700);
  }

  async start() {
    await this.countdown();
    if (this.disposed) return;
    // 개발·검증용 자동 주행 (?autodrive=1)
    if (new URLSearchParams(location.search).get('autodrive') === '1') {
      this.input.forward = true;
      this.autoSteer = true;
    }
    this.running = true;
    this.clock.start();
    this.raceTime = 0;
    this.loop();
  }

  // 트랙 위 최근접 샘플 탐색 (인접 구간만 훑는 O(1) 윈도우 탐색, 개방 트랙: 클램프)
  findNearestSample() {
    const n = this.samples.length;
    const pos = this.car.group.position;
    let bestIdx = this.currentSampleIdx;
    let bestDist = Infinity;
    const lo = Math.max(0, this.currentSampleIdx - 40);
    const hi = Math.min(n - 1, this.currentSampleIdx + 40);
    for (let i = lo; i <= hi; i++) {
      const d = pos.distanceToSquared(this.samples[i].pos);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    this.currentSampleIdx = bestIdx;
    return { idx: bestIdx, dist: Math.sqrt(bestDist) };
  }

  // 임의 샘플 배열에서 가장 가까운 인덱스 (수평 거리 — 분기는 고도가 달라짐)
  nearestSampleOf(arr, guess, win) {
    const p = this.car.body.position;
    let bi = guess, bd = Infinity;
    const lo = Math.max(0, guess - win);
    const hi = Math.min(arr.length - 1, guess + win);
    for (let i = lo; i <= hi; i++) {
      const dx = p.x - arr[i].pos.x, dz = p.z - arr[i].pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return { idx: bi, dist: Math.sqrt(bd) };
  }

  // 대향 차량과 충돌 → 즉시 게임 실패 (현실성: 사고 한 번이면 끝)
  onCarCollide(e) {
    if (this.finished) return;
    const rel = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 8;
    if (rel < 1.5) return; // 물리 솔버의 미세 접촉 노이즈만 무시
    this.fail();
  }

  fail() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    this.crashShake = 1.4; // 사고 임팩트 셰이크(감쇠는 updateCamera가 처리)
    sounds.hit?.();
    this.ui.onFail({
      totalTime: this.raceTime,
      maxSpeed: this.maxSpeed,
      avgSpeed: this.raceTime > 0 ? (this.totalDist / this.raceTime) * 3.6 : 0,
      progress: this.currentSampleIdx / (this.samples.length - 1),
    });
  }

  // 니어미스: 아슬아슬할수록 부스터 게이지를 많이 충전 (점수는 없음 — 순위는 평균속도)
  onNearMiss(minDist, dir, near, collide) {
    const prox = THREE.MathUtils.clamp((near - minDist) / (near - collide), 0, 1); // 1=아슬아슬
    this.boostGauge += 0.12 + prox * 0.16;
    if (this.boostGauge >= 1) { this.car.boost(2.2); this.boostGauge = 0; sounds.boost?.(); }
    this.flash = { t: 0.9, label: prox > 0.6 ? '아슬아슬!' : '니어미스!', close: prox > 0.6 };
  }

  updateCamera(snap = false) {
    const car = this.car.group;
    // 개발·검증: ?top=220 → 차 위 조감 뷰 (배치 문제 확인용)
    if (this.topViewH === undefined) {
      const tv = parseFloat(new URLSearchParams(location.search).get('top'));
      this.topViewH = Number.isNaN(tv) ? 0 : tv;
    }
    if (this.topViewH > 0) {
      this.camera.position.set(car.position.x + 1, car.position.y + this.topViewH, car.position.z);
      this.camera.lookAt(car.position);
      this.camera.updateProjectionMatrix();
      return;
    }
    let lookAt;
    if (this.fpView) {
      // 1인칭(운전석 뷰): 지연 없이 차에 고정 — 카메라 랙이 있으면 멀미난다.
      // 좌핸들 운전석 = 차 로컬 +X(왼쪽) 오프셋. cockpit.js의 DX와 맞춘다.
      const h = this.car.heading;
      const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
      const leftV = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)); // 로컬 +X
      this.camera.position.copy(car.position)
        .addScaledVector(fwd, 0.55)
        .addScaledVector(leftV, 0.45)
        .add(new THREE.Vector3(0, 1.42, 0));
      lookAt = this.camera.position.clone().addScaledVector(fwd, 40);
    } else {
      const back = new THREE.Vector3(
        -Math.sin(this.car.heading),
        0,
        -Math.cos(this.car.heading)
      );
      const target = car.position
        .clone()
        .addScaledVector(back, 11 + this.car.speed * 0.08)
        .add(new THREE.Vector3(0, 5.5, 0));
      if (snap) this.camera.position.copy(target);
      else this.camera.position.lerp(target, 0.08);
      lookAt = car.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    }

    // 속도감: 고속·부스터에서 시야각이 벌어지고 카메라가 미세하게 흔들림
    const speedRatio = Math.min(1, Math.abs(this.car.speed) / MAX_SPEED_ABS);
    const boosting = this.car.boostTimer > 0;
    const targetFov = BASE_FOV + speedRatio * speedRatio * 9 + (boosting ? 7 : 0);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 0.07);
    this.camera.updateProjectionMatrix();

    // 화면 흔들림은 '내 차 충돌' 때만 (속도·부스터 셰이크 제거)
    if (this.crashShake > 0) this.crashShake = Math.max(0, this.crashShake - 0.03);
    const shake = this.crashShake || 0;
    if (shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * shake;
    }

    this.camera.lookAt(lookAt);
  }

  // 시점 전환: 1인칭에선 차체 모델 대신 콕핏을 보여준다(헤드라이트는 group 소속이라 유지)
  setView(fp) {
    this.fpView = fp;
    if (this.car) this.car.model.visible = !fp;
    if (this.cockpit) this.cockpit.group.visible = fp;
  }

  // 콕핏 갱신: 핸들 조향 연동 + 계기판 속도 + 후방 미러 렌더타깃
  updateCockpit(dt) {
    const c = this.cockpit;
    if (!c || !this.fpView) return;
    const steer = (this.input.left ? 1 : 0) - (this.input.right ? 1 : 0);
    // 좌조향 = 운전자 시점 반시계 = +Z 축 기준 시계(-) 회전 (x=칼럼 기울기는 고정)
    if (c.wheelSpin) c.wheelSpin.rotation.z = THREE.MathUtils.lerp(
      c.wheelSpin.rotation.z, -steer * 1.5, Math.min(1, 10 * dt));
    c.group.rotation.z = this.car.roll * 0.5; // 차체 롤을 실내에도 은은하게
    this._clusterT = (this._clusterT || 0) + dt;
    if (this._clusterT > 0.15) { // 캔버스 갱신은 ~6Hz면 충분
      this._clusterT = 0;
      c.drawCluster(this.car.speedKmh);
    }
    // 후방 미러: 격프레임으로 후방 카메라를 렌더타깃에 그린다.
    // 콕핏 자신이 거울에 비치면 안 되므로 렌더 동안만 숨긴다.
    this._mirrorFlip = !this._mirrorFlip;
    if (this._mirrorFlip) {
      const h = this.car.heading;
      const fx = Math.sin(h), fz = Math.cos(h);
      const p = this.car.group.position;
      c.rearCam.position.set(p.x - fx * 0.5, p.y + 1.55, p.z - fz * 0.5);
      c.rearCam.lookAt(p.x - fx * 45, p.y + 0.8, p.z - fz * 45);
      c.group.visible = false;
      this.renderer.setRenderTarget(c.rt);
      this.renderer.render(this.scene, c.rearCam);
      this.renderer.setRenderTarget(null);
      c.group.visible = true;
    }
  }

  // 풀링된 실광원을 차에서 가장 가까운 가로등 3개에 배치.
  // 매 프레임 map+sort 할당 대신 단일 패스 top-3 선택(GC 스터터 방지).
  updateLampLights() {
    if (!this.lampHeads.length) return;
    const pos = this.car.group.position;
    let i0 = -1, i1 = -1, i2 = -1, d0 = Infinity, d1 = Infinity, d2 = Infinity;
    for (let i = 0; i < this.lampHeads.length; i++) {
      const d = this.lampHeads[i].distanceToSquared(pos);
      if (d < d0) { d2 = d1; i2 = i1; d1 = d0; i1 = i0; d0 = d; i0 = i; }
      else if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = i; }
      else if (d < d2) { d2 = d; i2 = i; }
    }
    const idxs = [i0, i1, i2], dsqs = [d0, d1, d2];
    // 실광원은 3개만 가장 가까운 가로등으로 이동하되, 거리로 세기를 페이드해
    // '가까이 가면 툭 켜지는' 팝인을 없앤다(재배치는 먼 경계에서 세기≈0일 때 일어남).
    for (let i = 0; i < this.lampLights.length; i++) {
      const L = this.lampLights[i];
      if (i < idxs.length && idxs[i] >= 0) {
        L.position.copy(this.lampHeads[idxs[i]]);
        const dist = Math.sqrt(dsqs[i]);
        const t = THREE.MathUtils.clamp((30 - dist) / (30 - 7), 0, 1);
        L.intensity = 190 * t * t * (3 - 2 * t); // smoothstep 페이드
      } else {
        L.intensity = 0;
      }
    }
  }

  // 태양(그림자 카메라)이 차량을 따라다니며 주변에만 고해상도 그림자를 드리움
  updateSun() {
    const pos = this.car.group.position;
    this.sun.position.copy(pos).addScaledVector(this.sunDir, 280);
    this.sun.target.position.copy(pos);
    this.sun.target.updateMatrixWorld();
    // 하늘 돔(별·달)은 카메라를 따라가 무한히 먼 것처럼 보이게 (시차 제거)
    if (this.skyDome) this.skyDome.position.copy(this.camera.position);
  }

  // 부스터 불꽃 / 드리프트 스모크
  emitDriveParticles() {
    const car = this.car;
    const back = new THREE.Vector3(-Math.sin(car.heading), 0, -Math.cos(car.heading));
    const rear = car.group.position.clone().addScaledVector(back, 2.4);
    rear.y = car.group.position.y + 0.7;

    if (car.boostTimer > 0) {
      for (let i = 0; i < 4; i++) {
        const jitter = new THREE.Vector3(
          (Math.random() - 0.5) * 1.2, Math.random() * 0.5, (Math.random() - 0.5) * 1.2
        );
        const vel = back.clone().multiplyScalar(14 + Math.random() * 8).add(jitter.multiplyScalar(4));
        const color = { r: 1.0, g: 0.45 + Math.random() * 0.35, b: 0.12 };
        this.particles.emit(rear.clone().add(jitter), vel, color, 0.4 + Math.random() * 0.25);
      }
    }
    const steering = this.input.left || this.input.right;
    if (this.input.drift && steering && Math.abs(car.speed) > 18) {
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;
        const left = new THREE.Vector3(-back.z, 0, back.x);
        const wheel = rear.clone().addScaledVector(left, side * 1.1);
        wheel.y = car.group.position.y + 0.35;
        const vel = back.clone().multiplyScalar(5).add(new THREE.Vector3(0, 1.8 + Math.random(), 0));
        const g = 0.5 + Math.random() * 0.2;
        this.particles.emit(wheel, vel, { r: g, g, b: g }, 0.6 + Math.random() * 0.3);
      }
    }
  }

  // 목적지(결승선) 도착 → 완주. 도로 끝 단면이 보이기 전에 끝낸다.
  checkFinish() {
    if (this.finished) return;
    if (this.currentSampleIdx >= this.samples.length - 10) {
      this.finished = true;
      this.finish();
    }
  }

  finish() {
    this.running = false;
    sounds.finish();
    this.ui.onFinish({
      totalTime: this.raceTime,
      maxSpeed: this.maxSpeed,
      avgSpeed: this.raceTime > 0 ? (this.totalDist / this.raceTime) * 3.6 : 0,
    });
  }

  loop() {
    if (this.disposed) return;
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.running) {
      this.raceTime += dt;
      if (this.autoSteer) {
        // 우측 차로 중앙을 겨냥 (중앙선에서 +left 방향으로 laneCenter만큼 오프셋)
        const n = this.samples.length;
        const as = this.samples[Math.min(n - 1, this.currentSampleIdx + 18)];
        const ahead = as.pos.clone().addScaledVector(as.left, this.laneCenter);
        const desired = Math.atan2(
          ahead.x - this.car.group.position.x,
          ahead.z - this.car.group.position.z
        );
        let diff = desired - this.car.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.input.left = diff > 0.05;
        this.input.right = diff < -0.05;
      }
      // ── 물리: 힘 적용(플레이어+대향차) → 스텝 → 클램프/동기화 ──
      const playerS = this.traffic ? this.traffic.arcAtIndex(this.currentSampleIdx) : 0;
      this.car.update(dt, this.input);            // 플레이어 구동/조향 힘
      if (this.traffic) {
        // 플레이어의 차선 내 횡위치·속도 — 트래픽이 플레이어를 앞차로 취급
        const psmp = this.samples[this.currentSampleIdx];
        const plat = (this.car.body.position.x - psmp.pos.x) * psmp.left.x
          + (this.car.body.position.z - psmp.pos.z) * psmp.left.z;
        this.traffic.control(dt, playerS, plat, this.car.speed);
      }
      this.world.step(1 / 60, dt, 3);             // 강체 적분(충돌 해결)

      // 플레이어: 도로 폭 안으로 클램프(중앙 넘기 가능, 가장자리만 배리어) + 동기화.
      // 졸음쉼터·분기 진출 구간에선 우측 한계를 넓혀 진입 가능.
      this.car.sync();
      if (!this.onBranch) {
        this.findNearestSample();
        const di = Math.abs(this.currentSampleIdx - this.restIdx); // 개방 트랙: 절대 거리
        // 쉼터 본체는 전체 폭, 램프 구간은 도로 쪽으로 선형 테이퍼(스무스 진입/퇴출)
        let maxRight = this.laneMax;
        if (di < this.restSpan) {
          maxRight = this.restOuter;
        } else if (di < this.restRampSpan) {
          const t = (di - this.restSpan) / (this.restRampSpan - this.restSpan);
          maxRight = this.restOuter + (this.laneMax - this.restOuter) * t;
        }
        // 분기 진출 창: 우측을 열고, 분기 샘플이 본선보다 가까워지면 분기 모드 전환
        if (this.branch) {
          const bofs = this.currentSampleIdx - this.branch.exitIdx;
          if (bofs > -Math.round(15 / this.segLen) && bofs < Math.round(70 / this.segLen)) {
            maxRight = Math.max(maxRight, 30);
            const bres = this.nearestSampleOf(this.branch.samples, this.branchIdx, 90);
            this.branchIdx = bres.idx;
            const ms = this.samples[this.currentSampleIdx];
            const mDist = Math.hypot(
              this.car.body.position.x - ms.pos.x, this.car.body.position.z - ms.pos.z);
            if (bres.idx > 4 && bres.dist < mDist - 0.6) this.onBranch = true;
          } else {
            this.branchIdx = 0; // 진출 창 밖 — 다음 접근을 위해 리셋
          }
        }
        if (!this.onBranch) {
          clampToRoad(this.car.body, this.samples[this.currentSampleIdx], -this.laneMax, maxRight);
        }
      }
      if (this.onBranch) {
        // 분기 주행: 분기 샘플 기준 클램프 + 고도 추종(물리는 XZ 평면이라 y는 수동)
        const bres = this.nearestSampleOf(this.branch.samples, this.branchIdx, 60);
        this.branchIdx = bres.idx;
        const bs = this.branch.samples[this.branchIdx];
        const bHalf = this.branch.width / 2 - 1.1;
        clampToRoad(this.car.body, bs, -bHalf, bHalf);
        this.car.body.position.y += (bs.pos.y - this.car.body.position.y) * Math.min(1, 10 * dt);
        // 올림픽대로 종점 도착 = 완주 (재합류 없음 — 대체 목적지)
        if (!this.finished && this.branchIdx >= this.branch.samples.length - 30) {
          this.finished = true;
          this.finish();
        }
      }
      this.car.sync();
      if (this.traffic) this.traffic.postStep(this.laneMax);
      this.onRoad = true;

      // 니어미스 칼치기: 아슬아슬하게 스치면 부스터 게이지 충전
      if (this.traffic) {
        this.traffic.collectNearMisses(this.car.group.position,
          (minDist, dir, near, collide) => this.onNearMiss(minDist, dir, near, collide));
      }
      if (this.flash) {
        this.flash.t -= dt;
        if (this.flash.t <= 0) this.flash = null;
      }

      // 평균속도: 전진 거리만 누적(후진·정차는 손해)
      this.totalDist += Math.max(0, this.car.speed) * dt;

      this.maxSpeed = Math.max(this.maxSpeed, this.car.speedKmh);
      this.emitDriveParticles();
      this.checkFinish();

      // 진행률: 분기 주행 중엔 진출점→100%(올림픽대로 종점) 구간을 분기 진척도로 보간
      const nAll = this.samples.length - 1;
      const hudProgress = this.onBranch && this.branch
        ? THREE.MathUtils.lerp(
            this.branch.exitIdx / nAll, 1,
            this.branchIdx / (this.branch.samples.length - 30))
        : this.currentSampleIdx / nAll;
      this.ui.onHud({
        speed: this.car.speedKmh,
        progress: hudProgress,
        time: this.raceTime,
        avg: this.raceTime > 1 ? (this.totalDist / this.raceTime) * 3.6 : 0,
        boosting: this.car.boostTimer > 0,
        boostGauge: this.boostGauge,
        flash: this.flash,
      });
    }

    this.worldTime += dt;
    this.envUpdate?.(this.worldTime, dt);
    this.skyLife?.update(this.worldTime, dt);
    this.particles.update(dt);
    this.updateCamera();
    this.updateCockpit(dt);
    this.updateSun();
    this.updateLampLights();
    if (this.showStats) this.renderer.info.reset();
    this.composer.render();

    if (this.showStats) {
      const r = this.renderer.info.render;
      const el = document.querySelector('.controls-hint');
      if (el) el.textContent = `draw calls: ${r.calls} · tris: ${(r.triangles / 1000).toFixed(0)}k`;
    }
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('resize', this.onResize);
    this.traffic?.dispose();
    this.cockpit?.rt.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}
