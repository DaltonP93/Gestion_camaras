// Playwright del PROTOTIPO navegable (apps/web/prototype, datos simulados).
// Separado de playwright.config.ts (ciclo de vida de pantalla completa) para no
// mezclar suites: `npm run test:e2e:prototype`.
// Proyectos = dispositivos objetivo: PC y tablet (horizontal y vertical, táctil).
import { defineConfig } from '@playwright/test'
import { existsSync } from 'fs'

const PREINSTALLED = '/opt/pw-browsers/chromium'
const executablePath =
  process.env.PW_CHROMIUM_PATH ||
  (existsSync(PREINSTALLED) ? PREINSTALLED : undefined)
const launch = executablePath ? { launchOptions: { executablePath } } : {}

export default defineConfig({
  testDir: './e2e-prototype',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-prototype' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5198',
    headless: true,
    trace: 'retain-on-failure',
    ...launch,
  },
  projects: [
    { name: 'pc', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'tablet-horizontal', use: { browserName: 'chromium', viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
    { name: 'tablet-vertical', use: { browserName: 'chromium', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: 'npx vite --config vite.config.prototype.ts --port 5198 --strictPort',
    url: 'http://localhost:5198',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
