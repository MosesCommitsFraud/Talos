import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev proxy target: the FastAPI backend (docker compose default :7000), or the
// mock UI-preview server (scripts/ui_preview.py, :5178) when working without
// the full stack: TALOS_PROXY=http://127.0.0.1:5178 npm run dev
const proxyTarget = process.env.TALOS_PROXY || 'http://127.0.0.1:7000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5180,
    proxy: {
      // ws:true forwards WebSocket upgrades (voice dictation /api/voice/stream).
      '/api': { target: proxyTarget, changeOrigin: true, ws: true },
      // Legacy assets the new UI still references (self-hosted fonts).
      '/static': { target: proxyTarget, changeOrigin: true },
      '/login': { target: proxyTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
