import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.GEOTAGGER_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the UI runs from Vite and the backend from Node; in production
    // Fastify serves this build directly, so paths stay identical in both modes.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/tiles': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
