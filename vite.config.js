import { defineConfig } from 'vite';

export default defineConfig({
  // Tailscale 등 외부 기기 접속 허용 (localhost 전용 바인딩 해제)
  server: { host: true },
  preview: { host: true },
});
