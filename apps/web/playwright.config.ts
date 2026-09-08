// Playwright E2E para el ciclo de vida de pantalla completa de ViewPlayerPage.
//
// Resolución del navegador:
//   · `PW_CHROMIUM_PATH` explícito, si se define;
//   · el Chromium PREINSTALADO del entorno (no ejecutar `playwright install` acá),
//     si ese binario existe;
//   · en su defecto (p. ej. CI, donde el job corre `playwright install chromium`),
//     se deja sin `executablePath` y Playwright usa el Chromium que instaló.
import { defineConfig } from '@playwright/test'
import { existsSync } from 'fs'

const PREINSTALLED = '/opt/pw-browsers/chromium'
const executablePath =
  process.env.PW_CHROMIUM_PATH ||
  (existsSync(PREINSTALLED) ? PREINSTALLED : undefined)

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5199',
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npx vite --config vite.config.e2e.ts --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
