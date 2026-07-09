// 게임 루프: 씬 구성, 주행, 랩/점수, 추억 근접 팝업

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateTrack, buildRoadMesh, buildStartLine, buildMedian, MEDIAN_HALF } from '../map/trackGenerator.js';
import { ParticleSystem } from './particles.js';
import { buildEnvironment } from '../map/decorations.js';
import { Car } from './car.js';
import { sounds } from './sounds.js';
import { createRng } from '../utils/rng.js';

const TOTAL_LAPS = 3;
const BASE_FOV = 68;
const MAX_SPEED_ABS = 36;       // car.js MAX_SPEED와 동일 (속도감 연출 기준)

// 별 필드: 상반구에 랜덤 분포, 밝기·색온도(푸름/노람) 배리에이션
function makeStars(count = 900) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const R = 1500;
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

  group.position.copy(dir).multiplyScalar(1420);
  group.lookAt(0, 0, 0);
  return group;
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

function makeSky(palette, radius = 1600) {
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor: { value: new THREE.Color(palette.skyTop) },
      bottomColor: { value: new THREE.Color(palette.skyHorizon) },
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
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y * 0.5 + 0.5;
        gl_FragColor = vec4(mix(bottomColor, topColor, pow(h, 0.8)), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

export class Game {
  // palette: nightCityPalette 결과
  constructor(container, palette, ui) {
    this.container = container;
    this.palette = palette;
    this.ui = ui; // { onHud, onLap, onFinish, onCountdown, onBoost }

    this.running = false;
    this.disposed = false;
    this.input = { forward: false, backward: false, left: false, right: false, drift: false };
    this.clock = new THREE.Clock();

    this.score = 0;
    this.lap = 1;
    this.lapStart = 0;
    this.bestLap = Infinity;
    this.raceTime = 0;
  }

  build(seed) {
    const rng = createRng(seed);

    // 렌더러/씬
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
      3000
    );

    // 조명: 하늘/지면 색을 반영한 헤미스피어 + 그림자 태양광
    // 야간: 은은한 도시광(헤미) + 달빛(방향광, 그림자)
    const hemi = new THREE.HemisphereLight(this.palette.skyHorizon, 0x0a0c16, 0.32);
    const sun = new THREE.DirectionalLight(0xaabdf5, 0.7);
    this.sunDir = new THREE.Vector3(0.5, 0.72, 0.34).normalize();
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
    this.skyDome.add(makeSky(this.palette));
    this.skyDome.add(makeStars());
    this.skyDome.add(makeMoon(this.sunDir));
    this.scene.add(this.skyDome);

    // 하늘을 환경맵으로 구워 젖은 노면·차체에 은은한 시트(sheen) 반사
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(makeSky(this.palette, 50));
    this.scene.environment = pmrem.fromScene(envScene, 0.05, 0.1, 100).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();

    // 포스트프로세싱: bloom(빛 번짐) + 비네트
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.container.clientWidth, this.container.clientHeight),
      0.38, 0.45, 0.72 // 야간: 광원만 은은하게 번지게 (과노출 방지)
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new ShaderPass(VignetteShader));
    this.composer.addPass(new OutputPass());

    this.particles = new ParticleSystem(this.scene);

    // 트랙 + 장식 + 추억 오브젝트
    const track = generateTrack(rng);
    this.samples = track.samples;
    this.trackWidth = track.width;
    this.scene.add(buildRoadMesh(track.samples, track.width));
    this.scene.add(buildMedian(track.samples));
    this.scene.add(buildStartLine(track.samples, track.width));
    // 우측 통행: 주행 가능한 측면 범위(중앙분리대 ~ 우측 배리어), lateral<0이 우측
    this.laneMin = MEDIAN_HALF + 1.4;               // 중앙분리대에서 최소 이격
    this.laneMax = track.width / 2 - 1.2;           // 우측 갓길 직전
    this.laneCenter = (this.laneMin + this.laneMax) / 2;
    const env = buildEnvironment(this.scene, rng, track.samples, this.palette, track.width);
    this.lampHeads = env.lampHeads;
    // 실제 광원은 3개만 풀링: 매 프레임 차에서 가장 가까운 가로등 3개로 이동
    this.lampLights = [];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffdfae, 170, 32, 1.9);
      this.scene.add(light);
      this.lampLights.push(light);
    }

    // 차량: 출발선 우측 차로에서 트랙 진행 방향으로 (lateral<0 = 우측)
    const s0 = this.samples[0];
    this.car = new Car(this.palette.accents[0]);
    this.car.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const heading = Math.atan2(s0.tangent.x, s0.tangent.z);
    const startPos = s0.pos.clone().addScaledVector(s0.left, -this.laneCenter); // 우측 차로
    this.car.placeAt(startPos, heading);
    this.scene.add(this.car.group);

    // 야간 헤드라이트 (차와 함께 이동하는 스포트라이트)
    const headlight = new THREE.SpotLight(0xffedc4, 1000, 85, 0.44, 0.5, 1.7);
    headlight.position.set(0, 2.0, 1.5);
    headlight.target.position.set(0, -1.5, 32);
    this.car.group.add(headlight, headlight.target);

    this.currentSampleIdx = 0;
    this.prevProgress = 0;

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
    this.lapStart = 0;
    this.raceTime = 0;
    this.loop();
  }

  // 트랙 위 최근접 샘플 탐색 (인접 구간만 훑는 O(1) 윈도우 탐색)
  findNearestSample() {
    const n = this.samples.length;
    const pos = this.car.group.position;
    let bestIdx = this.currentSampleIdx;
    let bestDist = Infinity;
    for (let off = -40; off <= 40; off++) {
      const i = (this.currentSampleIdx + off + n) % n;
      const d = pos.distanceToSquared(this.samples[i].pos);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    this.currentSampleIdx = bestIdx;
    return { idx: bestIdx, dist: Math.sqrt(bestDist) };
  }

  updateCamera(snap = false) {
    const car = this.car.group;
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

    // 속도감: 고속·부스터에서 시야각이 벌어지고 카메라가 미세하게 흔들림
    const speedRatio = Math.min(1, Math.abs(this.car.speed) / MAX_SPEED_ABS);
    const boosting = this.car.boostTimer > 0;
    const targetFov = BASE_FOV + speedRatio * speedRatio * 9 + (boosting ? 7 : 0);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 0.07);
    this.camera.updateProjectionMatrix();

    const shake = speedRatio * speedRatio * 0.09 + (boosting ? 0.16 : 0);
    if (shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * shake;
    }

    const lookAt = car.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    this.camera.lookAt(lookAt);
  }

  // 풀링된 실광원을 차에서 가장 가까운 가로등 3개에 배치
  updateLampLights() {
    if (!this.lampHeads.length) return;
    const pos = this.car.group.position;
    const ranked = this.lampHeads
      .map((p) => ({ p, d: p.distanceToSquared(pos) }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.lampLights.length; i++) {
      this.lampLights[i].position.copy(ranked[i].p);
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

  checkLap() {
    const n = this.samples.length;
    const progress = this.currentSampleIdx / n;
    // 결승선 통과: 진행률이 끝(>0.9)에서 처음(<0.1)으로 넘어갈 때
    if (this.prevProgress > 0.9 && progress < 0.1) {
      const lapTime = this.raceTime - this.lapStart;
      this.lapStart = this.raceTime;
      if (lapTime < this.bestLap) this.bestLap = lapTime;
      if (this.lap >= TOTAL_LAPS) {
        this.finish();
        return;
      }
      this.lap++;
      sounds.lap();
      this.ui.onLap(this.lap);
    }
    // 역주행으로 결승선을 되돌아가면 랩은 그대로 (간이 처리)
    this.prevProgress = progress;
  }

  finish() {
    this.running = false;
    sounds.finish();
    this.ui.onFinish({
      totalTime: this.raceTime,
      bestLap: this.bestLap,
      score: this.score,
    });
  }

  loop() {
    if (this.disposed) return;
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.running) {
      this.raceTime += dt;
      if (this.autoSteer) {
        // 우측 차로 중앙을 겨냥 (중앙선에서 -left 방향으로 laneCenter만큼 오프셋)
        const n = this.samples.length;
        const as = this.samples[(this.currentSampleIdx + 18) % n];
        const ahead = as.pos.clone().addScaledVector(as.left, -this.laneCenter);
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
      this.car.update(dt, this.input, this.onRoad !== false);

      // 이동 후 측면 위치 → 우측 차로 밴드[-laneMax, -laneMin]로 하드 클램프
      // (중앙분리대와 우측 배리어 사이. 넘으면 벽을 따라 미끄러지며 감속)
      this.findNearestSample();
      const near = this.samples[this.currentSampleIdx];
      const carPos = this.car.group.position;
      const lateral =
        (carPos.x - near.pos.x) * near.left.x + (carPos.z - near.pos.z) * near.left.z;
      const clamped = THREE.MathUtils.clamp(lateral, -this.laneMax, -this.laneMin);
      if (clamped !== lateral) {
        carPos.addScaledVector(near.left, clamped - lateral);
        this.car.speed *= 0.985; // 벽/분리대 마찰
      }
      this.onRoad = true;

      this.emitDriveParticles();
      this.checkLap();

      this.ui.onHud({
        speed: this.car.speedKmh,
        lap: Math.min(this.lap, TOTAL_LAPS),
        totalLaps: TOTAL_LAPS,
        time: this.raceTime,
        score: this.score,
        boosting: this.car.boostTimer > 0,
      });
    }

    this.particles.update(dt);
    this.updateCamera();
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
    this.composer?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}
