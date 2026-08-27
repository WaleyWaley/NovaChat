import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // API + WebSocket → Fastify 网关
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      // C++ 服务反向推送 (浏览器不会用到, 与 nginx 保持一致)
      '/nova.gateway.PushService': 'http://localhost:3000',
      // 直连 user-service — 复刻 nginx 的 rewrite 规则:
      // nginx: /direct/user/ → user-service:8001/nova.user.UserService/
      '/direct/user': {
        target: 'http://localhost:8001',
        rewrite: (p) => p.replace(/^\/direct\/user/, '/nova.user.UserService'),
      },
    },
  },
  build: { outDir: 'dist' },
});
