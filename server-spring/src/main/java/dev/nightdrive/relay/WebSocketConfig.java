package dev.nightdrive.relay;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final RelayHandler relayHandler;

    public WebSocketConfig(RelayHandler relayHandler) {
        this.relayHandler = relayHandler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // Node relay와 동일하게 루트 경로 — 클라이언트는 ws://host:8787/ 로 접속
        registry.addHandler(relayHandler, "/").setAllowedOrigins("*");
    }
}
