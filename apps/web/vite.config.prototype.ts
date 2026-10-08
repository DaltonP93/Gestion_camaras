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
    alias: [{ find: /^@\//, replacement: path.resolve(root, 'src') + '/' }],
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
