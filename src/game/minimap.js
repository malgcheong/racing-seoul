// 코스 미니맵 — 캔버스 2D HUD 오버레이.
// 정적 코스(본선·분기·강)는 오프스크린 캔버스에 1회만 그리고,
// 매 틱(~10Hz)에는 그 위에 플레이어/상대 점만 얹는다 — 비용 거의 0.

export class Minimap {
  constructor(hudEl, samples, branch, river) {
    this.w = 172;
    this.h = 172;
    const PAD = 14;

    // 월드(x,z) → 맵 좌표 변환 (본선+분기 전체 bbox 균등 스케일, 중앙 정렬)
    const pts = samples.map((s) => s.pos);
    const bpts = branch ? branch.samples.map((s) => s.pos) : [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of [...pts, ...bpts]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const sc = Math.min((this.w - PAD * 2) / (maxX - minX), (this.h - PAD * 2) / (maxZ - minZ));
    const ox = (this.w - (maxX - minX) * sc) / 2;
    const oy = (this.h - (maxZ - minZ) * sc) / 2;
    this.tx = (x, z) => [ox + (x - minX) * sc, oy + (z - minZ) * sc];

    // 정적 베이스
    this.base = document.createElement('canvas');
    this.base.width = this.w;
    this.base.height = this.h;
    const b = this.base.getContext('2d');
    b.fillStyle = 'rgba(8, 12, 22, 0.6)';
    b.beginPath();
    b.roundRect(0, 0, this.w, this.h, 14);
    b.fill();
    // 강(한강) 밴드 — 방향 감각용
    if (river) {
      const [rx0] = this.tx(river.x0, 0);
      const [rx1] = this.tx(river.x1, 0);
      b.fillStyle = 'rgba(70, 110, 190, 0.28)';
      b.fillRect(rx0, 3, rx1 - rx0, this.h - 6);
    }
    const line = (arr, color, width) => {
      b.strokeStyle = color;
      b.lineWidth = width;
      b.lineJoin = 'round';
      b.beginPath();
      arr.forEach((p, i) => {
        const [x, y] = this.tx(p.x, p.z);
        if (i === 0) b.moveTo(x, y);
        else b.lineTo(x, y);
      });
      b.stroke();
    };
    if (bpts.length) line(bpts, 'rgba(92, 190, 165, 0.85)', 2); // 분기(올림픽대로)
    line(pts, 'rgba(200, 208, 226, 0.9)', 2.5);                 // 본선
    // 출발(원)·도착(사각) 마커
    const mark = (p, color, square = false) => {
      const [x, y] = this.tx(p.x, p.z);
      b.fillStyle = color;
      if (square) b.fillRect(x - 3, y - 3, 6, 6);
      else { b.beginPath(); b.arc(x, y, 3, 0, Math.PI * 2); b.fill(); }
    };
    mark(pts[0], '#9fe07a');
    mark(pts[pts.length - 1], '#f0f2f8', true);
    if (bpts.length) mark(bpts[bpts.length - 30] || bpts[bpts.length - 1], 'rgba(92,190,165,1)', true);

    // 표시용 캔버스
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.canvas.className = 'minimap';
    hudEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.drawImage(this.base, 0, 0);
  }

  // playerPos: {x,z}, heading: 라디안, remotes: [{x,z}...]
  update(playerPos, heading, remotes = []) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    c.drawImage(this.base, 0, 0);
    // 상대(빨간 점)
    c.fillStyle = '#ff7069';
    for (const p of remotes) {
      const [x, y] = this.tx(p.x, p.z);
      c.beginPath();
      c.arc(x, y, 2.6, 0, Math.PI * 2);
      c.fill();
    }
    // 플레이어(노란 점 + 진행 방향 틱)
    const [px, py] = this.tx(playerPos.x, playerPos.z);
    c.strokeStyle = '#ffd75e';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px + Math.sin(heading) * 7, py + Math.cos(heading) * 7);
    c.stroke();
    c.fillStyle = '#ffd75e';
    c.beginPath();
    c.arc(px, py, 3.4, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(20,24,38,0.9)';
    c.lineWidth = 1.2;
    c.stroke();
  }

  dispose() {
    this.canvas.remove();
  }
}
