import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const T = 'http://127.0.0.1:7372';
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true, proxy: { '/api': { target: T }, '/ws': { target: T, ws: true } } },
  build: { outDir: process.env.OUT_DIR, emptyOutDir: true },
});
