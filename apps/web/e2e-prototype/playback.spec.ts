// Controles multicámara sincronizados: reloj común, pausa, velocidades, seek,
// pistas archivadas, huecos, carga y límite de sesiones por NVR (datos simulados).
import { test, expect, type Page } from '@playwright/test'
import { H, USER, asUser, clockSeconds, freshStart, navTo, seekTo } from './helpers'

async function openPlayback(page: Page) {
  await navTo(page, 'Grabaciones')
  await expect(page.getByTestId('playback-grid')).toBeVisible()
}

async function waitAllLoaded(page: Page) {
  await expect(page.getByTestId('buffering-indicator')).toHaveCount(0, { timeout: 5_000 })
}

test.beforeEach(async ({ page }) => { await freshStart(page) })

test('reproducir avanza el reloj común en todas las celdas; pausa lo detiene', async ({ page }) => {
  await openPlayback(page)
  await expect(page.getByTestId('playback-grid')).toHaveAttribute('data-cells', '4')
  await waitAllLoaded(page)
  const t0 = await clockSeconds(page)
  await page.getByTestId('play-pause').click()
  await expect.poll(() => clockSeconds(page), { timeout: 5_000 }).toBeGreaterThanOrEqual(t0 + 2)
  for (const i of [0, 1, 2, 3]) {
    await expect(page.getByTestId(`pcell-${i}-state`)).toHaveAttribute('data-state', 'reproduciendo')
  }
  // Todas las celdas muestran la MISMA hora que el reloj común.
  const clock = await page.getByTestId('clock').textContent()
  for (const i of [0, 1, 2, 3]) await expect(page.getByTestId(`pcell-${i}-state`)).toContainText(clock!.slice(0, 5))

  await page.getByTestId('play-pause').click()
  const paused = await clockSeconds(page)
  await page.waitForTimeout(1200)
  expect(await clockSeconds(page)).toBe(paused)
  await expect(page.getByTestId('pcell-0-state')).toHaveAttribute('data-state', 'pausa')
})

test('velocidades: el reloj común avanza a 0.5×, 1×, 2× y 4× del tiempo real', async ({ page }) => {
  await openPlayback(page)
  await waitAllLoaded(page)
  // Tasa = segundos simulados / segundos reales, ambos medidos en la página.
  const sample = () => page.getByTestId('clock').evaluate(el => [Number((el as HTMLElement).dataset.tExact), performance.now()])
  const rate = async (speed: string) => {
    await page.getByTestId(`speed-${speed}`).click()
    await expect(page.getByTestId(`speed-${speed}`)).toHaveAttribute('aria-pressed', 'true')
    const [s0, r0] = await sample()
    await page.waitForTimeout(3000)
    const [s1, r1] = await sample()
    return (s1 - s0) / ((r1 - r0) / 1000)
  }
  await page.getByTestId('play-pause').click()
  for (const [speed, expected] of [['1', 1], ['4', 4], ['0.5', 0.5], ['2', 2]] as const) {
    const r = await rate(speed)
    expect(r, `velocidad ${speed}×`).toBeGreaterThan(expected * 0.8)
    expect(r, `velocidad ${speed}×`).toBeLessThan(expected * 1.2)
  }
})

test('seek: el deslizador y ±10 s mueven el reloj común y recargan las celdas', async ({ page }) => {
  await openPlayback(page)
  await waitAllLoaded(page)
  await seekTo(page, 9 * H)
  await expect(page.getByTestId('clock')).toHaveText('09:00:00')
  await expect(page.getByTestId('buffering-indicator')).toBeVisible()
  await waitAllLoaded(page)
  await page.getByTestId('step-forward').click()
  await expect(page.getByTestId('clock')).toHaveText('09:00:10')
  await page.getByTestId('step-back').click()
  await page.getByTestId('step-back').click()
  await expect(page.getByTestId('clock')).toHaveText('08:59:50')
})

test('sincronía estricta: el reloj espera a las celdas que cargan', async ({ page }) => {
  await openPlayback(page)
  await waitAllLoaded(page)
  await page.getByTestId('play-pause').click()
  await seekTo(page, 9 * H)
  await expect(page.getByTestId('buffering-indicator')).toBeVisible()
  expect(await clockSeconds(page)).toBe(9 * H)
  await waitAllLoaded(page)
  await expect.poll(() => clockSeconds(page), { timeout: 5_000 }).toBeGreaterThan(9 * H)
})

test('grilla: usa el subflujo sólo si está archivado; si no, la principal con aviso', async ({ page }) => {
  await openPlayback(page)
  // Celda 0 = Acceso principal (graba ambos), celda 1 = Recepción (sólo principal).
  await expect(page.getByTestId('pcell-0-track')).toHaveText('subflujo · pista 102')
  await expect(page.getByTestId('pcell-1-track')).toHaveText('principal · pista 201')
  await expect(page.getByTestId('pcell-1')).toContainText('el NVR no grabó subflujo')
  // Pasillo norte (celda 2): subflujo sólo hasta las 10:00.
  await expect(page.getByTestId('pcell-2-track')).toHaveText('subflujo · pista 302')
  await seekTo(page, 10.5 * H)
  await expect(page.getByTestId('pcell-2-track')).toHaveText('principal · pista 301')
})

test('huecos: la celda lo indica y permite saltar al próximo tramo', async ({ page }) => {
  await openPlayback(page)
  await page.getByTestId('pick-cam-a5').check() // Caja: grabación por eventos
  await seekTo(page, 8.5 * H)
  await expect(page.getByTestId('pcell-4-state')).toHaveAttribute('data-state', 'hueco')
  await page.getByTestId('pcell-4-jump').click()
  await expect(page.getByTestId('clock')).toHaveText('09:00:00')
  await expect(page.getByTestId('pcell-4-state')).not.toHaveAttribute('data-state', 'hueco')
  await expect(page.getByTestId('tl-cam-a5')).toBeVisible()
})

test('límite de sesiones por NVR: el excedente queda en cola con posición, sin superar el límite', async ({ page }) => {
  await openPlayback(page)
  await page.getByTestId('pick-cam-a5').check()
  await page.getByTestId('pick-cam-a6').check()
  await expect(page.getByTestId('playback-grid')).toHaveAttribute('data-cells', '9')
  await expect(page.getByTestId('usage-nvr-a')).toHaveText('NVR Recepción: 4/4 sesiones · 2 en cola')
  await expect(page.getByTestId('pcell-4-state')).toHaveAttribute('data-state', 'en-cola')
  await expect(page.getByTestId('pcell-4')).toContainText('posición 1')
  await expect(page.getByTestId('pcell-5')).toContainText('posición 2')
  // Quitar una cámara libera un cupo: la primera en cola pasa a activa.
  await page.getByTestId('pick-cam-a2').uncheck()
  await expect(page.getByTestId('usage-nvr-a')).toHaveText('NVR Recepción: 4/4 sesiones · 1 en cola')
})

test('permisos: AUDITOR sólo elige cámaras con canPlayback; OPERATOR no accede', async ({ page }) => {
  await asUser(page, USER.AUDITOR)
  await openPlayback(page)
  for (const id of ['cam-a1', 'cam-a2', 'cam-a5', 'cam-b1', 'cam-b2']) await expect(page.getByTestId(`pick-${id}`)).toBeVisible()
  for (const id of ['cam-a3', 'cam-a4', 'cam-a6', 'cam-b3']) await expect(page.getByTestId(`pick-${id}`)).toHaveCount(0)
  await asUser(page, USER.OPERATOR)
  await expect(page.getByTestId('no-access')).toBeVisible()
  await page.goto('/#/grabaciones')
  await expect(page.getByTestId('no-access')).toBeVisible()
})
