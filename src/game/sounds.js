// WebAudio 간이 사운드 (명세 3.2.3) — 외부 에셋 없이 신디사이저 톤으로 처리

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

export const sounds = {
  collect() { tone(880, 0.12, 'sine', 0.12); tone(1320, 0.15, 'sine', 0.08, 0.06); },
  boost() { tone(220, 0.4, 'sawtooth', 0.1); tone(440, 0.35, 'sawtooth', 0.08, 0.1); },
  memory() { tone(523, 0.3, 'triangle', 0.1); tone(659, 0.35, 'triangle', 0.08, 0.12); tone(784, 0.4, 'triangle', 0.06, 0.24); },
  lap() { tone(660, 0.15, 'square', 0.08); tone(880, 0.25, 'square', 0.08, 0.15); },
  countdown() { tone(440, 0.15, 'square', 0.1); },
  go() { tone(880, 0.4, 'square', 0.12); },
  finish() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, 'triangle', 0.1, i * 0.13)); },
};
