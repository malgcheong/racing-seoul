// 게임 본체: 씬 구성(트랙·분기·환경·차량), 주행 루프, 진행률/결과, 멀티플레이.
// 하늘 연출은 sky.js, 사운드는 sounds.js, AI 트래픽은 traffic.js로 분리.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateTrack, buildRoadMesh, buildMedian, buildStartLine, straightenTrackWindow, MEDIAN_HALF } from '../map/trackGenerator.js';
import { generateBranchRoute, buildBranchRoad } from '../map/branchRoad.js';
import { buildRoadArrows } from '../map/roadArrows.js';
import { TrafficSystem } from './traffic.js';
import { NetClient } from '../net/client.js';
import { RemoteCar } from './remoteCar.js';
import { Minimap } from './minimap.js';
import { ParticleSystem } from './particles.js';
import { Rain } from './rain.js';
import { buildEnvironment } from '../map/decorations.js';
import { buildRestArea } from '../map/restArea.js';
import { Car } from './car.js';
import { buildCockpit } from './cockpit.js';
import { createWorld, clampToRoad } from './physics.js';
import { sounds } from './sounds.js';
import { createRng } from '../utils/rng.js';
import { makeStars, makeMoon, makeSkyLife, makeSky, makeDuskSun, makeDuskClouds } from './sky.js';

const BASE_FOV = 68;
const MAX_SPEED_ABS = 36;       // car.js MAX_SPEED와 동일 (속도감 연출 기준)

// 품질 프리셋: 성능 지렛대 3종만 조절 —
//  dpr(픽셀비율, 화면 픽셀 수가 제곱으로 늘어 최대 비용) / 그림자맵 해상도 + 갱신 주기
//  (깊이 패스가 씬 전체 재렌더라 비쌈) / 트래픽 대수(실차 6~14k폴리).
//  bloom·비네트는 반해상도라 저렴해 프리셋에서 제외(무드 유지).
//  ※ traffic은 싱글에서만 프리셋 적용 — 멀티는 방장 스냅샷 인덱스 일치 위해 고정.
const QUALITY = {
  low:    { dpr: 1.0,  shadow: 1024, shadowEvery: 3, traffic: 6 },
  medium: { dpr: 1.25, shadow: 2048, shadowEvery: 2, traffic: 10 },
  high:   { dpr: 1.6,  shadow: 4096, shadowEvery: 1, traffic: 16 },
};
const MP_TRAFFIC = 10; // 멀티 고정 트래픽 대수

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

export class Game {
  // palette: nightCityPalette 결과
  constructor(container, palette, ui, opts = {}) {
    this.container = container;
    this.palette = palette;
    // ui 콜백: { onHud, onCountdown, onFinish, onFail, onStandings, onRematch, onRematchGo }
    this.ui = ui;
    this.carModel = opts.carModel || 'car7'; // 선택된 차량 에셋 이름
    // URL 파라미터 스냅샷 — 게임 생성 시점 기준으로 한 번만 파싱해 전역에서 재사용
    // (개발·검증 파라미터 목록은 README 격인 메모리/주석 참고: seed·at·branch·rest·
    //  cam·tod·wx·hard·traffic·dpr·stats·top·autodrive·tclose·room·host·name)
    const gq = this.params = new URLSearchParams(location.search);
    // 게임 설정(시작화면 토글 → opts, URL 파라미터가 있으면 우선: ?hard=0 ?traffic=0)
    this.hardMode = gq.get('hard') !== null ? gq.get('hard') !== '0' : (opts.hardMode ?? true);
    this.trafficOn = gq.get('traffic') !== null ? gq.get('traffic') !== '0' : (opts.traffic ?? true);

    // 품질 프리셋(시작화면 → opts.quality, URL ?q=low|medium|high|auto 우선).
    // 'auto'는 medium으로 시작해 첫 몇 초 FPS를 재고 자동 강등한다.
    const qParam = gq.get('q');
    const qPick = ['low', 'medium', 'high', 'auto'].includes(qParam) ? qParam
      : ['low', 'medium', 'high', 'auto'].includes(opts.quality) ? opts.quality : 'medium';
    this.autoQuality = qPick === 'auto';
    this.quality = QUALITY[this.autoQuality ? 'medium' : qPick];

    this.running = false;
    this.disposed = false;
    this.input = { forward: false, backward: false, left: false, right: false, drift: false, highBeam: false };
    this.clock = new THREE.Clock();

    this.raceTime = 0;
    this.totalDist = 0;   // 주행 거리(전진분) — 평균속도 산출용
    this.maxSpeed = 0;    // 최고 속도(km/h) — 결과 화면용
    this.finished = false;
    this.rematch = opts.rematch || null; // { net, ids, host } — 직전 판 소켓 인계
  }

  build(seed) {
    const rng = createRng(seed);

    // 렌더러/씬
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    // 성능: 고DPI에서 픽셀 수가 제곱으로 늘어 비용이 커짐. 품질 프리셋 dpr로 캡
    // (?dpr= 파라미터가 있으면 개발용으로 우선)
    const dprParam = parseFloat(this.params.get('dpr'));
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, Number.isFinite(dprParam) ? dprParam : this.quality.dpr));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // Soft 대비 저렴(야간이라 차이 미미)
    // 그림자 깊이 패스는 씬 전체를 한 번 더 그린다 — 격프레임 갱신으로 절반 절약.
    // (태양이 차를 따라가며 미세 이동하는 정도라 한 프레임 지연은 티가 안 남)
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this._shadowEvery = this.quality.shadowEvery; // N프레임마다 그림자 깊이 패스 갱신
    this._shadowTick = 0;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // 야간: 안개(원경 깊이감). 배경 산맥까지 바닥이 이어지고 산은 헤이즈에 녹아들도록.
    // 비 오는 밤은 헤이즈가 짙다
    this.scene.fog = this.palette.rain
      ? new THREE.Fog(this.palette.fog, 150, 2100)
      : new THREE.Fog(this.palette.fog, 220, 2800);

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
    sun.shadow.mapSize.set(this.quality.shadow, this.quality.shadow);
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
    } else if (!this.palette.rain) {
      this.skyDome.add(makeStars());
      this.skyDome.add(makeMoon(this.sunDir));
    } // 비 오는 밤: 흐린 하늘 — 별·달 없음
    if (!this.palette.rain) {
      this.skyLife = makeSkyLife(); // 비행기 점멸등 + 유성
      this.skyDome.add(this.skyLife.group);
    }
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
    this.rain = this.palette.rain ? new Rain(this.scene) : null;

    // 트랙 + 장식 + 추억 오브젝트 (편도 루트: 출발 → 강 다리 → 목적지)
    const track = generateTrack(rng);
    this.samples = track.samples;
    this.trackWidth = track.width;
    this.river = track.river;
    // 도로 메시는 쉼터 구간 직선화(아래) 이후에 생성한다
    // 우측 통행: 주행 가능한 측면 범위(중앙분리대 ~ 우측 배리어).
    // 왕복 8차선 — 플레이어·AI 트래픽은 우측 4차선, 좌측 4차선은 장식 대향 차량.
    // 차 반폭(~1.1)+여유 — 1차로 중심(lat 2.0)에 정상적으로 올라탈 수 있어야 한다
    this.laneMin = MEDIAN_HALF + 1.15;              // = 1.65, 분리대 연석에 안 닿는 한계
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
    // 비: 젖은 노면 — 매끈해져 가로등·네온이 길게 비친다 (밤 전용이라 과반사 없음)
    if (this.palette.rain) {
      roadMesh.material.roughness = 0.5;
      roadMesh.material.envMapIntensity = 0.85;
    }
    this.scene.add(roadMesh);
    // 왕복 8차선: 중앙분리대(뉴저지 방호벽+LED)가 대향 차로와 주행 차로를 가른다
    this.scene.add(buildMedian(track.samples));
    this.restIdx = restIdx;
    this.restOuter = 30;          // 졸음쉼터 구간에서 허용되는 우측 최대 이격(확장 플랫폼)
    this.restSpan = spanBody;     // 본체 구간 인덱스 반경
    this.restRampSpan = spanRamp; // 램프 끝까지의 반경 — 이 사이에서 허용 폭이 선형 테이퍼
    this.segLen = segLen;

    // 분기 루트: 다리 직후 우측 진출 램프. 노면·비주얼은 유지하되 사용자 결정으로
    // '폐쇄'(2026-07-16) — 진입을 막고 본선 직진만 유일한 결승 경로로 둔다.
    // (?branch=open 으로 개발 중 임시 개방 가능)
    this.branch = generateBranchRoute(track.samples, track.river, track.width);
    this.branchClosed = this.params.get('branch') !== 'open';
    this.onBranch = false;
    this.branchIdx = 0;
    // 진출차로 판정용: 본선 가장자리 lat(이 선을 넘어야 분기 진입으로 본다)
    this.branchEdgeLat = track.width / 2 - 0.25;
    this.branchWinN = this.branch ? Math.round(this.branch.approachLen / segLen) + 3 : 0;
    // push: 쉼터 구간은 건물을 없애지 않고 플랫폼(중심선 기준 ~32.5m) 뒤로 물려 세운다
    const gaps = [{ side: 1, idx: restIdx, halfSpan: spanRamp + 3, parapetSpan: spanRamp, push: 37 }];
    let branchCoarse = null;
    let branchGroup = null;
    if (this.branch) {
      branchGroup = buildBranchRoad(this.branch, track.samples, track.width, track.river, this.branchClosed);
      this.scene.add(branchGroup);
      // 올림픽대로 종점 = 대체 결승선 — 합류 후엔 강변도로 남행 반부만 달리므로 그 폭으로
      this.scene.add(buildStartLine(this.branch.samples, 7.2,
        this.branch.samples.length - 30));
      branchCoarse = this.branch.samples.filter((_, i) => i % 3 === 0).map((s) => s.pos);
      // 진출부: 진출차로(테이퍼 시작)부터 램프가 파라펫 라인을 벗어나는 지점까지만
      // 파라펫 개방 — 길게 열어두면 고어 뒤 데크 가장자리가 "벽 없는 낭떠러지"로 보인다
      gaps.push({
        side: 1, idx: this.branch.exitIdx - Math.round(41 / segLen),
        halfSpan: Math.round(93 / segLen), parapetSpan: Math.round(69 / segLen),
      });
    }
    // 발광 노면 화살표: 출발 직후·다리 서단 이후 주행 4개 차로 직진 유도 +
    // 분기 진출차로(테이퍼 완료~고어)엔 우측 굽음 화살표 3개
    {
      const spots = [];
      const laneLats = [0.5, 1.5, 2.5, 3.5].map((k) => (track.width / 8) * k);
      const straightAt = [this.startIdx + Math.round(130 / segLen)];
      for (let i = 0; i < nS; i++) {
        if (track.samples[i].pos.x < track.river.x0 - 140) { straightAt.push(i); break; }
      }
      for (const ai of straightAt) {
        if (ai < 4 || ai > nS - 30) continue;
        for (const lat of laneLats) spots.push({ i: ai, lat, bend: 0 });
      }
      if (this.branch) {
        const latX = this.branchEdgeLat + this.branch.laneW / 2 - 0.2;
        for (const back of [60, 35, 12]) {
          spots.push({ i: this.branch.exitIdx - Math.round(back / segLen), lat: latX, bend: 1 });
        }
      }
      this.scene.add(buildRoadArrows(track.samples, spots));
    }
    // 코스 미니맵 (HUD 오버레이 — 본선·분기·강·플레이어/상대 점)
    const hudEl = document.querySelector('#hud');
    if (hudEl) this.minimap = new Minimap(hudEl, track.samples, this.branch, track.river);

    const env = buildEnvironment(this.scene, rng, track.samples, this.palette, track.width,
      gaps, track.river, branchCoarse);
    buildRestArea(this.scene, track.samples, restIdx); // 졸음쉼터(우측 장식)
    // 분기 가로등 헤드도 실광원 풀에 합류 — 분기 주행 중에도 노면이 밝게 따라온다
    this.lampHeads = branchGroup?.userData.lampHeads.length
      ? env.lampHeads.concat(branchGroup.userData.lampHeads)
      : env.lampHeads;
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
    // 시점: 1인칭 콕핏뷰(기본) ↔ 3인칭 추격. C 키 토글, ?cam=chase 로 3인칭 시작
    this.cockpit = buildCockpit(this.carModel);
    this.car.group.add(this.cockpit.group);
    this.setView(this.params.get('cam') !== 'chase');
    // 차량 충돌: 임팩트 효과음(트래픽·원격 플레이어 공통, 쿨다운) + 하드모드 사고 판정
    this.car.body.addEventListener('collide', (e) => {
      const rel = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 8;
      const now = performance.now();
      if (rel > 2 && (!this._impactCd || now - this._impactCd > 250)) {
        this._impactCd = now;
        sounds.impact(Math.min(1, rel / 14));
      }
      if (e.body && e.body.__traffic) this.onCarCollide(e);
    });

    // 야간 헤드라이트 (차와 함께 이동하는 스포트라이트) — F키 상향등 시 증폭
    const headlight = new THREE.SpotLight(0xffedc4, 1000, 85, 0.44, 0.5, 1.7);
    headlight.position.set(0, 2.0, 1.5);
    headlight.target.position.set(0, -1.5, 32);
    this.car.group.add(headlight, headlight.target);
    this.headlight = headlight;
    this.headlightBase = { intensity: 1000, distance: 85, angle: 0.44 };

    // AI 트래픽(같은 방향): 왕복 8차선의 우측 4차선(플레이어 반부)만 사용.
    // 좌측 4차선의 대향 차량은 buildEnvironment의 장식 인스턴스가 담당(물리 없음 —
    // 중앙분리대 클램프로 플레이어가 접촉할 수 없다).
    // 멀티(?room=CODE[&host=1]): 서버는 중계만, 각 클라가 자기 물리 시뮬.
    // 트래픽은 방장 클라가 시뮬해 중계 → 게스트는 퍼펫(재생) 모드
    const mq = this.params;
    this.mpRoom = mq.get('room');
    this.mpHost = mq.get('host') === '1';
    // 재대결: 기존 소켓·방을 그대로 물려받는다 (재접속하면 방장 승계가 연쇄로 꼬임).
    // host는 URL이 아니라 승계까지 반영된 직전 게임의 최종 상태를 따른다
    if (this.rematch) {
      this.mpHost = !!this.rematch.host;
      this.mpIds = this.rematch.ids || [];
    }
    this.mpName = (mq.get('name') || '').slice(0, 8) || (this.mpHost ? '방장' : '상대');
    this.mpPeers = this.rematch ? Math.max(0, (this.rematch.ids || []).length - 1) : 0;
    this.mpStartAt = 0;
    this.remotes = new Map(); // peerId -> RemoteCar

    const laneW = track.width / 8; // 차선폭 4m
    this.traffic = !this.trafficOn ? null : new TrafficSystem(this.scene, this.samples, {
      world: this.world,
      laneCenters: [laneW * 0.5, laneW * 1.5, laneW * 2.5, laneW * 3.5], // +2,+6,+10,+14
      // 실차 트래픽(6~14k폴리/대)은 무겁다 — 품질 프리셋으로 대수 관리(싱글).
      // 멀티는 방장 스냅샷 배열 인덱스가 양쪽 일치해야 하므로 고정값.
      count: this.mpRoom ? MP_TRAFFIC : this.quality.traffic,
      river: track.river, // 다리 구간 정체(구간별 밀도감)용
      debugClose: this.params.get('tclose') === '1',
      puppet: !!this.mpRoom && !this.mpHost, // 게스트: 방장 스냅샷 재생
    });
    // 멀티: 원격 헤드라이트 슬롯 프리워밍 — 레이스 중 광원 수가 늘면
    // 모든 재질 셰이더가 재컴파일되며 크게 버벅인다(60fps 튜닝의 핵심)
    this.mpLightPool = [];
    if (this.mpRoom) {
      for (let i = 0; i < 3; i++) {
        const L = new THREE.SpotLight(0xffedc4, 0, 70, 0.4, 0.5, 1.7);
        this.scene.add(L, L.target);
        this.mpLightPool.push(L);
      }
    }
    if (this.mpRoom) this.setupNet();
    this.crashShake = 0;
    // 니어미스 칼치기 → 부스터 게이지 충전(점수 없음)
    this.boostGauge = 0;   // 0~1, 차면 부스터 발동
    this.flash = null;     // 중앙 팝업 { t, label, sub?, close? }

    this.currentSampleIdx = 0;

    // 개발·검증: ?rest=1 → 졸음쉼터 직전에서 시작
    if (this.params.get('rest') === '1') {
      const ri = Math.max(0, restIdx - Math.round(40 / segLen));
      const rs = track.samples[ri];
      this.currentSampleIdx = ri;
      this.car.placeAt(
        rs.pos.clone().addScaledVector(rs.left, this.laneCenter),
        Math.atan2(rs.tangent.x, rs.tangent.z)
      );
    }
    // 개발·검증: ?branch=1 → 분기 진출점 직전에서 시작 / ?branch=N(≥2) → 분기 샘플 N에서 시작
    const branchParam = this.params.get('branch');
    if (this.branch && branchParam === '1') {
      const bi = Math.max(0, this.branch.exitIdx - Math.round(160 / segLen)); // 테이퍼 시작 전
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
    const atParam = parseFloat(this.params.get('at'));
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
    this.showStats = this.params.get('stats') === '1';
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
        case 'KeyF': this.input.highBeam = down; break; // 상향등(누르는 동안) — 앞차 양보 요구
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

  // ── 멀티플레이: relay 이벤트 배선 ──
  setupNet() {
    // 재대결이면 직전 판의 소켓을 그대로 사용 — 방 나갔다 재입장하면
    // 서버 방장 승계·고스트 피어 레이스가 생긴다. 핸들러만 새로 덮어쓴다.
    if (this.rematch) {
      this.net = this.rematch.net;
    } else {
      this.net = new NetClient(`ws://${location.hostname}:8787`);
      this.net.join(this.mpRoom);
    }
    this.rmSet = new Set();  // 재대결 준비 완료한 피어 id
    this.rmSelf = false;
    this.net.on('peers', (m) => {
      this.mpPeers = Math.max(0, m.n - 1);
      this.mpIds = m.ids || []; // 방 로스터 — 출발 그리드 슬롯 결정용
    });
    this.net.on('left', (m) => {
      const r = this.remotes.get(m.id);
      if (r) {
        r.dispose();
        if (r.head) this.mpLightPool.push(r.head); // 광원 풀 반환
        this.remotes.delete(m.id);
      }
      this._rrLeft?.(m.id);      // 재대결 대기 중 퇴장 — 기다릴 대상에서 제외
      this.checkRematch();       // 남은 전원이 이미 준비 상태일 수 있다
      this._standingsDirty = true;
    });
    // 방장 지정/승계: 서버가 첫 입장자를 방장으로, 방장 퇴장 시 다음 피어를 지정.
    // 내가 새 방장이 되면 퍼펫 트래픽을 실제 AI 시뮬로 승격해 이어받는다
    this.net.on('host', (m) => {
      this.mpHostId = m.id;
      if (m.id !== this.net.id && this.mpHost) {
        // 서버 지정 방장이 따로 있음(내가 나중에 입장한 케이스) — 시뮬 주체 양보
        this.mpHost = false;
        this.traffic?.demote();
      }
      if (m.id === this.net.id && !this.mpHost) {
        this.mpHost = true;
        this.traffic?.promote();
        this.flash = { t: 3, label: '방장 승계', sub: '트래픽 시뮬을 이어받았습니다' };
        // 레이스 시작 전에 방장이 나간 경우 — 새 방장이 시작 신호를 대신 쏜다
        if (!this.mpStartAt && this._goResolve) {
          this.mpStartAt = this.net.serverNow() + 4000;
          const q = this.params;
          this.net.send({ t: 'go', at: this.mpStartAt, seed: q.get('seed'), tod: q.get('tod') });
          this._goResolve();
        }
      }
    });
    this.net.on('go', (m) => {
      this.mpStartAt = m.at;
      if (m.seed && String(m.seed) !== String(this.params.get('seed'))) {
        console.warn('[mp] 시드 불일치 — 호스트가 준 링크(?seed=..&room=..)로 접속해야 같은 맵');
      }
      this._goResolve?.();
    });
    this.net.on('s', (m) => {
      if (this.disposed) return; // 재대결 리빌드 중 구 게임 핸들러 잔류 방어
      let r = this.remotes.get(m._from);
      if (!r) {
        r = new RemoteCar(this.scene, this.world, m.c || 'car7', this.mpLightPool.pop() || null);
        this.remotes.set(m._from, r);
      }
      if (m.n) r.setName(m.n); // 이름표(최초 1회 생성)
      r.progress = m.pr || 0;  // 순위 계산용
      r.highBeam = !!m.b;      // 상향등 상태 → 원격 헤드라이트 증폭
      r.push({ x: m.p[0], y: m.p[1], z: m.p[2], h: m.h, v: m.v });
      if (this.finished) this._standingsDirty = true; // 결과 화면 순위표 라이브 갱신
    });
    this.net.on('tf', (m) => { if (!this.mpHost && this.traffic) this.traffic.applyNet(m.cars); });
    this.net.on('fin', (m) => {
      const r = this.remotes.get(m._from);
      if (r) { r.progress = 1.001; r.finished = true; r.finishTime = m.time; } // 완주자는 항상 상위
      const who = r?.name || '상대';
      this.flash = { t: 3.5, label: `${who} 완주!`, sub: `기록 ${m.time.toFixed(1)}초` };
      this._standingsDirty = true;
    });
    // 사고 리타이어 통지 — 순위표에 "사고 (진행률%)"로 남는다
    this.net.on('crash', (m) => {
      const r = this.remotes.get(m._from);
      if (r) { r.crashed = true; r.progress = m.pr ?? r.progress; }
      this.flash = { t: 3, label: `${r?.name || '상대'} 사고!`, sub: '리타이어' };
      this._standingsDirty = true;
    });
    // 재대결 준비 신호(결과 화면에서 재대결 버튼 클릭) — 전원 모이면 같은 방·시드로 재시작
    this.net.on('rm', (m) => {
      this.rmSet.add(m._from);
      this.checkRematch();
    });
  }

  // ── 순위표: 완주자(기록순) → 미완주자(진행률순). 나+원격 전원 포함 ──
  getStandings() {
    const rows = [{
      me: true,
      name: this.mpName,
      time: this.finishTime ?? null,
      crashed: !!this.failed,
      progress: this.lastProgress || 0,
    }];
    for (const r of this.remotes.values()) {
      rows.push({
        me: false,
        name: r.name || '상대',
        time: r.finishTime ?? null,
        crashed: !!r.crashed,
        progress: Math.min(r.progress || 0, 1),
      });
    }
    rows.sort((a, b) => {
      if (a.time !== null && b.time !== null) return a.time - b.time;
      if (a.time !== null) return -1;
      if (b.time !== null) return 1;
      return b.progress - a.progress;
    });
    return rows;
  }

  // ── 재대결: 결과 화면에서 전원이 준비되면 소켓을 인계해 같은 방·시드로 재시작 ──
  requestRematch() {
    if (!this.net || this.rmSelf) return;
    this.rmSelf = true;
    this.net.send({ t: 'rm' });
    this.checkRematch();
  }

  checkRematch() {
    if (!this.net || !this.finished || this.netHandoff) return;
    const roster = [...this.remotes.keys()];
    const ready = this.rmSet
      ? roster.filter((id) => this.rmSet.has(id)).length + (this.rmSelf ? 1 : 0)
      : 0;
    this.ui.onRematch?.({ ready, total: roster.length + 1 });
    if (this.rmSelf && roster.every((id) => this.rmSet.has(id))) {
      this.netHandoff = true; // dispose가 소켓을 닫지 않게 — 새 게임이 물려받는다
      this.ui.onRematchGo?.({
        net: this.net,
        ids: [this.net.id, ...roster],
        host: this.mpHost,
      });
    }
  }

  // 시작 동기화: 방장이 피어 입장을 기다렸다 서버시각 기준 GO 시점을 브로드캐스트.
  // 양쪽 모두 (GO − 카운트다운 2400ms) 시점까지 대기 후 동시에 카운트다운 진입.
  async mpAwaitStart() {
    if (this.rematch) {
      // ── 재대결 동기화: 각자 씬 리빌드 속도가 달라서, 준비된 클라가 'rr' 핑을
      // 반복 송신 → 방장이 전원 확인 후 go. (리빌드 중 host 승계·go는 main.js가
      // rematch 객체에 브릿지해 둔다 — 그 창에서 온 메시지는 구 게임 핸들러 몫이라)
      this.mpHost = !!this.rematch.host;
      if (this.rematch.goAt) this.mpStartAt = this.rematch.goAt;
      this.ui.onCountdown('재대결 준비중…');
      const need = new Set(this.mpIds.filter((id) => id !== this.net.id));
      const got = new Set();
      this.net.on('rr', (m) => got.add(m._from));
      this._rrLeft = (id) => need.delete(id);
      const ping = setInterval(() => { if (!this.mpStartAt) this.net.send({ t: 'rr' }); }, 400);
      const t0 = performance.now();
      const q = this.params;
      if (this.mpHost && !this.mpStartAt) {
        await new Promise((res) => {
          const iv = setInterval(() => {
            if (this.disposed || [...need].every((id) => got.has(id))
              || performance.now() - t0 > 30000) { clearInterval(iv); res(); }
          }, 120);
        });
        if (this.disposed) { clearInterval(ping); return; }
        this.mpStartAt = this.net.serverNow() + 4000;
        this.net.send({ t: 'go', at: this.mpStartAt, seed: q.get('seed'), tod: q.get('tod') });
      } else if (!this.mpStartAt) {
        await new Promise((res) => {
          this._goResolve = res;
          const iv = setInterval(() => {
            if (this.disposed || this.mpStartAt) { clearInterval(iv); res(); }
            // 방장이 리빌드 창에서 이탈한 극단 케이스 — 30초 후 스스로 출발 신호
            else if (performance.now() - t0 > 30000) {
              clearInterval(iv);
              this.mpStartAt = this.net.serverNow() + 4000;
              this.net.send({ t: 'go', at: this.mpStartAt, seed: q.get('seed'), tod: q.get('tod') });
              res();
            }
          }, 120);
        });
      }
      clearInterval(ping);
      if (this.disposed) return;
    } else if (this.mpHost) {
      this.ui.onCountdown(`상대 대기중… 방 코드 ${this.mpRoom}`);
      // 게스트가 로비에서 방을 발견→차량 선택→로딩까지 걸리는 시간 감안(90초 후 솔로 출발)
      const t0 = performance.now();
      await new Promise((res) => {
        const iv = setInterval(() => {
          if (this.mpPeers > 0 || performance.now() - t0 > 90000) { clearInterval(iv); res(); }
        }, 150);
      });
      this.mpStartAt = this.net.serverNow() + 4000;
      const q = this.params;
      this.net.send({ t: 'go', at: this.mpStartAt, seed: q.get('seed'), tod: q.get('tod') });
    } else {
      this.ui.onCountdown('호스트 대기중…');
      if (!this.mpStartAt) await new Promise((res) => { this._goResolve = res; });
    }
    // 출발 그리드: 로스터를 정렬해 슬롯을 결정적으로 분배 — 전원이 같은 지점에
    // 겹쳐 스폰되지 않게 2열(좌/우 차로) × N행(8m 간격) 배치
    const ids = [...new Set([this.net.id, ...(this.mpIds || [])])].sort();
    const slot = Math.max(0, ids.indexOf(this.net.id));
    const col = slot % 2;
    const row = Math.floor(slot / 2);
    const gi = Math.max(2, this.startIdx - Math.round((row * 8) / this.segLen));
    const gs = this.samples[gi];
    const lat = this.laneCenter + (col === 0 ? -2.6 : 2.6);
    this.car.placeAt(
      gs.pos.clone().addScaledVector(gs.left, lat),
      Math.atan2(gs.tangent.x, gs.tangent.z));
    this.currentSampleIdx = gi;
    // 배치 직후 스냅샷 1회 선송신 — GO 순간부터 상대 차가 그리드에 보인다
    const p0 = this.car.body.position;
    this.net.send({
      t: 's', p: [p0.x, p0.y, p0.z], h: this.car.heading, v: 0,
      c: this.carModel, n: this.mpName, pr: 0,
    });

    const beginAt = this.mpStartAt - 2400;
    await new Promise((res) => {
      const iv = setInterval(() => {
        if (this.net.serverNow() >= beginAt) { clearInterval(iv); res(); }
      }, 25);
    });
  }

  // 멀티 프레임 틱: 원격 차 보간 + 스냅샷 송신(~15Hz) + (방장) 트래픽 중계(~10Hz)
  mpTick(dt) {
    for (const r of this.remotes.values()) {
      r.update();
      // 원격 차에도 도로 경계 클램프 — 분리대는 물리 벽이 아니라 수학 클램프라
      // 스프링 오버슈트/보간이 분리대 메시를 뚫고 보이는 현상을 여기서 막는다.
      // (우측 한계는 진출차로·쉼터 확장 때문에 느슨하게 30)
      const nr = this.nearestSampleOf(
        this.samples, r._idx ?? this.currentSampleIdx, 200, r.body.position);
      r._idx = nr.idx;
      if (nr.dist < 40) {
        clampToRoad(r.body, this.samples[nr.idx], this.laneMin, 30);
        r.group.position.set(r.body.position.x, r.body.position.y, r.body.position.z);
      }
    }
    this._mpAccS = (this._mpAccS || 0) + dt;
    if (this._mpAccS >= 1 / 15) {
      this._mpAccS = 0;
      const p = this.car.body.position;
      this.net.send({
        t: 's',
        p: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100],
        h: Math.round(this.car.heading * 1000) / 1000,
        v: Math.round(this.car.speed * 10) / 10,
        c: this.carModel,
        n: this.mpName,
        pr: Math.round((this.lastProgress || 0) * 1000) / 1000,
        b: this.input.highBeam ? 1 : 0, // 상향등 — 상대 화면에서 광원 증폭
      });
    }
    if (this.mpHost && this.traffic) {
      this._mpAccT = (this._mpAccT || 0) + dt;
      if (this._mpAccT >= 1 / 10) {
        this._mpAccT = 0;
        this.net.send({ t: 'tf', cars: this.traffic.getNet() });
      }
    }
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
    if (this.mpRoom) await this.mpAwaitStart();
    await this.countdown();
    if (this.disposed) return;
    // 개발·검증용 자동 주행 (?autodrive=1)
    if (this.params.get('autodrive') === '1') {
      this.input.forward = true;
      this.autoSteer = true;
    }
    this.running = true;
    this.clock.start();
    this.raceTime = 0;
    document.querySelector('.controls-hint')?.classList.remove('faded'); // 새 판마다 리셋
    sounds.engineStart(); // 엔진 루프(합성) — GO와 함께 시동
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
  nearestSampleOf(arr, guess, win, pos = null) {
    const p = pos || this.car.body.position;
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

  // 대향 차량과 충돌 → (하드모드) 즉시 게임 실패. 하드모드 off면 물리 충돌만
  onCarCollide(e) {
    if (this.finished) return;
    if (!this.hardMode) return; // 이지모드: 부딪혀도 게임오버 없음(밀림·스파크만)
    const rel = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 8;
    if (rel < 1.5) return; // 물리 솔버의 미세 접촉 노이즈만 무시
    this.fail();
  }

  fail() {
    if (this.finished) return;
    this.finished = true;
    this.failed = true; // 순위표: 사고 리타이어 표시용
    this.mpEnded = true; // 멀티: 방장이면 관전 트래픽 시뮬로 전환
    this.crashShake = 1.4; // 사고 임팩트 셰이크(감쇠는 updateCamera가 처리)
    sounds.engineStop();
    // 멀티: 사고 통지 — 상대 순위표에 "사고 (진행률%)"로 기록된다
    this.net?.send({ t: 'crash', pr: Math.round((this.lastProgress || 0) * 1000) / 1000 });
    const result = {
      totalTime: this.raceTime,
      maxSpeed: this.maxSpeed,
      avgSpeed: this.raceTime > 0 ? (this.totalDist / this.raceTime) * 3.6 : 0,
      progress: this.currentSampleIdx / (this.samples.length - 1),
    };
    if (this.net) {
      // 멀티: 슬로모 없이 즉시 — 내 물리만 느려지면 상대 화면과 어긋난다
      this.running = false;
      this.ui.onFail(result);
    } else {
      // 싱글: 사고 슬로모(절제) — 잠깐 시간이 늘어지며 차가 미끄러지는 걸 보여주고
      // 결과 흐름으로. 오버레이·시점 전환 없음(화면 가리는 연출 비선호)
      this.slowmo = 1.15;
      this._failUi = () => this.ui.onFail(result);
    }
  }

  // 니어미스: 아슬아슬할수록 부스터 게이지를 많이 충전 (점수는 없음 — 순위는 평균속도)
  // 가드레일 긁힘 효과음(연타 방지 쿨다운 — 밀착 중엔 ~0.3초 간격으로 지글거림)
  railScrape() {
    const now = performance.now();
    if (this._scrapeCd && now - this._scrapeCd < 300) return;
    this._scrapeCd = now;
    sounds.scrape();
  }

  onNearMiss(minDist, dir, near, collide) {
    const prox = THREE.MathUtils.clamp((near - minDist) / (near - collide), 0, 1); // 1=아슬아슬
    this.boostGauge += 0.12 + prox * 0.16;
    if (this.boostGauge >= 1) { this.car.boost(2.2); this.boostGauge = 0; sounds.boost?.(); }
    sounds.whoosh?.(dir); // 스친 방향에서 도플러 "휙"
    this.flash = { t: 0.9, label: prox > 0.6 ? '아슬아슬!' : '니어미스!', close: prox > 0.6 };
  }

  updateCamera(snap = false) {
    const car = this.car.group;
    // 개발·검증: ?top=220 → 차 위 조감 뷰 (배치 문제 확인용)
    if (this.topViewH === undefined) {
      const tv = parseFloat(this.params.get('top'));
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
      const eye = this.cockpit?.eye || { x: 0.45, y: 1.42, z: 0.55 };
      this.camera.position.copy(car.position)
        .addScaledVector(fwd, eye.z)
        .addScaledVector(leftV, eye.x)
        .add(new THREE.Vector3(0, eye.y, 0));
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

    // 화면 흔들림은 '내 차 충돌' 때만 (속도·부스터 셰이크 제거). 1인칭에선 미적용(사용자 피드백)
    if (this.crashShake > 0) this.crashShake = Math.max(0, this.crashShake - 0.03);
    const shake = this.fpView ? 0 : this.crashShake || 0;
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
    this.mpEnded = true; // 멀티: 방장이면 관전 트래픽 시뮬로 전환
    this.finishTime = this.raceTime; // 순위표 기록
    sounds.engineStop();
    sounds.finish();
    this.net?.send({ t: 'fin', time: this.raceTime }); // 멀티: 완주 통지
    this.ui.onFinish({
      totalTime: this.raceTime,
      maxSpeed: this.maxSpeed,
      avgSpeed: this.raceTime > 0 ? (this.totalDist / this.raceTime) * 3.6 : 0,
    });
  }

  loop() {
    if (this.disposed) return;
    requestAnimationFrame(() => this.loop());
    let dt = Math.min(this.clock.getDelta(), 0.05);
    // 사고 슬로모(싱글): 실시간 1.15초 동안 세계 전체가 0.28배속 — 끝나면 결과 화면
    if (this.slowmo > 0) {
      this.slowmo -= dt;
      dt *= 0.28;
      if (this.slowmo <= 0) {
        this.running = false;
        const failUi = this._failUi;
        this._failUi = null;
        failUi?.();
      }
    }

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
      // 상향등(F 홀드): 헤드라이트 증폭 + 앞차에 양보 요구
      const hb = this.input.highBeam;
      this.headlight.intensity = this.headlightBase.intensity * (hb ? 2.4 : 1);
      this.headlight.distance = this.headlightBase.distance * (hb ? 1.5 : 1);
      this.headlight.angle = this.headlightBase.angle * (hb ? 1.12 : 1);
      if (this.traffic) {
        // 플레이어의 차선 내 횡위치·속도 — 트래픽이 플레이어를 앞차로 취급
        const psmp = this.samples[this.currentSampleIdx];
        const plat = (this.car.body.position.x - psmp.pos.x) * psmp.left.x
          + (this.car.body.position.z - psmp.pos.z) * psmp.left.z;
        this.traffic.control(dt, playerS, plat, this.car.speed, hb);
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
        // 분기 진출 창: 진출차로가 열린 만큼만 우측을 열고, 차가 본선 가장자리
        // 실선을 실제로 넘어 차선에 올라타면 분기 모드로 전환(실도로 진출 방식).
        // 폐쇄 시엔 이 블록을 건너뛰어 우측이 안 열림 → 본선 갓길에서 막힌다.
        if (this.branch && !this.branchClosed) {
          const bofs = this.currentSampleIdx - this.branch.exitIdx;
          if (bofs > -this.branchWinN && bofs < Math.round(70 / this.segLen)) {
            // 테이퍼 진행에 비례해 우측 한계 확장, 고어 뒤엔 완전 개방
            const dApp = (bofs + this.branchWinN - 3) * this.segLen;
            const laneW = Math.min(this.branch.laneW,
              (this.branch.laneW * Math.max(0.1, dApp)) / this.branch.taperLen);
            maxRight = Math.max(maxRight,
              bofs > 0 ? 30 : this.branchEdgeLat + Math.max(laneW - 1.2, 0.3));
            const bres = this.nearestSampleOf(this.branch.samples, this.branchIdx, 90);
            this.branchIdx = bres.idx;
            const ms = this.samples[this.currentSampleIdx];
            const px = this.car.body.position.x, pz = this.car.body.position.z;
            const mDist = Math.hypot(px - ms.pos.x, pz - ms.pos.z);
            const lat = (px - ms.pos.x) * ms.left.x + (pz - ms.pos.z) * ms.left.z;
            if (bres.idx > 4 && lat > this.branchEdgeLat - 0.6 && bres.dist < mDist - 0.6) {
              this.onBranch = true;
            }
          } else {
            this.branchIdx = 0; // 진출 창 밖 — 다음 접근을 위해 리셋
          }
        }
        if (!this.onBranch) {
          // 벽 밀착 감지(클램프 한계 초과) → 가드레일/분리대 긁힘 효과음
          const csm = this.samples[this.currentSampleIdx];
          const latC = (this.car.body.position.x - csm.pos.x) * csm.left.x
            + (this.car.body.position.z - csm.pos.z) * csm.left.z;
          if ((latC > maxRight + 0.05 || latC < this.laneMin - 0.05) && Math.abs(this.car.speed) > 4) {
            this.railScrape();
          }
          // 좌측 한계는 중앙분리대(왕복 도로) — 대향 차로로 못 넘어간다
          clampToRoad(this.car.body, this.samples[this.currentSampleIdx], this.laneMin, maxRight);
        }
      }
      if (this.onBranch) {
        // 분기 주행: 분기 샘플 기준 클램프 + 고도 추종(물리는 XZ 평면이라 y는 수동)
        const bres = this.nearestSampleOf(this.branch.samples, this.branchIdx, 60);
        this.branchIdx = bres.idx;
        // 고어 전(진출차로 위)에선 본선 복귀 허용 — 실도로처럼 차선만 걸친 상태라
        // 왼쪽으로 되돌아가면 그대로 직진(강제 진출 방지)
        let backToMain = false;
        if (this.branch.dists[this.branchIdx] < this.branch.approachLen - 4) {
          const mres = this.nearestSampleOf(this.samples, this.currentSampleIdx, 90);
          const ms2 = this.samples[mres.idx];
          const lat2 = (this.car.body.position.x - ms2.pos.x) * ms2.left.x +
                       (this.car.body.position.z - ms2.pos.z) * ms2.left.z;
          if (lat2 < this.branchEdgeLat - 1.5) {
            this.onBranch = false;
            this.currentSampleIdx = mres.idx;
            backToMain = true;
          }
        }
        if (!backToMain) {
          const bs = this.branch.samples[this.branchIdx];
          // 벽 밀착 감지(분기 연석/파라펫) → 긁힘 효과음
          const latB = (this.car.body.position.x - bs.pos.x) * bs.left.x
            + (this.car.body.position.z - bs.pos.z) * bs.left.z;
          const bLo = this.branch.clampLo[this.branchIdx];
          const bHi = this.branch.clampHi[this.branchIdx];
          if ((latB > bHi + 0.05 || latB < bLo - 0.05) && Math.abs(this.car.speed) > 4) {
            this.railScrape();
          }
          // 구간별 비대칭 클램프: 진출차로/램프는 대칭, 합류 차선에선 서쪽(본선 남행
          // 차로)으로 크게 열려 언제든 도로로 건너갈 수 있다
          clampToRoad(this.car.body, bs, bLo, bHi);
          this.car.body.position.y += (bs.pos.y - this.car.body.position.y) * Math.min(1, 10 * dt);
          // 올림픽대로 종점 도착 = 완주 (재합류 없음 — 대체 목적지)
          if (!this.finished && this.branchIdx >= this.branch.samples.length - 30) {
            this.finished = true;
            this.finish();
          }
        }
      }
      this.car.sync();
      if (this.traffic) this.traffic.postStep(this.laneMax);
      if (this.net) this.mpTick(dt); // 멀티: 원격 차 보간 + 스냅샷 송수신

      // 니어미스 칼치기: 아슬아슬하게 스치면 부스터 게이지 충전
      if (this.traffic) {
        this.traffic.collectNearMisses(this.car.group.position,
          (minDist, dir, near, collide) => this.onNearMiss(minDist, dir, near, collide));
      }
      if (this.flash) {
        this.flash.t -= dt;
        if (this.flash.t <= 0) this.flash = null;
      }

      // 엔진음: 속도(가상 기어 피치)·스로틀·부스터 반영
      sounds.engineUpdate(this.car.speedKmh, this.input.forward ? 1 : 0, this.car.boostTimer > 0);

      // 미니맵 갱신(~10Hz)
      this._mmAcc = (this._mmAcc || 0) + dt;
      if (this.minimap && this._mmAcc >= 0.1) {
        this._mmAcc = 0;
        this.minimap.update(
          this.car.body.position, this.car.heading,
          [...this.remotes.values()].map((r) => r.group.position));
      }

      // 분기 사전 안내: 출구 500m/150m 전 1회씩 (분기 미진입 상태에서만, 폐쇄 시 없음)
      if (this.branch && !this.branchClosed && !this.onBranch && !this.finished) {
        const dEx = (this.branch.exitIdx - this.currentSampleIdx) * this.segLen;
        if (dEx > 0 && dEx < 500 && !this._exitN1) {
          this._exitN1 = true;
          this.flash = { t: 2.4, label: '올림픽대로 출구 500m', sub: '우측 진출차로 이용' };
        }
        if (dEx > 0 && dEx < 160 && !this._exitN2) {
          this._exitN2 = true;
          this.flash = { t: 2.2, label: '출구 앞', sub: '지금 우측 차선으로 →' };
        }
      }

      // 조작 힌트: 주행 9초 뒤 페이드아웃 (?stats=1이면 통계 표시용이라 유지)
      if (!this._hintFaded && !this.showStats && this.raceTime > 9) {
        this._hintFaded = true;
        document.querySelector('.controls-hint')?.classList.add('faded');
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
      this.lastProgress = hudProgress; // 멀티: 스냅샷·순위 계산용
      // 멀티: 실시간 순위 — 원격 피어들의 진행률(스냅샷 pr)과 비교
      let rank = null, racers = null;
      if (this.net && this.remotes.size > 0) {
        rank = 1;
        for (const r of this.remotes.values()) {
          if ((r.progress || 0) > hudProgress) rank++;
        }
        racers = this.remotes.size + 1;
      }
      this.ui.onHud({
        speed: this.car.speedKmh,
        progress: hudProgress,
        time: this.raceTime,
        avg: this.raceTime > 1 ? (this.totalDist / this.raceTime) * 3.6 : 0,
        boosting: this.car.boostTimer > 0,
        boostGauge: this.boostGauge,
        flash: this.flash,
        rank, racers,
      });
    } else if (this.net && this.mpHost && this.mpEnded && this.traffic && this.remotes.size > 0) {
      // 방장 관전 모드: 내 레이스가 끝나도(사고·완주) 트래픽 시뮬·중계는 계속 —
      // 멈추면 게스트 화면의 차들이 전부 얼어붙는다. 기준점(스폰 앵커)은 선두 게스트
      let lead = null;
      for (const r of this.remotes.values()) {
        if (!lead || (r.progress || 0) > (lead.progress || 0)) lead = r;
      }
      if (lead) {
        const res = this.nearestSampleOf(
          this.samples, this._specIdx ?? this.currentSampleIdx, 240, lead.group.position);
        this._specIdx = res.idx;
        const anchorS = this.traffic.arcAtIndex(res.idx);
        this.traffic.control(dt, anchorS, 0, 20, false);
        this.world.step(1 / 60, dt, 3);
        this.traffic.postStep(this.laneMax);
        this.mpTick(dt); // 원격 차 보간 + 트래픽 중계 지속
      }
    }

    // 결과 화면 순위표 라이브 갱신 — 내가 끝나도 상대 기록(fin/crash/진행률)은 계속 들어온다
    if (this.finished && this.net && this._standingsDirty) {
      this._stAcc = (this._stAcc || 0) + dt;
      if (this._stAcc >= 0.5) {
        this._stAcc = 0;
        this._standingsDirty = false;
        this.ui.onStandings?.(this.getStandings());
      }
    }

    this.worldTime += dt;
    this.envUpdate?.(this.worldTime, dt);
    this.skyLife?.update(this.worldTime, dt);
    this.particles.update(dt);
    this.rain?.update(dt, this.camera.position);
    this.updateCamera();
    this.updateCockpit(dt);
    this.updateSun();
    this.updateLampLights();
    // 그림자 격프레임 갱신 (autoUpdate=false 페어)
    this._shadowTick = (this._shadowTick + 1) % this._shadowEvery;
    if (this._shadowTick === 0) this.renderer.shadowMap.needsUpdate = true;
    if (this.showStats) this.renderer.info.reset();
    this.composer.render();

    // 자동 품질: 주행 시작 후 첫 4초 FPS를 재고 낮으면 해상도·그림자를 강등.
    // (트래픽 대수는 이미 스폰돼 런타임 변경이 까다로우니 dpr·그림자 주기만 조정)
    if (this.autoQuality && this.running && !this._autoDone) {
      this._autoAcc = (this._autoAcc || 0) + dt;
      this._autoN = (this._autoN || 0) + 1;
      if (this._autoAcc >= 4) {
        this._autoDone = true;
        const fps = this._autoN / this._autoAcc;
        let dpr = null;
        if (fps < 42) { dpr = 1.0; this._shadowEvery = 3; }
        else if (fps < 55) { dpr = 1.25; this._shadowEvery = 2; }
        if (dpr) {
          this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dpr));
          this.composer.setSize(this.container.clientWidth, this.container.clientHeight);
        }
      }
    }

    if (this.showStats) {
      // FPS: 최근 30프레임 이동평균
      this._fpsAcc = (this._fpsAcc || 0) + dt;
      this._fpsN = (this._fpsN || 0) + 1;
      if (this._fpsN >= 30) {
        this._fps = Math.round(this._fpsN / this._fpsAcc);
        this._fpsAcc = 0;
        this._fpsN = 0;
      }
      const r = this.renderer.info.render;
      const el = document.querySelector('.controls-hint');
      if (el) el.textContent =
        `fps: ${this._fps || '…'} · draw calls: ${r.calls} · tris: ${(r.triangles / 1000).toFixed(0)}k`;
    }
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    sounds.engineStop();
    this.minimap?.dispose();
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('resize', this.onResize);
    this.rain?.dispose();
    this.traffic?.dispose();
    if (!this.netHandoff) this.net?.close(); // 재대결: 소켓은 새 게임이 인계
    for (const r of this.remotes?.values() ?? []) r.dispose();
    this.cockpit?.rt.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}
