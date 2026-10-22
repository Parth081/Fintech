import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const GATEWAY = 'http://127.0.0.1:7072';

/**
 * The screen must work fully offline. React's production build embeds a link to its online
 * error decoder; replace it so the bundle carries no URLs to external hosts.
 */
function offlineOnly(): Plugin {
  return {
    name: 'ct-offline-only',
    apply: 'build',
    renderChunk(code) {
      if (!code.includes('https://react.dev/errors/')) return null;
      return { code: code.replaceAll('https://react.dev/errors/', 'react-error #'), map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineOnly()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: GATEWAY, changeOrigin: true },
      '/health': { target: GATEWAY, changeOrigin: true },
      '/ws': { target: GATEWAY, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
