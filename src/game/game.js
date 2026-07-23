// 게임 본체: 씬 구성(트랙·분기·환경·차량), 주행 루프, 진행률/결과, 봇 대결.
// 하늘 연출은 sky.js, 사운드는 sounds.js, AI 트래픽은 traffic.js,
// 봇 레이서는 bots.js로 분리.

import * as THREE from 'three';
import { View } from './view.js';
import { generateTrack, buildRoadMesh, buildMedian, buildStartLine, MEDIAN_HALF } from '../map/trackGenerator.js';
import { generateBranchRoute, buildBranchRoad } from '../map/branchRoad.js';
import { buildRoadArrows } from '../map/roadArrows.js';
import { TrafficSystem } from './traffic.js';
import { BotSystem } from './bots.js';
import { InputSystem } from './input.js';
import { Minimap } from './minimap.js';
import { ParticleSystem } from './particles.js';
import { buildEnvironment } from '../map/decorations.js';
import { Car } from './car.js';
import { buildCockpit } from './cockpit.js';
import { createWorld, clampToRoad } from './physics.js';
import { toonifyScene } from './npr.js';
import { sounds } from './sounds.js';
import { createRng } from '../utils/rng.js';
import { buildSkyAndLights } from './sceneEnv.js';
import { CameraRig, BASE_FOV } from './cameraRig.js';

// 품질 프리셋: 성능 지렛대 3종만 조절 —
//  dpr(픽셀비율, 화면 픽셀 수가 제곱으로 늘어 최대 비용) / 그림자맵 해상도 + 갱신 주기
//  (깊이 패스가 씬 전체 재렌더라 비쌈) / 트래픽 대수(실차 6~14k폴리).
//  bloom·비네트는 반해상도라 저렴해 프리셋에서 제외(무드 유지).
const QUALITY = {
  low:    { dpr: 1.0,  shadow: 1024, shadowEvery: 3, traffic: 6 },
  medium: { dpr: 1.25, shadow: 2048, shadowEvery: 2, traffic: 10 },
  high:   { dpr: 1.6,  shadow: 4096, shadowEvery: 1, traffic: 16 },
};

export class Game {
  // palette: nightCityPalette 결과
  constructor(container, palette, ui, opts = {}) {
    this.container = container;
    this.palette = palette;
    // ui 콜백: { onHud, onCountdown, onFinish, onFail, onStandings }
    this.ui = ui;
    this.carModel = opts.carModel || 'car7'; // 선택된 차량 에셋 이름
    // URL 파라미터 스냅샷 — 게임 생성 시점 기준으로 한 번만 파싱해 전역에서 재사용
    // (개발·검증 파라미터 목록은 README 격인 메모리/주석 참고: seed·at·branch·
    //  cam·tod·hard·traffic·dpr·stats·top·autodrive·tclose·room·host·name)
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

    // NPR(셀셰이딩): 시작화면 '만화 렌더' 토글 → opts.npr, URL ?npr=1|0 우선
    this.npr = gq.get('npr') !== null ? gq.get('npr') === '1' : !!opts.npr;

    // 봇 대결: 시작화면 select → opts.bots, URL ?bots=0..3 우선
    const botsParam = parseInt(gq.get('bots'), 10);
    this.botCount = Number.isFinite(botsParam)
      ? Math.max(0, Math.min(3, botsParam))
      : Math.max(0, Math.min(3, opts.bots ?? 3));

    this.running = false;
    this.disposed = false;
    // 입력(키보드/패드/터치 합성)은 input.js — 시점 전환만 콜백으로 받는다
    this.input = new InputSystem({ onToggleView: () => this.setView(!this.fpView) });
    this.clock = new THREE.Clock();

    this.raceTime = 0;
    this.totalDist = 0;   // 주행 거리(전진분) — 평균속도 산출용
    this.maxSpeed = 0;    // 최고 속도(km/h) — 결과 화면용
    this.finished = false;
  }

  build(seed) {
    const rng = createRng(seed);

    // 씬/카메라 — 렌더러·포스트프로세싱(NPR 포함)은 view.js가 소유
    this.scene = new THREE.Scene();
    // 야간: 안개(원경 깊이감). 배경 산맥까지 바닥이 이어지고 산은 헤이즈에 녹아들도록.
    this.scene.fog = new THREE.Fog(this.palette.fog, 220, 2800);
    this.camera = new THREE.PerspectiveCamera(
      BASE_FOV,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      5200 // 하늘 돔(4200)·원경 산맥까지 커버
    );
    this.view = new View(this.container, this.scene, this.camera, {
      palette: this.palette,
      quality: this.quality,
      npr: this.npr,
      dprOverride: parseFloat(this.params.get('dpr')),
    });
    this.renderer = this.view.renderer; // RT 렌더(콕핏 미러)·통계 등 직접 접근용 별칭

    // 조명·하늘·환경맵(시간대 무드)은 sceneEnv.js — follow()가 태양/돔 추적
    const dusk = this.palette.tod === 'dusk';
    this.env = buildSkyAndLights(this.scene, this.renderer, this.palette, rng, this.quality);
    this.skyLife = this.env.skyLife;

    // 카메라 리그(추격/1인칭/조감 + FOV·사고 셰이크)는 cameraRig.js
    this.rig = new CameraRig(this.camera, {
      topViewH: parseFloat(this.params.get('top')) || 0, // 개발·검증: ?top=220 조감 뷰
    });

    this.particles = new ParticleSystem(this.scene);

    // 트랙 + 장식 + 추억 오브젝트 (편도 루트: 출발 → 강 다리 → 목적지)
    const track = generateTrack(rng);
    this.samples = track.samples;
    this.trackWidth = track.width;
    this.river = track.river;
    // 우측 통행: 주행 가능한 측면 범위(중앙분리대 ~ 우측 배리어).
    // 왕복 8차선 — 플레이어·AI 트래픽은 우측 4차선, 좌측 4차선은 장식 대향 차량.
    // 차 반폭(~1.1)+여유 — 1차로 중심(lat 2.0)에 정상적으로 올라탈 수 있어야 한다
    this.laneMin = MEDIAN_HALF + 1.15;              // = 1.65, 분리대 연석에 안 닿는 한계
    this.laneMax = track.width / 2 - 1.2;           // 우측 갓길 직전
    this.laneCenter = (this.laneMin + this.laneMax) / 2;
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
    const roadMesh = buildRoadMesh(track.samples, track.width);
    // 노을: 물웅덩이(roughnessMap 매끈 패치)가 밝은 하늘을 그대로 비추면 과함
    if (dusk) roadMesh.material.envMapIntensity = 0.35;
    this.scene.add(roadMesh);
    // 왕복 8차선: 중앙분리대(뉴저지 방호벽+LED)가 대향 차로와 주행 차로를 가른다
    this.scene.add(buildMedian(track.samples));
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
    const gaps = [];
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
    // NPR(Toon)은 명암이 계단으로 스냅돼 같은 강도도 빛 웅덩이가 넓고 세게
    // 번진다 — PBR 600과 체감이 비슷하도록 감광
    const hlIntensity = this.npr ? 380 : 600;
    const headlight = new THREE.SpotLight(0xffedc4, hlIntensity, 85, 0.44, 0.5, 1.7);
    headlight.position.set(0, 2.0, 1.5);
    headlight.target.position.set(0, -1.5, 32);
    this.car.group.add(headlight, headlight.target);
    this.headlight = headlight;
    this.headlightBase = { intensity: hlIntensity, distance: 85, angle: 0.44 };

    // AI 트래픽(같은 방향): 왕복 8차선의 우측 4차선(플레이어 반부)만 사용.
    // 좌측 4차선의 대향 차량은 buildEnvironment의 장식 인스턴스가 담당(물리 없음 —
    // 중앙분리대 클램프로 플레이어가 접촉할 수 없다).
    const laneW = track.width / 8; // 차선폭 4m
    const laneCenters = [laneW * 0.5, laneW * 1.5, laneW * 2.5, laneW * 3.5]; // +2,+6,+10,+14
    this.traffic = !this.trafficOn ? null : new TrafficSystem(this.scene, this.samples, {
      world: this.world,
      laneCenters,
      // 실차 트래픽(6~14k폴리/대)은 무겁다 — 품질 프리셋으로 대수 관리
      count: this.quality.traffic,
      river: track.river, // 다리 구간 정체(구간별 밀도감)용
      debugClose: this.params.get('tclose') === '1',
    });

    // ── 봇 레이서: 플레이어와 같은 규칙(트래픽 충돌=리타이어)으로 결승까지 경쟁 ──
    // 출발 그리드: 2열(차로 중앙 ±2.6m) × N행(8m 간격) — 봇이 앞줄, 플레이어는 맨 뒤
    this.bots = null;
    if (this.botCount > 0) {
      const botRng = createRng(seed + '::bots');
      this.bots = new BotSystem(this.scene, this.world, this.samples, {
        count: this.botCount,
        // 봇은 플레이어가 안 고른 차종을 쓴다 — 내 차와 헷갈리지 않게
        models: ['car7', 'car10', 'car11', 'car12'].filter((m) => m !== this.carModel),
        laneMin: this.laneMin,
        laneMax: this.laneMax,
        laneCenters,
        segLen,
        rng: botRng,
        hardMode: this.hardMode, // 이지모드면 봇도 사고 판정 없음(플레이어와 동일 규칙)
        onEvent: (type, bot) => this.onBotEvent(type, bot),
      });
      const slotPos = (slot) => {
        const row = Math.floor(slot / 2), col = slot % 2;
        const gi = Math.max(2, this.startIdx - Math.round((row * 8) / segLen));
        const gs = this.samples[gi];
        return {
          gi,
          pos: gs.pos.clone().addScaledVector(gs.left, this.laneCenter + (col === 0 ? -2.6 : 2.6)),
          heading: Math.atan2(gs.tangent.x, gs.tangent.z),
        };
      };
      this.bots.list.forEach((bot, k) => {
        const sp = slotPos(k);
        this.bots.place(bot, sp.pos, sp.heading, sp.gi);
      });
      const mine = slotPos(this.botCount);
      this.car.placeAt(mine.pos, mine.heading);
      this._gridIdx = mine.gi; // 아래 currentSampleIdx 초기화가 이 값을 쓴다
    }
    // 니어미스 칼치기 → 부스터 게이지 충전(점수 없음)
    this.boostGauge = 0;   // 0~1, 차면 부스터 발동
    this.flash = null;     // 중앙 팝업 { t, label, sub?, close? }

    this.currentSampleIdx = this._gridIdx ?? 0;
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

    // NPR: 씬이 전부 조립된 뒤 일괄 Toon 변환 (기본 모드에선 아무것도 안 함).
    // car/traffic이 변환 전에 수집해 둔 브레이크등 재질 참조는 변환 맵으로 재연결
    // — 안 하면 NPR에서 브레이크 발광 연출만 죽는다(구 평가 모드의 알려진 한계였음)
    if (this.npr) {
      const conv = toonifyScene(this.scene);
      this.car.tailMats = this.car.tailMats.map((m) => conv.get(m) || m);
      for (const b of this.bots?.list ?? []) {
        b.car.tailMats = b.car.tailMats.map((m) => conv.get(m) || m);
      }
      if (this.traffic) {
        for (const c of this.traffic.cars) {
          if (c.tailMat) c.tailMat = conv.get(c.tailMat) || c.tailMat;
        }
      }
    }

    this.input.bind();
    this.onResize = () => {
      if (this.disposed) return;
      this.view.onResize();
    };
    window.addEventListener('resize', this.onResize);

    // 첫 프레임 렌더 (카운트다운 배경)
    this.rig.update(this.car, { fpView: this.fpView, eye: this.cockpit?.eye, snap: true });
    this.env.follow(this.car.group.position, this.camera.position);
    this.view.renderFrame();
  }

  // ── 순위표: 완주자(기록순) → 미완주자(사고/주행중, 진행률순). 나+봇 전원 ──
  getStandings() {
    const rows = [{
      me: true,
      name: '나',
      time: this.finishTime ?? null,
      crashed: !!this.failed,
      progress: this.lastProgress || 0,
    }];
    for (const b of this.bots?.list ?? []) {
      rows.push({
        me: false,
        name: `🤖 ${b.name}`,
        time: b.finishTime,
        crashed: b.crashed,
        progress: Math.min(b.progress || 0, 1),
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

  // 봇 완주/사고 통지(bots.js 콜백) — 중앙 팝업 + 순위표 갱신
  onBotEvent(type, bot) {
    if (type === 'finish') {
      this.flash = { t: 3.5, label: `🤖 ${bot.name} 완주!`, sub: `기록 ${bot.finishTime.toFixed(1)}초` };
    } else {
      this.flash = { t: 3, label: `🤖 ${bot.name} 사고!`, sub: '리타이어' };
    }
    this._standingsDirty = true;
  }

  // 봇의 회피 판단에 넘길 장애물 목록: 트래픽 + 플레이어(종료 후에도 도로 위 장애물)
  collectObstacles() {
    const list = [];
    if (this.traffic) {
      for (const c of this.traffic.cars) {
        if (c.active) list.push({ s: c.s, lat: c.lane, speed: c.effSpeed });
      }
    }
    const ps = this.samples[this.currentSampleIdx];
    const px = this.car.body.position.x - ps.pos.x;
    const pz = this.car.body.position.z - ps.pos.z;
    list.push({
      s: this.bots.arcAtIndex(this.currentSampleIdx) + px * ps.tangent.x + pz * ps.tangent.z,
      lat: px * ps.left.x + pz * ps.left.z,
      speed: Math.max(0, this.car.speed),
    });
    return list;
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
    if (this.params.get('autodrive') === '1') {
      this.input.kb.forward = true;
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
    this.rig.addShake(1.4); // 사고 임팩트 셰이크(감쇠는 rig.update가 처리)
    sounds.engineStop();
    const result = {
      totalTime: this.raceTime,
      maxSpeed: this.maxSpeed,
      avgSpeed: this.raceTime > 0 ? (this.totalDist / this.raceTime) * 3.6 : 0,
      progress: this.currentSampleIdx / (this.samples.length - 1),
      standings: this.bots ? this.getStandings() : null, // 봇 대결 순위(라이브 갱신됨)
    };
    // 사고 슬로모(절제) — 잠깐 시간이 늘어지며 차가 미끄러지는 걸 보여주고
    // 결과 흐름으로. 오버레이·시점 전환 없음(화면 가리는 연출 비선호)
    this.slowmo = 1.15;
    this._failUi = () => this.ui.onFail(result);
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
    const steer = this.ctl?.steer ?? 0; // 합성 컨트롤(패드 아날로그 반영)
    // 좌조향 = 운전자 시점 반시계 = +Z 축 기준 시계(-) 회전 (x=칼럼 기울기는 고정)
    if (c.wheelSpin) c.wheelSpin.rotation.z = THREE.MathUtils.lerp(
      c.wheelSpin.rotation.z, -steer * 1.5, Math.min(1, 10 * dt));
    c.group.rotation.z = this.car.roll * 0.5; // 차체 롤을 실내에도 은은하게
    this._clusterT = (this._clusterT || 0) + dt;
    if (this._clusterT > 0.15) { // 캔버스 갱신은 ~6Hz면 충분
      this._clusterT = 0;
      c.drawCluster(this.car.speedKmh);
    }
    // 후방 미러들: 프레임당 1장만 갱신 — 룸미러는 짝수 프레임(30Hz),
    // 사이드미러(좌/우)는 홀수 프레임을 나눠 쓴다. 콕핏 자신이 거울에 비치면
    // 안 되므로 렌더 동안만 숨긴다.
    if (!c.mirrors.length) return;
    this._mirTick = (this._mirTick || 0) + 1;
    let m;
    if (this._mirTick % 2 === 0 || !c.sideMirrors.length) {
      m = c.roomMirror || c.sideMirrors[0];
    } else {
      m = c.sideMirrors[(this._mirTick >> 1) % c.sideMirrors.length];
    }
    if (!m) return;
    const h2 = this.car.heading;
    const fx = Math.sin(h2), fz = Math.cos(h2);
    const p = this.car.group.position;
    if (m.side === 0) {
      // 룸미러: 실내 높이에서 정후방 (자기 차체는 숨긴 채 — 실내 지오메트리에 가로막힘)
      m.cam.position.set(p.x - fx * 0.5, p.y + 1.55, p.z - fz * 0.5);
      m.cam.lookAt(p.x - fx * 45, p.y + 0.8, p.z - fz * 45);
    } else {
      // 사이드미러: 거울 유리 위치(차 로컬)에서 후방 45m + 바깥쪽 1.5m를 겨냥 —
      // 자기 차 옆면이 거울 안쪽 가장자리에 걸린다(하우징은 near 0.5가 걸러줌)
      const lx = Math.cos(h2), lz = -Math.sin(h2); // 차 로컬 +X(왼쪽)의 월드 방향
      const mp = m.pos;
      m.cam.position.set(
        p.x + lx * mp.x + fx * mp.z,
        p.y + mp.y,
        p.z + lz * mp.x + fz * mp.z);
      m.cam.lookAt(
        m.cam.position.x - fx * 45 + lx * m.side * 1.5,
        m.cam.position.y - 0.7,
        m.cam.position.z - fz * 45 + lz * m.side * 1.5);
    }
    c.group.visible = false;
    // 1인칭에선 차체 모델이 꺼져 있지만 사이드미러엔 내 차 옆면이 보여야 한다
    if (m.side !== 0) this.car.model.visible = true;
    this.renderer.setRenderTarget(m.rt);
    this.renderer.render(this.scene, m.cam);
    this.renderer.setRenderTarget(null);
    if (m.side !== 0) this.car.model.visible = !this.fpView;
    c.group.visible = true;
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
    const ctl = this.ctl;
    if (ctl?.drift && Math.abs(ctl.steer) > 0.25 && Math.abs(car.speed) > 18) {
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
    this.finishTime = this.raceTime; // 순위표 기록
    sounds.engineStop();
    sounds.finish();
    this.ui.onFinish({
      totalTime: this.raceTime,
      maxSpeed: this.maxSpeed,
      avgSpeed: this.raceTime > 0 ? (this.totalDist / this.raceTime) * 3.6 : 0,
      standings: this.bots ? this.getStandings() : null, // 봇 대결 순위(라이브 갱신됨)
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

    this.input.pollPad(); // 게임패드는 이벤트가 없다 — 매 프레임 상태 폴링

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
        this.input.kb.left = diff > 0.05;
        this.input.kb.right = diff < -0.05;
      }
      // ── 물리: 힘 적용(플레이어+대향차) → 스텝 → 클램프/동기화 ──
      const ctl = this.ctl = this.input.collect(); // 키보드+패드+터치 합성
      const playerS = this.traffic ? this.traffic.arcAtIndex(this.currentSampleIdx) : 0;
      this.car.update(dt, ctl);                    // 플레이어 구동/조향 힘
      // 상향등(F 홀드): 헤드라이트 증폭 + 앞차에 양보 요구
      const hb = ctl.highBeam;
      this.headlight.intensity = this.headlightBase.intensity * (hb ? 2.4 : 1);
      this.headlight.distance = this.headlightBase.distance * (hb ? 1.5 : 1);
      this.headlight.angle = this.headlightBase.angle * (hb ? 1.12 : 1);
      if (this.traffic) {
        // 플레이어의 차선 내 횡위치·속도 — 트래픽이 플레이어를 앞차로 취급.
        // 봇 위치도 넘겨 트래픽이 봇을 들이받거나 옆구리로 파고들지 않게 한다
        const psmp = this.samples[this.currentSampleIdx];
        const plat = (this.car.body.position.x - psmp.pos.x) * psmp.left.x
          + (this.car.body.position.z - psmp.pos.z) * psmp.left.z;
        this.traffic.control(dt, playerS, plat, this.car.speed, hb,
          this.bots?.racerInfo() ?? []);
      }
      if (this.bots) this.bots.control(dt, this.collectObstacles(), this.raceTime); // 봇 구동/조향 힘
      this.world.step(1 / 60, dt, 3);             // 강체 적분(충돌 해결)

      // 플레이어: 도로 폭 안으로 클램프(중앙 넘기 가능, 가장자리만 배리어) + 동기화.
      // 분기 진출 구간(개방 시)에선 우측 한계를 넓혀 진입 가능.
      this.car.sync();
      if (!this.onBranch) {
        this.findNearestSample();
        let maxRight = this.laneMax;
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
      if (this.bots) this.bots.postStep(); // 봇 도로 클램프 + 메시 동기화

      // 니어미스 칼치기: 아슬아슬하게 스치면 부스터 게이지 충전
      if (this.traffic) {
        this.traffic.collectNearMisses(this.car.group.position,
          (minDist, dir, near, collide) => this.onNearMiss(minDist, dir, near, collide));
      }
      if (this.flash) {
        this.flash.t -= dt;
        if (this.flash.t <= 0) this.flash = null;
      }

      // 엔진음: 속도(가상 기어 피치)·스로틀·부스터 반영 (패드 트리거는 아날로그)
      sounds.engineUpdate(this.car.speedKmh, ctl.throttle, this.car.boostTimer > 0);

      // 미니맵 갱신(~10Hz) — 봇(빨간 점)
      this._mmAcc = (this._mmAcc || 0) + dt;
      if (this.minimap && this._mmAcc >= 0.1) {
        this._mmAcc = 0;
        this.minimap.update(
          this.car.body.position, this.car.heading,
          this.bots?.list.map((b) => b.car.group.position) ?? []);
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
      this.lastProgress = hudProgress; // 순위 계산용
      // 실시간 순위 — 봇들의 진행률과 비교(완주 봇은 항상 위)
      let rank = null, racers = null;
      if (this.bots && this.bots.list.length > 0) {
        rank = 1;
        for (const b of this.bots.list) {
          if ((b.finished ? 1.001 : b.progress || 0) > hudProgress) rank++;
        }
        racers = this.bots.list.length + 1;
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
    } else if (this.finished && this.bots?.anyRacing()) {
      // 관전 시뮬: 내 레이스가 끝나도(사고·완주) 봇들은 결승까지 달린다 —
      // 결과 화면 순위표가 실시간으로 갱신된다. 트래픽 스폰 앵커는 선두 봇
      this.raceTime += dt; // 봇 완주 기록용 레이스 시계는 계속 흐른다
      if (this.traffic) {
        const anchorS = this.traffic.arcAtIndex(this.bots.leadIdx());
        this.traffic.control(dt, anchorS, 0, 20, false, this.bots.racerInfo());
      }
      this.bots.control(dt, this.collectObstacles(), this.raceTime);
      this.world.step(1 / 60, dt, 3);
      if (this.traffic) this.traffic.postStep(this.laneMax);
      this.bots.postStep();
      this._standingsDirty = true; // 진행률 변동 — 0.5s 주기로 순위표 재렌더
    }

    // 결과 화면 순위표 라이브 갱신 — 내가 끝나도 봇 기록(완주/사고/진행률)은 계속 변한다
    if (this.finished && this.bots && this._standingsDirty) {
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
    this.rig.update(this.car, {
      fpView: this.fpView,
      eye: this.cockpit?.eye,
      boosting: this.car.boostTimer > 0,
    });
    this.updateCockpit(dt);
    this.env.follow(this.car.group.position, this.camera.position);
    this.updateLampLights();
    this.view.tickShadow(); // 그림자 격프레임 갱신
    if (this.showStats) this.renderer.info.reset();
    this.view.renderFrame();

    // 자동 품질: 주행 시작 후 첫 4초 FPS를 재고 낮으면 해상도·그림자를 강등.
    // (트래픽 대수는 이미 스폰돼 런타임 변경이 까다로우니 dpr·그림자 주기만 조정)
    if (this.autoQuality && this.running && !this._autoDone) {
      this._autoAcc = (this._autoAcc || 0) + dt;
      this._autoN = (this._autoN || 0) + 1;
      if (this._autoAcc >= 4) {
        this._autoDone = true;
        const fps = this._autoN / this._autoAcc;
        if (fps < 42) this.view.applyQuality({ dpr: 1.0, shadowEvery: 3 });
        else if (fps < 55) this.view.applyQuality({ dpr: 1.25, shadowEvery: 2 });
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
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.traffic?.dispose();
    this.bots?.dispose();
    for (const m of this.cockpit?.mirrors ?? []) m.rt.dispose();
    this.view?.dispose();
  }
}
