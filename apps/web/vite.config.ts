/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  test: {
    // Los specs bajo e2e/ los ejecuta Playwright (usan @playwright/test), no
    // vitest: sin esta exclusión vitest los descubre por el glob `*.spec.ts` y
    // falla al cargar `test.describe` de Playwright.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
