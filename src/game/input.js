// 입력 계층 — 키보드(이벤트) / 게임패드(매 프레임 폴링) / 터치(온스크린 버튼) 3계층을
// 하나의 아날로그 컨트롤 {steer, throttle, brake, highBeam}로 합성한다.
// 게임 로직(game.js)은 매 프레임 pollPad() → collect()만 호출하는 단일 소비자.
// 시점 전환(C키·패드 Y·터치 '시점' 버튼)은 onToggleView 콜백으로 위임.

import * as THREE from 'three';

export class InputSystem {
  constructor({ onToggleView } = {}) {
    this.onToggleView = onToggleView || (() => {});
    // kb는 autoSteer/autodrive(개발용)가 직접 쓰는 공개 상태 — 필드명 유지
    this.kb = { forward: false, backward: false, left: false, right: false, highBeam: false };
    this.pad = { steer: 0, throttle: 0, brake: 0, high: false };
    this.touch = { high: false }; // 가감속·조향은 조이스틱(stick) 전담
    // 가상 조이스틱(모바일): x/y ∈ [-1,1] — x=조향(화면 오른쪽 +), y=아래 +
    this.stick = { id: null, x: 0, y: 0 };
    this._touchBinds = []; // [el, type, fn] — 해제용
  }

  bind() {
    this.onKey = (e, down) => {
      const k = this.kb;
      switch (e.code) {
        case 'ArrowUp': case 'KeyW': k.forward = down; break;
        case 'ArrowDown': case 'KeyS': k.backward = down; break;
        case 'ArrowLeft': case 'KeyA': k.left = down; break;
        case 'ArrowRight': case 'KeyD': k.right = down; break;
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
    // HUD 속도계·미니맵을 버튼 위로 올리는 CSS 훅
    document.body.classList.add('touch-mode');
    const on = (el, type, fn) => {
      el.addEventListener(type, fn);
      this._touchBinds.push([el, type, fn]);
    };
    const bind = (id, press, release) => {
      const el = document.querySelector(id);
      if (!el) return;
      on(el, 'pointerdown', (e) => { e.preventDefault(); press(); });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
        on(el, type, (e) => { e.preventDefault(); release?.(); });
      }
    };
    const t = this.touch;
    bind('#tc-beam', () => { t.high = true; }, () => { t.high = false; });
    bind('#tc-cam', () => this.onToggleView(), null); // 탭 = 시점 전환

    // ── 가상 조이스틱: 베이스에 포인터 캡처 — 스틱 밖으로 나가도 추적 유지 ──
    const base = document.querySelector('#tc-stick');
    const knob = document.querySelector('#tc-stick-knob');
    if (base && knob) {
      const st = this.stick;
      const R = 44; // 노브 이동 반경(px)
      const track = (e) => {
        const r = base.getBoundingClientRect();
        let dx = e.clientX - (r.left + r.width / 2);
        let dy = e.clientY - (r.top + r.height / 2);
        const len = Math.hypot(dx, dy);
        if (len > R) { dx *= R / len; dy *= R / len; }
        st.x = dx / R;
        st.y = dy / R;
        knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
      };
      const reset = () => {
        st.id = null;
        st.x = st.y = 0;
        knob.style.transform = 'translate(0px, 0px)';
      };
      on(base, 'pointerdown', (e) => {
        e.preventDefault();
        st.id = e.pointerId;
        track(e);
        // 캡처 실패(합성 이벤트 등)해도 pointermove로 계속 추적된다
        try { base.setPointerCapture(e.pointerId); } catch { /* noop */ }
      });
      on(base, 'pointermove', (e) => {
        if (st.id === e.pointerId) { e.preventDefault(); track(e); }
      });
      for (const type of ['pointerup', 'pointercancel']) {
        on(base, type, (e) => {
          if (st.id === e.pointerId) { e.preventDefault(); reset(); }
        });
      }
    }
  }

  unbindTouch() {
    for (const [el, type, fn] of this._touchBinds) el.removeEventListener(type, fn);
    this._touchBinds = [];
    this.stick.id = null;
    this.stick.x = this.stick.y = 0;
    document.querySelector('#touch-controls')?.classList.add('hidden');
    document.body.classList.remove('touch-mode');
  }

  // ── 게임패드: 이벤트가 없어 매 프레임 폴링 (표준 매핑) ──
  // 좌스틱/십자 조향 · RT 가속 · LT 브레이크 · X 상향등 · Y 시점 전환
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
        p.high = false;
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
    p.high = btn(2).pressed;
    const view = btn(3).pressed; // 엣지 검출(누르는 동안 연속 토글 방지)
    if (view && !this._padView) this.onToggleView();
    this._padView = view;
  }

  // 키보드·패드·터치(버튼+조이스틱)를 하나의 아날로그 컨트롤로 합성
  collect() {
    const k = this.kb, p = this.pad, t = this.touch;
    // 조이스틱: 데드존(0.15) 제거 후 리스케일. 화면 x+(오른쪽)=조향 -(우회전),
    // y-(위)=스로틀, y+(아래)=브레이크
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const sx = dz(this.stick.x), sy = dz(this.stick.y);
    const steer = (k.left ? 1 : 0) - (k.right ? 1 : 0) + p.steer - sx;
    return {
      steer: THREE.MathUtils.clamp(steer, -1, 1),
      throttle: Math.max(k.forward ? 1 : 0, p.throttle, Math.max(0, -sy)),
      brake: Math.max(k.backward ? 1 : 0, p.brake, Math.max(0, sy)),
      highBeam: k.highBeam || p.high || t.high,
    };
  }

  dispose() {
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    this.unbindTouch();
  }
}
