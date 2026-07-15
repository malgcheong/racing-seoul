// 멀티플레이 넷 클라이언트 — relay 서버(server/relay.mjs)와의 WebSocket 얇은 래퍼.
// 서버 시각 오프셋(hello)으로 카운트다운을 피어 간 동기화한다.

export class NetClient {
  constructor(url) {
    this.id = Math.random().toString(36).slice(2, 8); // 피어 식별자
    this.offset = 0; // serverNow - localNow
    this.handlers = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('relay 연결 실패'));
    });
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') this.offset = m.now - Date.now();
      const fn = this.handlers.get(m.t);
      if (fn) fn(m);
    };
  }

  join(room) {
    this.ready.then(() => this.ws.send(JSON.stringify({ t: 'join', room, id: this.id })));
  }

  on(type, fn) { this.handlers.set(type, fn); }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  serverNow() { return Date.now() + this.offset; }

  close() { try { this.ws.close(); } catch { /* noop */ } }
}
