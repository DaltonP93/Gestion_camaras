// Vite config DEDICADO al prototipo navegable (apps/web/prototype). No participa
// del build de producción (`vite build` usa vite.config.ts) ni del harness E2E de
// pantalla completa. El prototipo usa SÓLO datos simulados: no hay proxy a /api ni
// /ws, así que no puede contactar la API, NVR ni MediaMTX.
//   npm run prototype          → servidor de desarrollo en :5198
//   npm run prototype:build    → estático en dist-prototype/ (para revisión)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import path from 'path'
import baseTailwind from './tailwind.config.js'

const root = __dirname

export default defineConfig({
  root: path.resolve(root, 'prototype'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      // Editor de zonas portado de Frigate v0.18.0 (prototype/vendor/frigate, MIT):
      // sus imports `@/…` apuntan a los archivos portados o a sustitutos de
      // VisionCore. Deben ir ANTES del alias genérico `@` → src.
      { find: /^@\/types\/canvas$/, replacement: path.resolve(root, 'prototype/vendor/frigate/types/canvas.ts') },
      { find: /^@\/utils\/canvasUtil$/, replacement: path.resolve(root, 'prototype/vendor/frigate/utils/canvasUtil.ts') },
      { find: /^@\/hooks\/use-polygon-states$/, replacement: path.resolve(root, 'prototype/vendor/frigate/hooks/use-polygon-states.ts') },
      { find: /^@\/api$/, replacement: path.resolve(root, 'prototype/vendor/frigate/api/index.tsx') },
      { find: /^@\/api\/ws$/, replacement: path.resolve(root, 'prototype/zones/shims/ws.ts') },
      { find: /^@\/components\/indicators\/activity-indicator$/, replacement: path.resolve(root, 'prototype/zones/shims/activity-indicator.tsx') },
      { find: /^@\//, replacement: path.resolve(root, 'src') + '/' },
    ],
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({ ...baseTailwind, content: [path.resolve(root, 'prototype/**/*.{ts,tsx,html}')] }),
        autoprefixer(),
      ],
    },
  },
  server: {
    port: 5198,
    strictPort: true,
    fs: { allow: [root] },
  },
  build: {
    outDir: path.resolve(root, 'dist-prototype'),
    emptyOutDir: true,
  },
})
