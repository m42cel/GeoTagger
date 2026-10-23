import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const API_TARGET = process.env.GEOTAGGER_API ?? 'http://127.0.0.1:8080';

// The root package.json holds the one version, the same one the server reads.
const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
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
