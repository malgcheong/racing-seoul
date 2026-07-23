// 입력 계층 — 키보드(이벤트) / 게임패드(매 프레임 폴링) / 터치(온스크린 버튼) 3계층을
// 하나의 아날로그 컨트롤 {steer, throttle, brake, drift, highBeam}로 합성한다.
// 게임 로직(game.js)은 매 프레임 pollPad() → collect()만 호출하는 단일 소비자.
// 시점 전환(C키·패드 Y·터치 '시점' 버튼)은 onToggleView 콜백으로 위임.

import * as THREE from 'three';

export class InputSystem {
  constructor({ onToggleView } = {}) {
    this.onToggleView = onToggleView || (() => {});
    // kb는 autoSteer/autodrive(개발용)가 직접 쓰는 공개 상태 — 필드명 유지
    this.kb = { forward: false, backward: false, left: false, right: false, drift: false, highBeam: false };
    this.pad = { steer: 0, throttle: 0, brake: 0, drift: false, high: false };
    this.touch = { l: false, r: false, throttle: false, brake: false, drift: false, high: false };
    this._touchBinds = [];
  }

  bind() {
    this.onKey = (e, down) => {
      const k = this.kb;
      switch (e.code) {
        case 'ArrowUp': case 'KeyW': k.forward = down; break;
        case 'ArrowDown': case 'KeyS': k.backward = down; break;
        case 'ArrowLeft': case 'KeyA': k.left = down; break;
        case 'ArrowRight': case 'KeyD': k.right = down; break;
        case 'ShiftLeft': case 'ShiftRight': k.drift = down; break;
        case 'KeyF': k.highBeam = down; break; // 상향등(누르는 동안) — 앞차 양보 요구
        case 'KeyC': if (down && !e.repeat) this.onToggleView(); break;
        default: return;
      }
      e.preventDefault();
    };
    this.keydown = (e) => this.onKey(e, true);
    this.keyup = (e) => this.onKey(e, false);
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
    this.bindTouch();
  }

  // ── 터치 컨트롤: 터치 가능 기기에서만 온스크린 버튼 표시·바인딩 ──
  bindTouch() {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const tc = document.querySelector('#touch-controls');
    if (!isTouch || !tc) return;
    tc.classList.remove('hidden');
    // HUD 속도계·부스터 게이지·미니맵을 버튼 위로 올리는 CSS 훅
    document.body.classList.add('touch-mode');
    const bind = (id, on, off) => {
      const el = document.querySelector(id);
      if (!el) return;
      const down = (e) => { e.preventDefault(); on(); };
      const up = (e) => { e.preventDefault(); off?.(); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up); // 누른 채 버튼 밖으로 미끄러진 손가락
      this._touchBinds.push([el, down, up]);
    };
    const t = this.touch;
    bind('#tc-left', () => { t.l = true; }, () => { t.l = false; });
    bind('#tc-right', () => { t.r = true; }, () => { t.r = false; });
    bind('#tc-accel', () => { t.throttle = true; }, () => { t.throttle = false; });
    bind('#tc-brake', () => { t.brake = true; }, () => { t.brake = false; });
    bind('#tc-drift', () => { t.drift = true; }, () => { t.drift = false; });
    bind('#tc-beam', () => { t.high = true; }, () => { t.high = false; });
    bind('#tc-cam', () => this.onToggleView(), null); // 탭 = 시점 전환
  }

  unbindTouch() {
    for (const [el, down, up] of this._touchBinds) {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', up);
    }
    this._touchBinds = [];
    document.querySelector('#touch-controls')?.classList.add('hidden');
    document.body.classList.remove('touch-mode');
  }

  // ── 게임패드: 이벤트가 없어 매 프레임 폴링 (표준 매핑) ──
  // 좌스틱/십자 조향 · RT 가속 · LT 브레이크 · A 드리프트 · X 상향등 · Y 시점 전환
  pollPad() {
    const p = this.pad;
    let gp = null;
    if (navigator.getGamepads) {
      for (const g of navigator.getGamepads()) {
        if (g && g.connected) { gp = g; break; }
      }
    }
    if (!gp) {
      if (this.padActive) { // 연결 해제 순간 잔류 입력 제거
        p.steer = p.throttle = p.brake = 0;
        p.drift = p.high = false;
        this.padActive = false;
      }
      return;
    }
    this.padActive = true;
    const btn = (i) => gp.buttons[i] || { pressed: false, value: 0 };
    const ax = gp.axes[0] || 0;
    // 스틱 좌 = 음수 축 = 좌조향(+). 십자키는 디지털 폴백
    p.steer = btn(14).pressed ? 1 : btn(15).pressed ? -1
      : Math.abs(ax) < 0.12 ? 0 : -ax; // 데드존
    p.throttle = Math.max(btn(7).value || 0, btn(12).pressed ? 1 : 0);
    p.brake = Math.max(btn(6).value || 0, btn(13).pressed ? 1 : 0);
    p.drift = btn(0).pressed;
    p.high = btn(2).pressed;
    const view = btn(3).pressed; // 엣지 검출(누르는 동안 연속 토글 방지)
    if (view && !this._padView) this.onToggleView();
    this._padView = view;
  }

  // 키보드·패드·터치를 하나의 아날로그 컨트롤로 합성 — car.update/연출의 단일 입력원
  collect() {
    const k = this.kb, p = this.pad, t = this.touch;
    const steer = (k.left ? 1 : 0) - (k.right ? 1 : 0) + p.steer + (t.l ? 1 : 0) - (t.r ? 1 : 0);
    return {
      steer: THREE.MathUtils.clamp(steer, -1, 1),
      throttle: Math.max(k.forward ? 1 : 0, p.throttle, t.throttle ? 1 : 0),
      brake: Math.max(k.backward ? 1 : 0, p.brake, t.brake ? 1 : 0),
      drift: k.drift || p.drift || t.drift,
      highBeam: k.highBeam || p.high || t.high,
    };
  }

  dispose() {
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    this.unbindTouch();
  }
}
