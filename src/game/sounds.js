// WebAudio 합성 사운드 — 외부 에셋 없이 신디사이저로 처리(라이선스 무관).
// 엔진 루프(가상 기어) / 카운트다운·출발·완주 톤 / 충돌·긁힘·니어미스 효과음.

let ctx = null;

function ensureCtx() {
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, duration, type = 'sine', gainValue = 0.15, when = 0) {
  const ac = ensureCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainValue, ac.currentTime + when);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + when + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(ac.currentTime + when);
  osc.stop(ac.currentTime + when + duration);
}

// ── 엔진 루프 ──
// 구성: 톱니(기음)+삼각(서브) 오실레이터 — 가상 기어로 RPM이 차오르는 피치 →
// 로우패스 + 저역 노이즈(배기 럼블). 바람 소리는 사용자 피드백으로 제거됨(재추가 금지)
let eng = null;
let noiseBuf = null;

function getNoiseBuffer(ac) {
  if (!noiseBuf) {
    const len = Math.floor(ac.sampleRate * 1.2);
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

export const sounds = {
  countdown() { tone(440, 0.15, 'square', 0.1); },
  go() { tone(880, 0.4, 'square', 0.12); },
  finish() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, 'triangle', 0.1, i * 0.13)); },

  engineStart() {
    const ac = ensureCtx();
    if (!ac || eng) return;
    const master = ac.createGain();
    master.gain.value = 0;
    master.connect(ac.destination);

    // 엔진 본체: 낮고 무겁게 — 기음(톱니, 30Hz대)과 그 절반의 서브(삼각).
    // 밝은 성분은 로우패스로 눌러서 "오토바이 앵앵"이 아니라 V8 저음이 되게 한다
    const osc1 = ac.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 34;
    const osc2 = ac.createOscillator();
    osc2.type = 'triangle'; // 사각파는 홀수배음이 날카로워 오토바이처럼 들림
    osc2.frequency.value = 17;
    osc2.detune.value = 6;
    const engFilter = ac.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 200;
    engFilter.Q.value = 0.9;
    const engGain = ac.createGain();
    engGain.gain.value = 0;
    osc1.connect(engFilter);
    osc2.connect(engFilter);
    engFilter.connect(engGain).connect(master);

    // 배기 럼블: 저역 노이즈 — 무게감의 주역이라 비중을 높게
    const rumbleSrc = ac.createBufferSource();
    rumbleSrc.buffer = getNoiseBuffer(ac);
    rumbleSrc.loop = true;
    rumbleSrc.playbackRate.value = 0.8;
    const rumbleFilter = ac.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 110;
    const rumbleGain = ac.createGain();
    rumbleGain.gain.value = 0;
    rumbleSrc.connect(rumbleFilter).connect(rumbleGain).connect(master);

    osc1.start(); osc2.start(); rumbleSrc.start();
    master.gain.linearRampToValueAtTime(1, ac.currentTime + 0.6);
    eng = { master, osc1, osc2, engFilter, engGain, rumbleSrc, rumbleGain };
  },

  // 매 프레임: kmh(속도), throttle(0~1)
  engineUpdate(kmh, throttle) {
    if (!eng || !ctx) return;
    const t = ctx.currentTime;
    // 가상 기어: 56km/h 구간마다 RPM이 감았다 다시 차오른다 (변속 느낌)
    const span = 56;
    const inGear = Math.min(1, (kmh % span) / span + 0.14);
    const f = 30 + inGear * 44; // 저회전 대배기량 — 높아도 ~82Hz
    eng.osc1.frequency.setTargetAtTime(f, t, 0.07);
    eng.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.07);
    eng.engFilter.frequency.setTargetAtTime(170 + inGear * 380 + throttle * 150, t, 0.09);
    eng.engGain.gain.setTargetAtTime(0.05 + throttle * 0.08, t, 0.09);
    eng.rumbleGain.gain.setTargetAtTime(0.045 + throttle * 0.075, t, 0.12);
  },

  engineStop() {
    if (!eng || !ctx) return;
    const e = eng;
    eng = null;
    e.master.gain.setTargetAtTime(0, ctx.currentTime, 0.18);
    setTimeout(() => {
      try { e.osc1.stop(); e.osc2.stop(); e.rumbleSrc.stop(); } catch { /* noop */ }
    }, 900);
  },

  // 차량 충돌 임팩트: 저역 "쿵" + 짧은 크런치 노이즈. strength 0~1
  impact(strength = 0.5) {
    const ac = ensureCtx();
    if (!ac) return;
    const s = Math.min(1, Math.max(0.15, strength));
    const t0 = ac.currentTime;
    // 쿵(바디): 피치가 뚝 떨어지는 사인
    const thump = ac.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(110 + s * 60, t0);
    thump.frequency.exponentialRampToValueAtTime(38, t0 + 0.16);
    const tg = ac.createGain();
    tg.gain.setValueAtTime(0.22 * s, t0);
    tg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
    thump.connect(tg).connect(ac.destination);
    thump.start(t0);
    thump.stop(t0 + 0.3);
    // 크런치(판금): 저역 노이즈 버스트
    const src = ac.createBufferSource();
    src.buffer = getNoiseBuffer(ac);
    const nf = ac.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.value = 900 + s * 900;
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.16 * s, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
    src.connect(nf).connect(ng).connect(ac.destination);
    src.start(t0);
    src.stop(t0 + 0.22);
  },

  // 가드레일/분리대 긁힘: 금속성 마찰 — 고역 밴드패스 노이즈 지글거림
  scrape() {
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = getNoiseBuffer(ac);
    src.playbackRate.value = 1.6;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(2600, t0);
    f.frequency.exponentialRampToValueAtTime(1700, t0 + 0.3);
    f.Q.value = 2.2;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.34);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t0);
    src.stop(t0 + 0.36);
  },

  // 니어미스 추월 도플러: 밴드패스 노이즈가 고음→저음으로 스치듯 지나간다.
  // pan: -1(왼쪽)~1(오른쪽) — 스친 방향에서 들리게
  whoosh(pan = 0) {
    const ac = ensureCtx();
    if (!ac) return;
    const src = ac.createBufferSource();
    src.buffer = getNoiseBuffer(ac);
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.3;
    f.frequency.setValueAtTime(1500, ac.currentTime);
    f.frequency.exponentialRampToValueAtTime(320, ac.currentTime + 0.38);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.42);
    src.connect(f).connect(g);
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p).connect(ac.destination);
    } else {
      g.connect(ac.destination);
    }
    src.start();
    src.stop(ac.currentTime + 0.5);
  },
};
