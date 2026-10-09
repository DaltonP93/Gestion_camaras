// Ajustes pedidos sobre las capturas del prototipo (#188), en PC, tablet horizontal
// y tablet vertical: selector lateral plegable, proporción 16:9 de cada celda,
// timeline con horas/zoom/huecos, sincronía por celda (reloj común, desfase,
// Resincronizar, "Esperar a todas" opcional), marca de simulado/existente en
// Configuración y aviso de que el prototipo no prueba la ausencia de pausas.
// Sin errores ni advertencias de consola.
import { test, expect, type Page } from '@playwright/test'
import { H, USER, asUser, freshStart, goSection, navTo, openPanel, pickCamera, selectViewer, trackConsole } from './helpers'
import { ALL_SECTIONS, fieldBackend } from '../prototype/settings/sections'
import { backendText } from '../prototype/model/backend'

let consoleProblems: string[] = []
test.beforeEach(async ({ page }) => {
  consoleProblems = trackConsole(page)
  await freshStart(page)
})
test.afterEach(() => { expect(consoleProblems, 'sin errores ni advertencias de consola').toEqual([]) })

const isVertical = (name: string) => name === 'tablet-vertical'

async function openPlayback(page: Page) {
  await navTo(page, 'Grabaciones')
  await expect(page.getByTestId('playback-grid')).toBeVisible()
}

async function waitAllLoaded(page: Page) {
  await expect(page.getByTestId('buffering-indicator')).toHaveCount(0, { timeout: 5_000 })
}

/** Proporción de cada celda de video visible en la grilla: 16:9 ± 2 %. */
async function expectVideoCells16x9(page: Page, gridTestId: string, expectedCells: number) {
  const ratios = await page.getByTestId(gridTestId).locator('[data-video-cell]').evaluateAll(els =>
    els.map(el => {
      const r = el.getBoundingClientRect()
      return { id: el.getAttribute('data-testid'), w: r.width, h: r.height }
    }))
  expect(ratios).toHaveLength(expectedCells)
  for (const r of ratios) {
    expect(r.w, `${r.id} con ancho`).toBeGreaterThan(100)
    const err = Math.abs(r.w / r.h - 16 / 9) / (16 / 9)
    expect(err, `${r.id}: ${r.w.toFixed(1)}×${r.h.toFixed(1)}`).toBeLessThanOrEqual(0.02)
  }
}

/** Los bloques de Grabaciones se apilan sin superponerse (la grilla ajustada no tapa el timeline ni lo de abajo). */
async function expectStacked(page: Page, ids: string[]) {
  const boxes = await Promise.all(ids.map(async id => ({ id, b: (await page.getByTestId(id).boundingBox())! })))
  for (let k = 1; k < boxes.length; k++) {
    const prev = boxes[k - 1]
    expect(boxes[k].b.y, `${boxes[k].id} empieza debajo de ${prev.id}`).toBeGreaterThanOrEqual(prev.b.y + prev.b.height - 0.5)
  }
}

/** Reloj común y estado de cada celda leídos en el MISMO instante. */
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const clock = Number((document.querySelector('[data-testid="clock"]') as HTMLElement).dataset.tExact)
    const cells = Array.from(document.querySelectorAll<HTMLElement>('[data-testid$="-state"][data-pos]')).map(el => ({
      id: el.dataset.testid!.replace('-state', ''),
      state: el.dataset.state!,
      pos: Number(el.dataset.pos),
      offset: Number(el.dataset.offset),
    }))
    return { clock, cells: Object.fromEntries(cells.map(c => [c.id, c])) }
  })
}

// ─── 1. Selector lateral plegable ─────────────────────────────────────────────

for (const [route, panel, label] of [
  ['/vivo', 'viewer-panel', 'Vivo'],
  ['/grabaciones', 'camera-picker', 'Grabaciones'],
  ['/configuracion/seguridad', 'settings-nav', 'Configuración'],
] as const) {
  test(`selector lateral de ${label}: plegado por defecto en tablet vertical, abre y cierra con el botón`, async ({ page }, info) => {
    await page.goto(`/#${route}`)
    const toggle = page.getByTestId(`${panel}-toggle`)
    const content = page.getByTestId(`${panel}-content`)
    if (!isVertical(info.project.name)) {
      // PC y tablet horizontal: visible a la izquierda, sin botón.
      await expect(content).toBeVisible()
      await expect(toggle).toBeHidden()
      return
    }
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(content).toBeHidden()
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await toggle.click()
    await expect(content).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(content).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // Escape también lo pliega.
    await toggle.click()
    await expect(content).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(content).toBeHidden()
  })
}

test('tablet vertical: elegir un visor pliega el selector y deja la grilla a la vista', async ({ page }, info) => {
  test.skip(!isVertical(info.project.name), 'sólo tablet vertical')
  await selectViewer(page, 'v-deposito')
  await expect(page.getByTestId('viewer-title')).toHaveText('Depósito')
  await expect(page.getByTestId('viewer-panel-content')).toBeHidden()
  await expect(page.getByTestId('viewer-panel-toggle')).toContainText('Depósito')
  await expect(page.getByTestId('cell-0')).toBeInViewport()
})

// ─── 2. Proporción 16:9 ───────────────────────────────────────────────────────

test('vivo: cada celda de video conserva 16:9 (±2 %) en 2×2, 3×3 y ampliada 1×1', async ({ page }) => {
  await expect(page.getByTestId('live-grid')).toHaveAttribute('data-cells', '4')
  await expectVideoCells16x9(page, 'live-grid', 4)
  await selectViewer(page, 'v-sup-ronda')
  await expect(page.getByTestId('live-grid')).toHaveAttribute('data-cells', '9')
  await expectVideoCells16x9(page, 'live-grid', 9)
  await page.getByTestId('cell-0-expand').click()
  await expect(page.getByTestId('live-grid')).toHaveAttribute('data-cells', '1')
  await expectVideoCells16x9(page, 'live-grid', 1)
})

test('grabaciones: cada celda de video conserva 16:9 (±2 %) con 4, 9 y 1 cámaras', async ({ page }) => {
  const stack = ['playback-controls', 'playback-grid', 'timeline', 'sync-sim']
  await openPlayback(page)
  await expectVideoCells16x9(page, 'playback-grid', 4)
  await expectStacked(page, stack)
  for (const id of ['cam-a5', 'cam-a6', 'cam-b1', 'cam-b2', 'cam-b3']) await pickCamera(page, id) // 9 cámaras: 9 filas de timeline
  await expect(page.getByTestId('playback-grid')).toHaveAttribute('data-cells', '9')
  await expectVideoCells16x9(page, 'playback-grid', 9)
  await expectStacked(page, stack)
  for (const id of ['cam-a2', 'cam-a3', 'cam-a4', 'cam-a5', 'cam-a6', 'cam-b1', 'cam-b2', 'cam-b3']) await pickCamera(page, id, false)
  await expect(page.getByTestId('playback-grid')).toHaveAttribute('data-cells', '1')
  await expectVideoCells16x9(page, 'playback-grid', 1)
  await expectStacked(page, stack)
})

test('grabaciones (PC y tablet horizontal): grilla 16:9 y timeline completo entran en la pantalla; el aviso de carga no cambia la grilla', async ({ page }, info) => {
  test.skip(isVertical(info.project.name), 'en tablet vertical la grilla usa todo el ancho y la página se desplaza')
  await openPlayback(page)
  await waitAllLoaded(page)
  const vh = page.viewportSize()!.height
  const timeline = (await page.getByTestId('timeline').boundingBox())!
  expect(timeline.y + timeline.height, 'timeline completo a la vista').toBeLessThanOrEqual(vh + 1)
  const grid = (await page.getByTestId('playback-grid').boundingBox())!
  const box = (await page.getByTestId('playback-grid-box').boundingBox())!
  expect(grid.height).toBeLessThanOrEqual(box.height + 1) // no desborda su lugar
  await expectVideoCells16x9(page, 'playback-grid', 4)
  // Buscar recarga las celdas ("Cargando"): el indicador tiene lugar fijo y la grilla no cambia de tamaño.
  await page.getByTestId('step-forward').click()
  await expect(page.getByTestId('buffering-indicator')).toBeVisible()
  const during = (await page.getByTestId('playback-grid').boundingBox())!
  expect(Math.abs(during.width - grid.width)).toBeLessThan(1)
  expect(Math.abs(during.height - grid.height)).toBeLessThan(1)
})

// ─── 3. Timeline: horas, zoom, huecos ─────────────────────────────────────────

const hm = (s: number) => `${String(Math.floor(s / H)).padStart(2, '0')}:${String(Math.floor((s % H) / 60)).padStart(2, '0')}`
const series = (from: number, to: number, step: number) => {
  const out: string[] = []
  for (let t = from; t <= to; t += step) out.push(hm(t))
  return out
}

test('timeline: marcas HH:MM según el zoom; + y − cambian el rango visible con el cabezal a la vista', async ({ page }) => {
  await openPlayback(page)
  const tl = page.getByTestId('timeline')
  const labels = () => tl.getByTestId('tl-tick-label').allTextContents()
  const playheadInside = async () => {
    const tracks = (await page.getByTestId('tl-tracks').boundingBox())!
    const ph = (await page.getByTestId('tl-playhead').boundingBox())!
    expect(ph.x + ph.width / 2).toBeGreaterThanOrEqual(tracks.x - 1)
    expect(ph.x + ph.width / 2).toBeLessThanOrEqual(tracks.x + tracks.width + 1)
  }
  for (const id of ['tl-zoom-in', 'tl-zoom-out']) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44)

  // Por defecto 6 h centradas en el cabezal (08:00): marcas cada 30 min.
  await expect(page.getByTestId('tl-zoom-level')).toHaveText('6 h')
  await expect(page.getByTestId('tl-range')).toHaveText('05:00–11:00')
  expect(await labels()).toEqual(series(5 * H, 11 * H, 30 * 60))
  await playheadInside()

  await page.getByTestId('tl-zoom-in').click() // 1 h: cada 5 min
  await expect(page.getByTestId('tl-zoom-level')).toHaveText('1 h')
  await expect(tl).toHaveAttribute('data-start', String(7.5 * H))
  await expect(tl).toHaveAttribute('data-end', String(8.5 * H))
  expect(await labels()).toEqual(series(7.5 * H, 8.5 * H, 5 * 60))
  await playheadInside()

  await page.getByTestId('tl-zoom-in').click() // 15 min: cada minuto
  await expect(page.getByTestId('tl-zoom-level')).toHaveText('15 min')
  await expect(page.getByTestId('tl-range')).toHaveText('07:52:30–08:07:30')
  expect(await labels()).toEqual(series(7 * H + 53 * 60, 8 * H + 7 * 60, 60))
  await expect(page.getByTestId('tl-zoom-in')).toBeDisabled()
  await playheadInside()

  for (let k = 0; k < 3; k++) await page.getByTestId('tl-zoom-out').click() // 24 h: cada 2 h
  await expect(page.getByTestId('tl-zoom-level')).toHaveText('24 h')
  await expect(page.getByTestId('tl-range')).toHaveText('00:00–24:00')
  expect(await labels()).toEqual(series(0, 24 * H, 2 * H))
  await expect(page.getByTestId('tl-zoom-out')).toBeDisabled()
  await playheadInside()
})

test('timeline: una fila por cámara, huecos con su hora de inicio y fin, y tocar la línea busca', async ({ page }, info) => {
  await openPlayback(page)
  await pickCamera(page, 'cam-a5') // Caja: grabación por eventos
  const gapLabels = (id: string) => page.getByTestId(`tl-${id}`).locator('[role="img"]').evaluateAll(els => els.map(e => e.getAttribute('aria-label')))
  for (const id of ['cam-a1', 'cam-a2', 'cam-a3', 'cam-a4', 'cam-a5']) await expect(page.getByTestId(`tl-${id}`)).toBeVisible()
  expect(await gapLabels('cam-a5')).toEqual([
    'Sin grabación de 00:00 a 08:00', 'Sin grabación de 08:15 a 09:00', 'Sin grabación de 09:30 a 11:00',
  ])
  expect(await gapLabels('cam-a1')).toEqual([])
  // Visualmente distinto: rayado propio (clase tl-gap) y texto con el rango si entra.
  const gap = page.getByTestId('gap-cam-a5-2')
  await expect(gap).toHaveClass(/tl-gap/)
  await expect(gap).toHaveAttribute('data-start', String(9.5 * H))
  await expect(gap).toHaveAttribute('data-end', String(11 * H))
  await expect(gap).toContainText('sin grabación 09:30–11:00')

  await page.getByTestId('tl-zoom-out').click() // 24 h
  expect(await gapLabels('cam-a5')).toEqual([
    'Sin grabación de 00:00 a 08:00', 'Sin grabación de 08:15 a 09:00', 'Sin grabación de 09:30 a 11:00', 'Sin grabación de 11:30 a 24:00',
  ])
  await page.getByTestId('tl-zoom-in').click() // vuelve a 6 h (05:00–11:00)
  await expect(page.getByTestId('tl-range')).toHaveText('05:00–11:00')

  // Tocar/hacer clic en el 80 % de la línea ⇒ 09:48 (± 2 min por la resolución en píxeles),
  // dentro del hueco de Caja de 09:30 a 11:00.
  const tracks = page.getByTestId('tl-tracks')
  const box = (await tracks.boundingBox())!
  const position = { x: box.width * 0.8, y: box.height - 6 }
  if (info.project.name.startsWith('tablet')) await tracks.tap({ position })
  else await tracks.click({ position })
  await expect.poll(async () => Math.abs(Number(await page.getByTestId('clock').getAttribute('data-t')) - 9.8 * H)).toBeLessThanOrEqual(120)
  await expect(page.getByTestId('pcell-4-state')).toHaveAttribute('data-state', 'hueco')
})

// ─── 4. Sincronía por celda ───────────────────────────────────────────────────

async function stallCell(page: Page, index: number) {
  await page.getByTestId('sim-stall-cell').selectOption(String(index))
  await expect(page.getByTestId('sim-stall-toggle')).toHaveText('Bloquear')
  await page.getByTestId('sim-stall-toggle').click()
  await expect(page.getByTestId('sim-stall-toggle')).toHaveText('Liberar')
}

test('por defecto, una celda bloqueada (el NVR no entrega datos) no detiene a las demás: el reloj común sigue; desfase visible y Resincronizar por celda', async ({ page }) => {
  await openPlayback(page)
  await waitAllLoaded(page)
  await expect(page.getByTestId('strict-sync')).not.toBeChecked()
  await page.getByTestId('play-pause').click()
  await stallCell(page, 1)
  await expect(page.getByTestId('pcell-1-state')).toHaveAttribute('data-state', 'bloqueada')
  await expect(page.getByTestId('buffering-indicator')).toContainText('1 bloqueada')
  const a = await snapshot(page)
  await page.waitForTimeout(2000)
  const b = await snapshot(page)
  // El reloj común siguió y las demás celdas avanzaron con él (≈ 0 s de desfase).
  expect(b.clock - a.clock).toBeGreaterThan(1.5)
  for (const id of ['pcell-0', 'pcell-2', 'pcell-3']) {
    expect(b.cells[id].state).toBe('reproduciendo')
    expect(b.cells[id].pos - a.cells[id].pos).toBeGreaterThan(1.5)
    expect(Math.abs(b.clock - b.cells[id].pos)).toBeLessThan(0.5)
  }
  // La bloqueada quedó congelada y su desfase crece.
  expect(b.cells['pcell-1'].pos).toBe(a.cells['pcell-1'].pos)
  expect(b.cells['pcell-1'].offset).toBeGreaterThan(1.5)

  // Al liberarse sigue atrasada: muestra "desfasada −X s" y su propio botón.
  await page.getByTestId('sim-stall-toggle').click()
  await expect(page.getByTestId('pcell-1-state')).toHaveAttribute('data-state', 'reproduciendo')
  await expect(page.getByTestId('pcell-1-offset')).toHaveText(/^desfasada −\d+\.\d s$/)
  for (const id of ['pcell-0', 'pcell-2', 'pcell-3']) {
    await expect(page.getByTestId(`${id}-offset`)).toHaveCount(0)
    await expect(page.getByTestId(`${id}-resync`)).toHaveCount(0)
  }
  const before = await snapshot(page)
  expect(before.cells['pcell-1'].offset).toBeGreaterThan(1.5)

  // "Resincronizar" recarga SÓLO esa celda. Se lee justo después del clic (< 100 ms)
  // y otra vez 300 ms más tarde: la carga más corta dura 500 ms, así que si el botón
  // recargara todas (p. ej. un seek del reloj común) las demás estarían "cargando".
  await page.evaluate(() => {
    const w = window as unknown as { __resyncClickAt?: number }
    delete w.__resyncClickAt
    document.addEventListener('click', () => { w.__resyncClickAt = performance.now() }, { capture: true, once: true })
  })
  await page.getByTestId('pcell-1-resync').click()
  const [justAfter, later] = await page.evaluate(async () => {
    const w = window as unknown as { __resyncClickAt?: number }
    const read = () => ({
      sinceClickMs: performance.now() - (w.__resyncClickAt ?? Number.NaN),
      clock: Number((document.querySelector('[data-testid="clock"]') as HTMLElement).dataset.tExact),
      indicator: document.querySelector('[data-testid="buffering-indicator"]')?.textContent ?? null,
      cells: Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>('[data-testid$="-state"][data-pos]'))
        .map(el => [el.dataset.testid!.replace('-state', ''), { state: el.dataset.state!, pos: Number(el.dataset.pos) }])),
    })
    const first = read()
    await new Promise(r => setTimeout(r, 300))
    return [first, read()]
  })
  expect(justAfter.sinceClickMs, 'lectura justo después del clic').toBeLessThan(100)
  expect(justAfter.cells['pcell-1'].state).toBe('cargando')
  expect(justAfter.indicator).toBe('Cargando 1 celda(s)')
  expect(later.cells['pcell-1'].state).toBe('cargando')
  expect(later.clock - justAfter.clock).toBeGreaterThan(0.15)
  for (const id of ['pcell-0', 'pcell-2', 'pcell-3']) {
    expect(justAfter.cells[id].state, `${id} justo después del clic`).toBe('reproduciendo')
    expect(later.cells[id].state, `${id} 300 ms después`).toBe('reproduciendo')
    expect(later.cells[id].pos - justAfter.cells[id].pos, `${id} sigue avanzando`).toBeGreaterThan(0.15)
  }

  await expect(page.getByTestId('pcell-1-state')).toHaveAttribute('data-state', 'reproduciendo', { timeout: 5_000 })
  await expect(page.getByTestId('pcell-1-offset')).toHaveCount(0)
  const after = await snapshot(page)
  expect(Math.abs(after.cells['pcell-1'].offset)).toBeLessThan(0.5)
  expect(Math.abs(after.clock - after.cells['pcell-1'].pos)).toBeLessThan(0.5)
  for (const id of ['pcell-0', 'pcell-2', 'pcell-3']) expect(after.cells[id].state).toBe('reproduciendo')
  expect(after.clock).toBeGreaterThan(before.clock)
})

test('por defecto, una celda que CARGA no detiene a las demás: el reloj común sigue', async ({ page }) => {
  await openPlayback(page)
  await waitAllLoaded(page)
  await page.getByTestId('play-pause').click()
  // Depósito interior (NVR B, sólo principal): abre la celda 5 con carga simulada de 1,15 s.
  // (Una cámara del NVR A quedaría en cola: ese NVR admite 4 sesiones.)
  await pickCamera(page, 'cam-b2')
  // Dos lecturas dentro del navegador, 300 ms entre sí, mientras la celda 5 sigue cargando.
  const [a, b] = await page.evaluate(async () => {
    const read = () => {
      const clock = Number((document.querySelector('[data-testid="clock"]') as HTMLElement).dataset.tExact)
      const cells = Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>('[data-testid$="-state"][data-pos]'))
        .map(el => [el.dataset.testid!.replace('-state', ''), { state: el.dataset.state!, pos: Number(el.dataset.pos) }]))
      return { clock, cells }
    }
    const first = read()
    await new Promise(r => setTimeout(r, 300))
    return [first, read()]
  })
  expect(a.cells['pcell-4'].state).toBe('cargando')
  expect(b.cells['pcell-4'].state).toBe('cargando')
  expect(b.clock - a.clock).toBeGreaterThan(0.15)
  for (const id of ['pcell-0', 'pcell-1', 'pcell-2', 'pcell-3']) {
    expect(b.cells[id].state).toBe('reproduciendo')
    expect(b.cells[id].pos - a.cells[id].pos).toBeGreaterThan(0.15)
  }
  // Al terminar de cargar, se ubica en el reloj común (sin desfase).
  await expect(page.getByTestId('pcell-4-state')).toHaveAttribute('data-state', 'reproduciendo', { timeout: 5_000 })
  await expect(page.getByTestId('pcell-4-offset')).toHaveCount(0)
})

type Box = { x: number; y: number; w: number; h: number }

/**
 * Recuadros de la celda leídos en el mismo instante: el centro (estado, desfase,
 * botón) entra completo en la celda y NO se superpone con el encabezado (título e
 * insignia de pista) ni con el pie. Un pie oculto (display: none) no ocupa lugar.
 */
async function expectCellCenterClear(page: Page, cell: string, center: string[]) {
  const ids = [cell, ...center, `${cell}-title`, `${cell}-track`, `${cell}-footer`]
  const boxes = await page.evaluate(list => Object.fromEntries(list.map(id => {
    const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
    return [id, r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null]
  })), ids) as Record<string, Box | null>
  const c = boxes[cell]!
  const label = `${cell} (${c.w.toFixed(0)}×${c.h.toFixed(0)})`
  const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5
  for (const id of [`${cell}-title`, `${cell}-track`]) expect(boxes[id], `${label}: ${id} visible`).not.toBeNull()
  for (const id of center) {
    const b = boxes[id]
    expect(b, `${label}: ${id} visible`).not.toBeNull()
    expect(b!.x, id).toBeGreaterThanOrEqual(c.x - 0.5)
    expect(b!.y, id).toBeGreaterThanOrEqual(c.y - 0.5)
    expect(b!.x + b!.w, id).toBeLessThanOrEqual(c.x + c.w + 0.5)
    expect(b!.y + b!.h, id).toBeLessThanOrEqual(c.y + c.h + 0.5)
    for (const edge of [`${cell}-title`, `${cell}-track`, `${cell}-footer`]) {
      const e = boxes[edge]
      if (e) expect(overlap(b!, e), `${label}: ${id} se superpone con ${edge}`).toBe(false)
    }
  }
}

for (const layout of ['2×2', '3×3'] as const) {
  test(`${layout}: estado, desfase y "Resincronizar" entran en la celda sin superponerse con el encabezado ni el pie, y funcionan`, async ({ page }) => {
    await openPlayback(page)
    if (layout === '3×3') for (const id of ['cam-b1', 'cam-b2', 'cam-a5', 'cam-a6', 'cam-b3']) await pickCamera(page, id)
    await expect(page.getByTestId('playback-grid')).toHaveAttribute('data-cells', layout === '3×3' ? '9' : '4')
    await waitAllLoaded(page)
    // Celda sin desfase: el pie está a la vista (sólo se oculta en celdas compactas que piden atención).
    await expect(page.getByTestId('pcell-0-footer')).toBeVisible()
    await page.getByTestId('play-pause').click()
    await stallCell(page, 1)
    // Bloqueada y ya desfasada: estado + desfase (sin botón mientras está bloqueada).
    await expect(page.getByTestId('pcell-1-offset')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('pcell-1-state')).toHaveAttribute('data-state', 'bloqueada')
    await expectCellCenterClear(page, 'pcell-1', ['pcell-1-state', 'pcell-1-offset'])
    await page.waitForTimeout(1000)
    await page.getByTestId('sim-stall-toggle').click()
    // Liberada y atrasada: estado + desfase + "Resincronizar".
    await expect(page.getByTestId('pcell-1-resync')).toBeVisible()
    await expectCellCenterClear(page, 'pcell-1', ['pcell-1-state', 'pcell-1-offset', 'pcell-1-resync'])
    expect((await page.getByTestId('pcell-1-resync').boundingBox())!.height, 'alto táctil').toBeGreaterThanOrEqual(44)
    // En celdas compactas "desfasada" se oculta a la vista, pero sigue en el texto (lectores de pantalla).
    await expect(page.getByTestId('pcell-1-offset')).toHaveText(/^desfasada −\d+\.\d s$/)
    await page.getByTestId('pcell-1-resync').click()
    await expect(page.getByTestId('pcell-1-offset')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByTestId('pcell-1-footer')).toBeVisible()
  })
}

test('"Esperar a todas" activado: con una celda bloqueada todas esperan y nadie se desfasa', async ({ page }) => {
  await openPlayback(page)
  await waitAllLoaded(page)
  await page.getByTestId('strict-sync').check()
  await page.getByTestId('play-pause').click()
  await stallCell(page, 1)
  await expect(page.getByTestId('buffering-indicator')).toContainText('el reloj espera')
  for (const id of ['pcell-0', 'pcell-2', 'pcell-3']) await expect(page.getByTestId(`${id}-state`)).toHaveAttribute('data-state', 'esperando')
  const a = await snapshot(page)
  await page.waitForTimeout(1200)
  const b = await snapshot(page)
  expect(b.clock).toBe(a.clock)
  for (const id of ['pcell-0', 'pcell-1', 'pcell-2', 'pcell-3']) expect(b.cells[id].pos).toBe(a.cells[id].pos)

  await page.getByTestId('sim-stall-toggle').click()
  await expect.poll(async () => (await snapshot(page)).clock, { timeout: 5_000 }).toBeGreaterThan(a.clock + 1)
  for (const id of ['pcell-0', 'pcell-1', 'pcell-2', 'pcell-3']) {
    await expect(page.getByTestId(`${id}-state`)).toHaveAttribute('data-state', 'reproduciendo')
    await expect(page.getByTestId(`${id}-offset`)).toHaveCount(0)
  }
})

test('admisión por NVR, huecos y carga siguen visibles con la sincronía por celda', async ({ page }) => {
  await openPlayback(page)
  await pickCamera(page, 'cam-a5')
  await pickCamera(page, 'cam-a6')
  await expect(page.getByTestId('usage-nvr-a')).toHaveText('NVR Recepción: 4/4 sesiones · 2 en cola')
  await expect(page.getByTestId('pcell-5-state')).toHaveAttribute('data-state', 'en-cola')
  await page.getByTestId('seek-range').evaluate(el => {
    const input = el as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(8.5 * 3600))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.getByTestId('buffering-indicator')).toContainText('Cargando')
  await expect(page.getByTestId('pcell-4-state')).toHaveAttribute('data-state', 'hueco')
})

// ─── 5. Configuraciones simuladas identificadas ───────────────────────────────

test('configuración: cada sección de sections.ts muestra su marca de simulado o de backend existente', async ({ page }) => {
  for (const s of ALL_SECTIONS) {
    await page.goto(`/#/configuracion/${s.id}`)
    const section = page.getByTestId(`settings-section-${s.id}`)
    await expect(section).toBeVisible()
    const mark = section.getByTestId('backend-status')
    await expect(mark, s.id).toBeVisible()
    await expect(mark).toHaveAttribute('data-backend', s.backend.kind)
    await expect(mark).toHaveText(backendText(s.backend))
    for (const f of s.fields ?? []) {
      const own = fieldBackend(s, f)
      const fieldMark = section.getByTestId(`field-backend-${f.key}`)
      if (own === s.backend) await expect(fieldMark, `${s.id}.${f.key}`).toHaveCount(0)
      else await expect(fieldMark, `${s.id}.${f.key}`).toHaveText(backendText(own))
    }
  }
})

test('configuración: guardar o ejecutar dice que no se aplicó en el backend', async ({ page }) => {
  await page.goto('/#/configuracion/general') // simulada
  await page.getByTestId('f-timezone').selectOption('UTC')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('save-notice')).toHaveText('Guardado sólo en esta pestaña. No se aplicó: es una configuración simulada, sin backend.')
  await goSection(page, 'seguridad') // existe en la API, sin conectar
  await page.getByTestId('f-maxSessions').fill('4')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('save-notice')).toHaveText('Guardado sólo en esta pestaña. No se aplicó en el backend: el prototipo no llama a GET/PUT /api/security/settings.')
  await goSection(page, 'nvr')
  await page.getByTestId('action-add-nvr').click()
  await expect(page.getByTestId('action-add-nvr-notice')).toHaveText('No se ejecutó en el backend: el prototipo no llama a POST /api/nvrs.')
})

// Textos escritos a mano (no derivados de backend.ts ni de sections.ts).
const SIMULATED_NOTICE = 'No se aplicó: es una configuración simulada, sin backend.'
const SITE_NAME_NOTICE = 'No se aplicó en el backend: el prototipo no llama a AppearanceSettings.siteName · PUT /api/appearance.'

test('configuración: el aviso de guardar usa la marca de los controles CAMBIADOS, no la de su sección', async ({ page }) => {
  const notice = page.getByTestId('save-notice')
  const groups = notice.getByTestId('save-notice-group')
  // General es simulada, pero "Nombre del sitio" existe (AppearanceSettings.siteName).
  await page.goto('/#/configuracion/general')
  await expect(page.getByTestId('settings-section-general')).toHaveAttribute('data-backend', 'simulado')
  await expect(page.getByTestId('field-backend-siteName')).toHaveAttribute('data-backend', 'existente')
  await page.getByTestId('f-siteName').fill('Sitio norte')
  await page.getByTestId('save').click()
  await expect(notice).toHaveText(`Guardado sólo en esta pestaña. ${SITE_NAME_NOTICE}`)
  await expect(notice).not.toContainText('simulada')
  await expect(groups).toHaveCount(1)
  await expect(groups).toHaveAttribute('data-backend', 'existente')

  // Un existente y un simulado a la vez: un renglón por grupo, con sus controles.
  await page.getByTestId('f-siteName').fill('Sitio sur')
  await page.getByTestId('f-timezone').selectOption('UTC')
  await expect(notice).toHaveCount(0) // cambios nuevos: el aviso anterior desaparece
  await page.getByTestId('save').click()
  await expect(groups).toHaveCount(2)
  await expect(groups.nth(0)).toHaveAttribute('data-backend', 'existente')
  await expect(groups.nth(0)).toHaveText(`Nombre del sitio — ${SITE_NAME_NOTICE}`)
  await expect(groups.nth(1)).toHaveAttribute('data-backend', 'simulado')
  await expect(groups.nth(1)).toHaveText(`Zona horaria — ${SIMULATED_NOTICE}`)

  // Alertas existe (GET/PUT /api/alerts/settings), pero "Eventos de detección" es simulado.
  await goSection(page, 'alertas')
  await expect(page.getByTestId('settings-section-alertas')).toHaveAttribute('data-backend', 'existente')
  await expect(page.getByTestId('field-backend-detection')).toHaveAttribute('data-backend', 'simulado')
  await page.getByTestId('f-detection').setChecked(true)
  await page.getByTestId('save').click()
  await expect(notice).toHaveText(`Guardado sólo en esta pestaña. ${SIMULATED_NOTICE}`)
  await expect(notice).not.toContainText('/api/alerts/settings')
  await expect(groups).toHaveAttribute('data-backend', 'simulado')
})

test('vivo, grabaciones y eventos: los controles sin backend conectado quedan marcados', async ({ page }) => {
  await asUser(page, USER.OPERATOR)
  await expect(page.getByTestId('live-video-backend')).toHaveAttribute('data-backend', 'existente')
  await expect(page.getByTestId('live-video-backend')).toContainText('POST /api/cameras/:id/start-stream')
  await openPanel(page, 'viewer-panel')
  await expect(page.getByTestId('viewers-backend')).toContainText('Existe en backend (GET/POST /api/views · PUT/DELETE /api/views/:id)')
  await page.getByTestId('cell-0-ptz').click()
  await expect(page.getByTestId('ptz-backend')).toContainText('POST /api/cameras/:id/ptz')
  await asUser(page, USER.ADMIN)
  await navTo(page, 'Eventos')
  await expect(page.getByTestId('events-backend')).toContainText('Existe en backend (GET /api/analytics/events)')
  await openPlayback(page)
  await expect(page.getByTestId('admission-backend')).toHaveAttribute('data-backend', 'existente')
  await expect(page.getByTestId('sync-backend')).toHaveAttribute('data-backend', 'simulado')
  await expect(page.getByTestId('stall-backend')).toHaveAttribute('data-backend', 'simulado')
  await openPanel(page, 'camera-picker')
  await expect(page.getByTestId('search-backend')).toContainText('GET /api/recordings/search')
})

test('vivo: editar un visor muestra la marca y guardarlo dice que no se aplicó en el backend', async ({ page }) => {
  await asUser(page, USER.SUPERVISOR)
  await selectViewer(page, 'v-entrada')
  await page.getByTestId('edit-viewer').click()
  await expect(page.getByTestId('viewer-edit-backend')).toBeVisible() // también con el selector plegado (vertical)
  await page.getByTestId('save-viewer').click()
  await expect(page.getByTestId('viewer-edit-backend')).toHaveCount(0)
  await expect(page.getByTestId('viewer-notice')).toHaveText(
    'Visor guardado sólo en este navegador. No se aplicó en el backend: el prototipo no llama a GET/POST /api/views · PUT/DELETE /api/views/:id.')
  await page.getByTestId('share-viewer').click()
  await expect(page.getByTestId('viewer-notice')).toHaveCount(0)
  await page.getByTestId('share-save').click()
  await expect(page.getByTestId('viewer-notice')).toContainText('Acceso guardado sólo en este navegador. No se aplicó en el backend')
})

// ─── 6. Lo que el prototipo NO demuestra ──────────────────────────────────────

test('grabaciones: aviso visible de que el prototipo no demuestra que desaparecieron las pausas', async ({ page }) => {
  await openPlayback(page)
  const note = page.getByTestId('playback-proof-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('no demuestra que desaparecieron las pausas entre grabaciones')
  await expect(note).toContainText('video reproducible en las pruebas')
  await expect(note).toContainText('mediciones autorizadas con NVR reales')
})
