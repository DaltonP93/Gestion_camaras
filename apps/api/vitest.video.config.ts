// Configuración PROPIA de la suite de reproducción con video real (NVR simulado).
// `npm test` NO la levanta (el include por defecto es src/**/*.test.ts); se corre
// con `npm run test:video`. Ver src/playback-video/README.md.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/playback-video/scenarios/**/*.video.ts'],
    exclude: ['node_modules', 'dist'],
    globalSetup: ['src/playback-video/lib/global-setup.ts'],
    setupFiles: ['src/playback-video/lib/mocks.setup.ts'],
    // Un archivo a la vez: cada uno levanta API + web + navegador + FFmpeg reales y
    // las mediciones de tiempo no deben competir por CPU con otro archivo.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 300_000,
    hookTimeout: 240_000,
    teardownTimeout: 60_000,
  },
})
