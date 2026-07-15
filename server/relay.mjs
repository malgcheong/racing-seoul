// 멀티플레이 중계(relay) 서버 — 게임 로직 없음, 방 단위 브로드캐스트만.
// 서버는 권한을 갖지 않는다: 각 클라이언트가 자기 물리를 시뮬하고
// 상태 스냅샷을 서로 중계받아 재생한다(트래픽은 방장 클라이언트가 시뮬).
//
// ── 프로토콜 (JSON, 추후 Spring Boot WebSocket으로 포팅 시 그대로 구현) ──
//  서버→클라:
//   { t:'hello', now }            접속 직후 서버 시각(카운트다운 동기화용 오프셋 계산)
//   { t:'rooms', list }           로비 조회 응답: [{ code, n, racing }]
//   { t:'peers', n }              방 인원 변동 통지
//   { t:'left',  id }             피어 퇴장(원격 차 제거용)
//   (이하 릴레이: 보낸 클라 제외 방 전체에 _from 붙여 전달)
//  클라→서버:
//   { t:'lobby' }                 대기 중인 방 목록 요청(입장 전, 이 소켓에만 응답)
//   { t:'join', room, id }        방 입장(없으면 생성). id = 클라 생성 랜덤 식별자
//   { t:'go',   at, seed, tod }   방장 → 레이스 시작(릴레이는 방을 racing으로 표시)
//   { t:'s',    p,h,v,c,n,pr }    플레이어 스냅샷(위치/헤딩/속도/차종/닉네임/진행률) ~15Hz
//   { t:'tf',   cars }            방장 트래픽 스냅샷 ~10Hz
//   { t:'fin',  time }            완주 통지
//   { t:'crash', pr }             사고 리타이어 통지(순위표용 진행률)
//   { t:'rm' }                    재대결 준비(결과 화면) — 전원 모이면 클라들이 재시작
//   { t:'rr' }                    재대결 리빌드 완료 핑(새 게임이 go 수신 준비됨)
//
// 실행: npm run relay  (ws://localhost:8787)

import { WebSocketServer } from 'ws';

const PORT = 8787;
const rooms = new Map(); // code -> { peers: Set<ws>, racing: boolean }

const wss = new WebSocketServer({ port: PORT });

function broadcast(code, msg, except = null) {
  const r = rooms.get(code);
  if (!r) return;
  const s = JSON.stringify(msg);
  for (const c of r.peers) if (c !== except && c.readyState === 1) c.send(s);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'hello', now: Date.now() }));

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf); } catch { return; }

    if (m.t === 'lobby') {
      const list = [...rooms.entries()].map(([code, r]) => ({
        code, n: r.peers.size, racing: r.racing,
      }));
      ws.send(JSON.stringify({ t: 'rooms', list }));
      return;
    }

    if (m.t === 'join') {
      const code = String(m.room || '').toUpperCase().slice(0, 12);
      if (!code) return;
      ws._room = code;
      ws._id = String(m.id || '').slice(0, 12);
      if (!rooms.has(code)) rooms.set(code, { peers: new Set(), racing: false, hostId: null });
      const room = rooms.get(code);
      room.peers.add(ws);
      if (!room.hostId) room.hostId = ws._id; // 첫 입장자 = 방장
      // ids 로스터 포함 — 클라이언트들이 출발 그리드 슬롯을 결정적으로 나눠 갖는다
      broadcast(code, { t: 'peers', n: room.peers.size, ids: [...room.peers].map((w) => w._id) });
      broadcast(code, { t: 'host', id: room.hostId });
      console.log(`[join] room=${code} id=${ws._id} n=${room.peers.size}`);
      return;
    }

    if (!ws._room) return;
    if (m.t === 'go') {
      const r = rooms.get(ws._room);
      if (r) r.racing = true; // 로비 목록에서 "레이스 중" 처리
    }
    m._from = ws._id;
    broadcast(ws._room, m, ws);
  });

  ws.on('close', () => {
    const r = rooms.get(ws._room);
    if (!r) return;
    r.peers.delete(ws);
    if (!r.peers.size) { rooms.delete(ws._room); return; }
    broadcast(ws._room, { t: 'left', id: ws._id });
    broadcast(ws._room, { t: 'peers', n: r.peers.size, ids: [...r.peers].map((w) => w._id) });
    // 방장 승계: 방장이 나갔으면 남은 피어 중 하나를 새 방장으로
    if (ws._id === r.hostId) {
      r.hostId = [...r.peers][0]._id;
      broadcast(ws._room, { t: 'host', id: r.hostId });
      console.log(`[host] room=${ws._room} 승계 → ${r.hostId}`);
    }
    console.log(`[left] room=${ws._room} id=${ws._id}`);
  });
});

console.log(`relay listening on ws://localhost:${PORT}`);
