// 게임 루프: 씬 구성, 주행, 랩/점수, 추억 근접 팝업

import * as THREE from 'three';
import { generateTrack, buildRoadMesh, buildStartLine } from '../map/trackGenerator.js';
import { scatterDecorations } from '../map/decorations.js';
import {
  placePhotoFrames,
  placeHolograms,
  placeItems,
  animatePhotoObjects,
} from '../map/photoObjects.js';
import { Car } from './car.js';
import { sounds } from './sounds.js';
import { createRng } from '../utils/rng.js';

const TOTAL_LAPS = 3;
const MEMORY_RADIUS = 24;   // 추억 팝업 근접 거리 (명세 3.2.1)
const ITEM_RADIUS = 3.2;

function makeSky(palette) {
  const geo = new THREE.SphereGeometry(1600, 24, 16);
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
    this.ui = ui; // { onHud, onMemory, onMemoryHide, onLap, onFinish, onCountdown, onBoost }

    this.running = false;
    this.disposed = false;
    this.input = { forward: false, backward: false, left: false, right: false, drift: false };
    this.clock = new THREE.Clock();

    this.score = 0;
    this.lap = 1;
    this.lapStart = 0;
    this.bestLap = Infinity;
    this.raceTime = 0;
    this.memoriesSeen = new Set();
    this.activeMemory = null;
    this.memoryHideAt = 0;
  }

  build(seed) {
    const rng = createRng(seed);

    // 렌더러/씬
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(this.palette.fog, 250, 1300);

    this.camera = new THREE.PerspectiveCamera(
      68,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      3000
    );

    // 조명 (어두운 사진 세트면 노을 무드)
    const ambient = new THREE.AmbientLight(0xffffff, this.palette.isDusk ? 0.55 : 0.75);
    const sun = new THREE.DirectionalLight(
      this.palette.isDusk ? 0xffb27a : 0xffffff,
      this.palette.isDusk ? 0.9 : 1.1
    );
    sun.position.set(180, 260, 120);
    this.scene.add(ambient, sun);
    this.scene.add(makeSky(this.palette));

    // 트랙 + 장식 + 추억 오브젝트
    const track = generateTrack(rng);
    this.samples = track.samples;
    this.trackWidth = track.width;
    this.scene.add(buildRoadMesh(track.samples, track.width));
    this.scene.add(buildStartLine(track.samples, track.width));
    scatterDecorations(this.scene, rng, track.samples, this.palette);
    this.frames = placePhotoFrames(this.scene, this.photos, track.samples, rng);
    this.holograms = placeHolograms(this.scene, this.photos, track.samples, rng);
    this.items = placeItems(this.scene, track.samples, rng, this.palette);

    // 차량: 출발선에서 트랙 진행 방향으로
    const s0 = this.samples[0];
    this.car = new Car(this.palette.accents[0]);
    const heading = Math.atan2(s0.tangent.x, s0.tangent.z);
    this.car.placeAt(s0.pos.clone().setY(0), heading);
    this.scene.add(this.car.group);

    this.currentSampleIdx = 0;
    this.prevProgress = 0;

    this.bindInput();
    this.onResize = () => {
      if (this.disposed) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', this.onResize);

    // 첫 프레임 렌더 (카운트다운 배경)
    this.updateCamera(true);
    this.renderer.render(this.scene, this.camera);
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
    const lookAt = car.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    this.camera.lookAt(lookAt);
  }

  checkItems() {
    const pos = this.car.group.position;
    for (const it of this.items) {
      if (it.collected) continue;
      if (pos.distanceTo(it.mesh.position) < ITEM_RADIUS) {
        it.collected = true;
        it.mesh.visible = false;
        this.score += it.points;
        if (it.isBoost) {
          this.car.boost(2.2);
          this.ui.onBoost();
          sounds.boost();
        } else {
          sounds.collect();
        }
      }
    }
  }

  checkMemories(now) {
    const pos = this.car.group.position;
    let nearest = null;
    let nearestDist = MEMORY_RADIUS;
    for (const f of this.frames) {
      const d = pos.distanceTo(f.position);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = f;
      }
    }
    if (nearest && nearest !== this.activeMemory) {
      this.activeMemory = nearest;
      if (!this.memoriesSeen.has(nearest.photo.id)) {
        this.memoriesSeen.add(nearest.photo.id);
        this.score += 5;
        sounds.memory();
      }
      this.ui.onMemory(nearest.photo, nearest.label);
      this.memoryHideAt = now + 2.5;
    } else if (nearest) {
      this.memoryHideAt = now + 2.5;
    } else if (this.activeMemory && now > this.memoryHideAt) {
      this.activeMemory = null;
      this.ui.onMemoryHide();
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
      memoriesSeen: this.memoriesSeen.size,
      totalMemories: new Set(this.frames.map((f) => f.photo.id)).size,
    });
  }

  loop() {
    if (this.disposed) return;
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

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
      const { dist } = this.findNearestSample();
      const onRoad = dist < this.trackWidth / 2 + 1.5;
      this.car.update(dt, this.input, onRoad);
      this.checkItems();
      this.checkMemories(time);
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

    animatePhotoObjects(this.holograms, this.items, time);
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('resize', this.onResize);
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}
