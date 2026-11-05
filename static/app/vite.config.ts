/**
 * Vite build config of the Custom UI: React plugin, a relative base path because Forge serves the bundle
 * from one, the @shared alias to src/shared, and output to static/app/dist, the manifest's main resource.
 *
 * @file        static/app/vite.config.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Forge serves Custom UI from a relative path
  base: './',
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../../src/shared') },
  },
  server: { port: 5173, fs: { allow: ['../..'] } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
