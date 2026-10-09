// Editor de zonas portado de Frigate (React 18 + react-konva 18 + konva 10) dentro
// de Configuración › Zonas y máscaras: dibujar, cerrar, arrastrar vértice, deshacer,
// reescalar (rotación de tablet) y guardar en coordenadas 0–1. Ratón en PC y
// eventos táctiles reales (CDP) en tablet. Sin errores ni advertencias de consola.
import { test, expect, type Page } from '@playwright/test'
import { USER, asUser, freshStart } from './helpers'

let consoleProblems: string[] = []
test.beforeEach(async ({ page }) => {
  consoleProblems = []
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleProblems.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', e => consoleProblems.push(`pageerror: ${e.message}`))
  await freshStart(page, '/configuracion/zonas')
})
test.afterEach(() => { expect(consoleProblems, 'sin errores ni advertencias de consola').toEqual([]) })

async function stage(page: Page) {
  const content = page.locator('[data-testid="canvas-container"] .konvajs-content')
  await expect(content).toBeVisible()
  // La imagen de fondo (sintética) debe haber cargado: el lienzo reemplaza al indicador.
  await expect(page.locator('[data-testid="canvas-container"] canvas').first()).toBeVisible()
  const box = await content.boundingBox()
  if (!box) throw new Error('sin stage')
  return box
}

const isTouch = (name: string) => name.startsWith('tablet')

async function tapOrClick(page: Page, touch: boolean, x: number, y: number) {
  if (touch) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

async function drag(page: Page, touch: boolean, from: { x: number; y: number }, to: { x: number; y: number }) {
  if (!touch) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await page.mouse.up()
    return
  }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  for (let k = 1; k <= 8; k++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + ((to.x - from.x) * k) / 8, y: from.y + ((to.y - from.y) * k) / 8 }],
    })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

function expectNear(actual: number[][], expected: number[][], tol = 0.012) {
  expect(actual.length, JSON.stringify(actual)).toBe(expected.length)
  actual.forEach(([x, y], i) => {
    expect(Math.abs(x - expected[i][0]), `x[${i}]`).toBeLessThanOrEqual(tol)
    expect(Math.abs(y - expected[i][1]), `y[${i}]`).toBeLessThanOrEqual(tol)
  })
}

test('dibujar, cerrar, arrastrar, deshacer, reescalar y guardar una zona', async ({ page }, info) => {
  const touch = isTouch(info.project.name)
  await page.getByTestId('zone-camera').selectOption('cam-a2') // sin zonas
  await expect(page.getByTestId('zones-saved')).toHaveText('[]')
  await page.getByTestId('new-zone').click()

  const b = await stage(page)
  const at = (fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy })
  const pts = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.8], [0.2, 0.8]]
  for (let i = 0; i < pts.length; i++) {
    const p = at(pts[i][0], pts[i][1])
    await tapOrClick(page, touch, p.x, p.y)
    await expect(page.getByTestId('active-polygon-state')).toContainText(`${i + 1} punto(s)`)
  }
  await expect(page.getByTestId('zones-save')).toBeDisabled() // sin cerrar no se guarda

  // Cerrar tocando el primer vértice: no agrega punto.
  const first = at(0.2, 0.2)
  await tapOrClick(page, touch, first.x, first.y)
  await expect(page.getByTestId('active-polygon-state')).toContainText('4 punto(s) · cerrado')

  // Arrastrar el vértice (0.6,0.8) → (0.7,0.9).
  await drag(page, touch, at(0.6, 0.8), at(0.7, 0.9))

  // Deshacer quita el último punto AGREGADO (0.2,0.8); sigue cerrado con 3.
  await page.getByTestId('undo-point').click()
  await expect(page.getByTestId('active-polygon-state')).toContainText('3 punto(s)')

  // Reescalar (rotación de tablet / ventana más angosta): las coordenadas relativas
  // se conservan. El lienzo puede achicarse o agrandarse (en tablet horizontal el
  // menú de secciones pasa arriba y la sección gana ancho): sólo importa que cambie.
  const vp = page.viewportSize()!
  await page.setViewportSize({ width: Math.round(vp.width * 0.8), height: vp.height })
  await expect.poll(async () => Math.round((await stage(page)).width)).not.toBe(Math.round(b.width))

  await expect(page.getByTestId('zones-dirty')).toHaveText('Cambios sin guardar')
  await page.getByTestId('zones-save').click()
  await expect(page.getByTestId('zones-notice')).toContainText('1 polígono(s)')
  const saved = JSON.parse((await page.getByTestId('zones-saved').textContent()) ?? '[]')
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ name: 'zona_1', type: 'zone', enabled: true })
  expectNear(saved[0].points, [[0.2, 0.2], [0.6, 0.2], [0.7, 0.9]])
})

test('las zonas existentes se cargan en coordenadas relativas y cambiar de cámara exige guardar o deshacer', async ({ page }) => {
  await page.getByTestId('zone-camera').selectOption('cam-a4')
  await expect(page.getByTestId('zone-list')).toContainText('entrada_vehicular')
  await expect(page.getByTestId('zone-list')).toContainText('máscara de movimiento')
  await stage(page)
  await page.getByTestId('new-motion-mask').click()
  await expect(page.getByTestId('zones-dirty')).toHaveText('Cambios sin guardar')
  await expect(page.getByTestId('zone-camera')).toBeDisabled()
  await page.getByTestId('zones-cancel').click()
  await expect(page.getByTestId('zone-camera')).toBeEnabled()
  await expect(page.getByTestId('zone-list').locator('li')).toHaveCount(2)
})

test('SUPERVISOR edita zonas (PUT /api/analytics/config admite SUPERVISOR); OPERATOR no ve la sección', async ({ page }) => {
  await asUser(page, USER.SUPERVISOR)
  await page.goto('/#/configuracion/zonas')
  await expect(page.getByTestId('settings-section-zonas')).toHaveAttribute('data-access', 'edit')
  await expect(page.getByTestId('new-zone')).toBeVisible()
  await asUser(page, USER.OPERATOR)
  await page.goto('/#/configuracion/zonas')
  await expect(page).toHaveURL(/#\/configuracion\/visores$/)
})
