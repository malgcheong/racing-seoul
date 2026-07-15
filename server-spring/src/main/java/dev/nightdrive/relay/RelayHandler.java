package dev.nightdrive.relay;

// Spring Boot 4 = Jackson 3 (tools.jackson.*) — fasterxml(2.x) 아님에 주의
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 멀티플레이 중계(relay) — 게임 로직 없음, 방 단위 브로드캐스트만.
 * 서버는 권한을 갖지 않는다: 각 클라이언트가 자기 물리를 시뮬하고
 * 상태 스냅샷을 서로 중계받아 재생한다(트래픽은 방장 클라이언트가 시뮬).
 *
 * ── 프로토콜 (server/relay.mjs와 동일 계약 + 방장 승계) ──
 *  서버→클라:
 *   { t:'hello', now }            접속 직후 서버 시각(카운트다운 동기화용)
 *   { t:'rooms', list }           로비 조회 응답: [{ code, n, racing }]
 *   { t:'peers', n, ids }         방 인원 변동 통지(출발 그리드 슬롯 분배용 로스터)
 *   { t:'host',  id }             방장 지정/승계 — 해당 id 클라가 트래픽 시뮬 주체
 *   { t:'left',  id }             피어 퇴장
 *   (이하 릴레이: 보낸 클라 제외 방 전체에 _from 붙여 전달)
 *  클라→서버:
 *   { t:'lobby' }                 대기 중인 방 목록 요청(이 소켓에만 응답)
 *   { t:'join', room, id }        방 입장(없으면 생성, 첫 입장자 = 방장)
 *   { t:'go',   at, seed, tod }   방장 → 레이스 시작(방을 racing으로 표시)
 *   { t:'s',    p,h,v,c,n,pr }    플레이어 스냅샷 ~15Hz
 *   { t:'tf',   cars }            방장 트래픽 스냅샷 ~10Hz
 *   { t:'fin',  time }            완주 통지
 *   { t:'crash', pr }             사고 리타이어 통지(순위표용 진행률)
 *   { t:'rm' }                    재대결 준비(결과 화면) — 전원 모이면 클라들이 재시작
 *   { t:'rr' }                    재대결 리빌드 완료 핑(새 게임이 go 수신 준비됨)
 */
@Component
public class RelayHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(RelayHandler.class);
    private static final ObjectMapper om = new ObjectMapper();

    private static final String ATTR_ROOM = "room";
    private static final String ATTR_ID = "id";

    static class Room {
        final Set<WebSocketSession> peers = ConcurrentHashMap.newKeySet();
        volatile String hostId;
        volatile boolean racing;
    }

    private final Map<String, Room> rooms = new ConcurrentHashMap<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws IOException {
        send(session, Map.of("t", "hello", "now", System.currentTimeMillis()));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException {
        JsonNode m;
        try {
            m = om.readTree(message.getPayload());
        } catch (RuntimeException e) {
            return; // 파싱 불가 메시지 무시 (Jackson 3는 언체크 예외)
        }
        String type = m.path("t").asText("");

        if ("lobby".equals(type)) {
            List<Map<String, Object>> list = new ArrayList<>();
            rooms.forEach((code, r) ->
                list.add(Map.of("code", code, "n", r.peers.size(), "racing", r.racing)));
            send(session, Map.of("t", "rooms", "list", list));
            return;
        }

        if ("join".equals(type)) {
            String code = trunc(m.path("room").asText("").toUpperCase(), 12);
            if (code.isEmpty()) return;
            String id = trunc(m.path("id").asText(""), 12);
            session.getAttributes().put(ATTR_ROOM, code);
            session.getAttributes().put(ATTR_ID, id);
            Room room = rooms.computeIfAbsent(code, k -> new Room());
            room.peers.add(session);
            if (room.hostId == null) room.hostId = id; // 첫 입장자 = 방장
            broadcast(code, peersMsg(room), null);
            broadcast(code, Map.of("t", "host", "id", room.hostId), null);
            log.info("[join] room={} id={} n={}", code, id, room.peers.size());
            return;
        }

        String code = (String) session.getAttributes().get(ATTR_ROOM);
        if (code == null) return;
        Room room = rooms.get(code);
        if (room == null) return;
        if ("go".equals(type)) room.racing = true; // 로비 목록에서 "레이스 중" 처리

        // _from 붙여 릴레이(보낸 클라 제외)
        ObjectNode out = (ObjectNode) m;
        out.put("_from", (String) session.getAttributes().get(ATTR_ID));
        String payload = om.writeValueAsString(out);
        for (WebSocketSession peer : room.peers) {
            if (peer != session && peer.isOpen()) sendRaw(peer, payload);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws IOException {
        String code = (String) session.getAttributes().get(ATTR_ROOM);
        if (code == null) return;
        Room room = rooms.get(code);
        if (room == null) return;
        room.peers.remove(session);
        String id = (String) session.getAttributes().get(ATTR_ID);
        if (room.peers.isEmpty()) {
            rooms.remove(code);
            log.info("[left] room={} id={} (방 소멸)", code, id);
            return;
        }
        broadcast(code, Map.of("t", "left", "id", id), null);
        broadcast(code, peersMsg(room), null);
        // 방장 승계: 방장이 나갔으면 남은 피어 중 하나를 새 방장으로 지정
        if (id != null && id.equals(room.hostId)) {
            WebSocketSession next = room.peers.iterator().next();
            room.hostId = (String) next.getAttributes().get(ATTR_ID);
            broadcast(code, Map.of("t", "host", "id", room.hostId), null);
            log.info("[host] room={} 승계 → {}", code, room.hostId);
        }
        log.info("[left] room={} id={} n={}", code, id, room.peers.size());
    }

    private Map<String, Object> peersMsg(Room room) {
        List<String> ids = new ArrayList<>();
        for (WebSocketSession p : room.peers) ids.add((String) p.getAttributes().get(ATTR_ID));
        return Map.of("t", "peers", "n", room.peers.size(), "ids", ids);
    }

    private void broadcast(String code, Map<String, Object> msg, WebSocketSession except) throws IOException {
        Room room = rooms.get(code);
        if (room == null) return;
        String payload = om.writeValueAsString(msg);
        for (WebSocketSession peer : room.peers) {
            if (peer != except && peer.isOpen()) sendRaw(peer, payload);
        }
    }

    private void send(WebSocketSession session, Map<String, Object> msg) throws IOException {
        sendRaw(session, om.writeValueAsString(msg));
    }

    // 여러 스레드가 같은 세션에 쓰지 않게 세션 단위 동기화(스냅샷 15Hz 수준엔 충분)
    private void sendRaw(WebSocketSession session, String payload) {
        try {
            synchronized (session) {
                session.sendMessage(new TextMessage(payload));
            }
        } catch (IOException | IllegalStateException e) {
            // 끊긴 세션 — close 콜백에서 정리됨
        }
    }

    private static String trunc(String s, int n) {
        return s.length() > n ? s.substring(0, n) : s;
    }
}
