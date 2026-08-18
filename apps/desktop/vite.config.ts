import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri serves the dev server on a fixed port and cannot fall back to another one.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { target: 'chrome110', sourcemap: true, outDir: 'dist' },
});
