import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: UI on :5173, /api proxied to the gateway, so no CORS.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: process.env.GATEWAY_URL ?? 'http://localhost:8787', rewrite: (p) => p.replace(/^\/api/, '') } } },
});
