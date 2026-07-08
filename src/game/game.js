// 게임 루프: 씬 구성, 주행, 랩/점수, 추억 근접 팝업

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateTrack, buildRoadMesh, buildStartLine } from '../map/trackGenerator.js';
import { ParticleSystem } from './particles.js';
import { buildEnvironment } from '../map/decorations.js';
import {
  placePhotoGates,
  placeHolograms,
  animatePhotoObjects,
} from '../map/photoObjects.js';
import { Car } from './car.js';
import { sounds } from './sounds.js';
import { createRng } from '../utils/rng.js';

const TOTAL_LAPS = 3;
const GATE_SLOWMO = 0.5;        // 게이트 통과 시 시간 배율 (사진을 올려다볼 여유)
const GATE_SLOWMO_DURATION = 1.1; // 슬로모션 지속(실제 초)
const BASE_FOV = 68;
const MAX_SPEED_ABS = 36;       // car.js MAX_SPEED와 동일 (속도감 연출 기준)

// 사진 팔레트를 야간 무드로 변환 (색조는 남기고 어둡게)
function nightify(p) {
  const mix = (c, target, t) => new THREE.Color(c).lerp(new THREE.Color(target), t).getHex();
  return {
    ...p,
    skyTop: mix(p.skyTop, 0x04060f, 0.88),
    skyHorizon: mix(p.skyHorizon, 0x141b38, 0.75),
    fog: mix(p.fog, 0x0a0d1c, 0.85),
    ground: mix(p.ground, 0x05060c, 0.8),
    isNight: true,
  };
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
  // photos: [{thumbUrl, textureUrl, memo, analysis}], palette: buildPalette 결과
  constructor(container, photos, palette, ui) {
    this.container = container;
    this.photos = photos;
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
    this.timeScale = 1;
    this.slowmoRemaining = 0;
  }

  build(seed) {
    const rng = createRng(seed);
    this.palette = nightify(this.palette);

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
    // 야간: 안개를 당겨 원경이 어둠에 묻히게
    this.scene.fog = new THREE.Fog(this.palette.fog, 130, 800);

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
    this.scene.add(makeSky(this.palette));

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
    this.scene.add(buildStartLine(track.samples, track.width));
    const env = buildEnvironment(this.scene, rng, track.samples, this.palette, track.width);
    this.lampHeads = env.lampHeads;
    // 실제 광원은 3개만 풀링: 매 프레임 차에서 가장 가까운 가로등 3개로 이동
    this.lampLights = [];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffdfae, 170, 32, 1.9);
      this.scene.add(light);
      this.lampLights.push(light);
    }
    this.gates = placePhotoGates(this.scene, this.photos, track.samples, rng, track.width);
    this.holograms = placeHolograms(this.scene, this.photos, track.samples, rng);

    // 차량: 출발선에서 트랙 진행 방향으로
    const s0 = this.samples[0];
    this.car = new Car(this.palette.accents[0]);
    this.car.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const heading = Math.atan2(s0.tangent.x, s0.tangent.z);
    this.car.placeAt(s0.pos.clone(), heading); // 데크 높이 그대로
    this.scene.add(this.car.group);

    // 야간 헤드라이트 (차와 함께 이동하는 스포트라이트)
    const headlight = new THREE.SpotLight(0xffedc4, 1000, 85, 0.44, 0.5, 1.7);
    headlight.position.set(0, 2.0, 1.5);
    headlight.target.position.set(0, -1.5, 32);
    this.car.group.add(headlight, headlight.target);

    this.currentSampleIdx = 0;
    this.prevProgress = 0;
    this.prevGateSampleIdx = 0;

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
    const params = new URLSearchParams(location.search);
    if (params.get('autodrive') === '1') {
      this.input.forward = true;
      this.autoSteer = true;
    }
    // 개발·검증용: 시작 직후 플래시백 강제 발동 (?flashtest=1)
    if (params.get('flashtest') === '1' && this.gates.length) {
      setTimeout(() => this.onGateCrossed(this.gates[0]), 1200);
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

  // 게이트 통과 판정: 이번 프레임에 전진한 샘플 구간 안에 게이트가 있는지 검사
  checkGates() {
    const n = this.samples.length;
    const cur = this.currentSampleIdx;
    const advanced = (cur - this.prevGateSampleIdx + n) % n;
    // 순간이동 수준(랩 경계 오차 등)은 무시
    if (advanced > 0 && advanced < 80) {
      for (const g of this.gates) {
        const rel = (g.sampleIdx - this.prevGateSampleIdx + n) % n;
        if (rel > 0 && rel <= advanced) this.onGateCrossed(g);
      }
    }
    this.prevGateSampleIdx = cur;
  }

  onGateCrossed(gate) {
    if (!gate.flashed) {
      // 첫 만남: 짧은 슬로모션 + 감성 차임 (연출은 게이트 자체가 담당)
      gate.flashed = true;
      this.score += 25;
      this.slowmoRemaining = GATE_SLOWMO_DURATION;
      sounds.memory();
    } else {
      // 이후 랩: 가벼운 차임 + 소량 점수만
      this.score += 5;
      sounds.collect();
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
      memoriesSeen: this.gates.filter((g) => g.flashed).length,
      totalMemories: this.gates.length,
    });
  }

  loop() {
    if (this.disposed) return;
    requestAnimationFrame(() => this.loop());
    const rawDt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    // 게이트 슬로모션: 시간 배율을 부드럽게 전환
    if (this.slowmoRemaining > 0) this.slowmoRemaining -= rawDt;
    const targetScale = this.slowmoRemaining > 0 ? GATE_SLOWMO : 1;
    this.timeScale = THREE.MathUtils.lerp(this.timeScale, targetScale, Math.min(1, rawDt * 8));
    const dt = rawDt * this.timeScale;

    if (this.running) {
      this.raceTime += dt;
      if (this.autoSteer) {
        const n = this.samples.length;
        const ahead = this.samples[(this.currentSampleIdx + 18) % n].pos;
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

      // 이동 후 측면 위치 계산 → 배리어 밖으로 못 나가게 하드 클램프 (벽을 따라 미끄러짐)
      this.findNearestSample();
      const near = this.samples[this.currentSampleIdx];
      const carPos = this.car.group.position;
      const lateral =
        (carPos.x - near.pos.x) * near.left.x + (carPos.z - near.pos.z) * near.left.z;
      const limit = this.trackWidth / 2 + 0.6;
      if (Math.abs(lateral) > limit) {
        const clamped = THREE.MathUtils.clamp(lateral, -limit, limit);
        carPos.addScaledVector(near.left, clamped - lateral);
        this.car.speed *= 0.985; // 벽 마찰
      }
      this.onRoad = Math.abs(lateral) < this.trackWidth / 2 + 1;

      this.emitDriveParticles();
      this.checkGates();
      this.checkLap();

      this.ui.onHud({
        speed: this.car.speedKmh,
        lap: Math.min(this.lap, TOTAL_LAPS),
        totalLaps: TOTAL_LAPS,
        time: this.raceTime,
        score: this.score,
        boosting: this.car.boostTimer > 0,
        memoriesSeen: this.gates.filter((g) => g.flashed).length,
        totalMemories: this.gates.length,
      });
    }

    animatePhotoObjects(this.holograms, time);
    this.particles.update(rawDt);
    this.updateCamera();
    this.updateSun();
    this.updateLampLights();
    this.composer.render();
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
