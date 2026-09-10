// TEST DE INTEGRACIÓN EN NAVEGADOR (Playwright) — NO un E2E de stack completo.
//
// Monta el COMPONENTE REAL `ViewPlayerPage` (ver e2e/harness/main.tsx) en Chromium
// con la API interceptada por un MOCK y `VideoPlayer` reemplazado por un STUB. Por
// eso NO es un E2E completo: no hay API real, ni MediaMTX, ni FFmpeg, ni NVR, ni
// frames HLS, ni cupos ni latencia reales (todo eso es NOT_VALIDATED — ver
// e2e/README.md). Lo que SÍ valida, en un navegador real y con eventos reales del
// DOM, es el CICLO DE VIDA de sesiones (contrato de LIBERACIÓN RÁPIDA, Hito 5·C23):
//
//   1. Un cierre deliberado libera la sesión de INMEDIATO por identidad (no espera
//      al TTL del servidor).
//   2. Una respuesta de arranque HD que llega TARDE (tras salir de pantalla
//      completa) se DESCARTA por identidad — no se muestra, no renueva, no queda
//      como fuga.
//   3. Cámara HEVC ⇒ el HD pedido es `main_h264` (transcodificado), y su cierre va
//      por esa identidad exacta.
//   4. Un 500 en el cierre se REINTENTA (cola sólo-cierre) hasta confirmar; nada
//      queda activo.
//   5. bfcache: `pagehide` ABANDONA la vista (cierra TODA la vista con keepalive);
//      `pageshow` persistido fuerza una recarga limpia.
//
// Lo que NO se valida acá (requiere stack + NVR reales, NOT_VALIDATED): frames HLS
// reales, latencia real clic→primer-frame, conteo real de procesos FFmpeg y cupo
// real de MediaMTX. Este harness prueba el CICLO DE VIDA, no el reproductor ni el
// servidor de medios.
import { test, expect } from '@playwright/test'
import { installApiMock, type ApiMock } from './fixtures/api-mock'

const EXIT_FULLSCREEN = 'exit_fullscreen'

async function loadGrid(page: import('@playwright/test').Page) {
  await page.goto('/')
  // La grilla quedó cargada cuando el tile de camA (stub de VideoPlayer) es visible.
  await expect(page.getByTestId('video-camA')).toBeVisible()
}

/** Entra a pantalla completa HD de una cámara vía doble clic en su tile (gesto real). */
async function enterFullscreen(page: import('@playwright/test').Page, cameraId: string) {
  await page.getByTestId(`video-${cameraId}`).dblclick()
}

async function exitFullscreen(page: import('@playwright/test').Page) {
  await page.locator('button[title="Salir de pantalla completa"]').click()
}

function hdStartsFor(mock: ApiMock, cameraId: string) {
  return mock.starts.filter((s) => s.cameraId === cameraId && s.streamType !== 'sub')
}
function identityClosesFor(mock: ApiMock, startAttemptId: string) {
  return mock.closes.filter((c) => c.expectedStartAttemptId === startAttemptId && c.status === 200)
}

test.describe('ViewPlayer — integración en navegador (API mock + VideoPlayer stub)', () => {
  let mock: ApiMock

  test.beforeEach(async ({ page }) => {
    mock = await installApiMock(page)
  })

  // Contrato estricto del mock: ninguna ruta /api inesperada (una llamada no
  // prevista respondería 500 y quedaría registrada). Si esto falla, el test tocó
  // un endpoint que el mock no modela — se corrige el mock, no se enmascara.
  test.afterEach(() => {
    expect(mock.unexpected, `rutas /api inesperadas: ${mock.unexpected.join(', ')}`).toEqual([])
  })

  test('1 · cierre deliberado libera la sesión HD por identidad, de inmediato', async ({ page }) => {
    await loadGrid(page)

    await enterFullscreen(page, 'camA')

    // Se abrió UNA sesión HD `main` (camA es H.264) con su startAttemptId.
    await expect.poll(() => hdStartsFor(mock, 'camA').length).toBe(1)
    const start = hdStartsFor(mock, 'camA')[0]
    expect(start.streamType).toBe('main')
    expect(start.startAttemptId).toBeTruthy()
    expect(start.viewId).toMatch(/^vp_/)
    await expect.poll(() => mock.isActive(start.startAttemptId!)).toBe(true)

    const tExit = Date.now()
    await exitFullscreen(page)

    // El cierre llega por la MISMA identidad, con razón exit_fullscreen, y la
    // sesión deja de estar activa — sin esperar ningún TTL.
    await expect.poll(() => identityClosesFor(mock, start.startAttemptId!).length).toBeGreaterThanOrEqual(1)
    const close = identityClosesFor(mock, start.startAttemptId!)[0]
    expect(close.reason).toBe(EXIT_FULLSCREEN)
    expect(close.streamType).toBe('main')
    expect(close.viewId).toBe(start.viewId)
    expect(close.at - tExit).toBeLessThan(3000)          // pronto, no por TTL
    await expect.poll(() => mock.activeCount()).toBe(0)  // sin fuga
  })

  test('2 · respuesta HD tardía tras salir se descarta por identidad (no se muestra ni fuga)', async ({ page }) => {
    await loadGrid(page)

    // Retener la respuesta del arranque HD de camA: queda en vuelo.
    mock.holdStart('camA')
    await enterFullscreen(page, 'camA')
    await expect.poll(() => hdStartsFor(mock, 'camA').length).toBe(1)
    const start = hdStartsFor(mock, 'camA')[0]

    // El usuario sale de pantalla completa ANTES de que el HD resuelva.
    await exitFullscreen(page)
    // Ya no estamos en pantalla completa (overlay desmontado, grilla visible).
    await expect(page.locator('button[title="Salir de pantalla completa"]')).toHaveCount(0)

    // Ahora resuelve la respuesta tardía: el controlador la cierra por identidad.
    mock.releaseStart('camA')

    await expect.poll(() => identityClosesFor(mock, start.startAttemptId!).length).toBeGreaterThanOrEqual(1)
    expect(identityClosesFor(mock, start.startAttemptId!)[0].reason).toBe(EXIT_FULLSCREEN)
    await expect.poll(() => mock.activeCount()).toBe(0)  // la sesión tardía no quedó viva

    // No volvió a mostrarse pantalla completa por la respuesta tardía.
    await expect(page.locator('button[title="Salir de pantalla completa"]')).toHaveCount(0)
  })

  test('3 · cámara HEVC ⇒ HD main_h264, y su cierre va por esa identidad', async ({ page }) => {
    await loadGrid(page)

    await enterFullscreen(page, 'camB')  // camB.mainCodec = hevc

    await expect.poll(() => hdStartsFor(mock, 'camB').length).toBe(1)
    const start = hdStartsFor(mock, 'camB')[0]
    expect(start.streamType).toBe('main_h264')   // pickHdStreamType(hevc)

    await exitFullscreen(page)

    await expect.poll(() => identityClosesFor(mock, start.startAttemptId!).length).toBeGreaterThanOrEqual(1)
    expect(identityClosesFor(mock, start.startAttemptId!)[0].streamType).toBe('main_h264')
    await expect.poll(() => mock.activeCount()).toBe(0)
  })

  test('4 · un 500 en el cierre se reintenta hasta confirmar; nada queda activo', async ({ page }) => {
    test.setTimeout(25_000)  // el retry sólo-cierre corre cada ~5s
    await loadGrid(page)

    await enterFullscreen(page, 'camA')
    await expect.poll(() => hdStartsFor(mock, 'camA').length).toBe(1)
    const start = hdStartsFor(mock, 'camA')[0]
    await expect.poll(() => mock.isActive(start.startAttemptId!)).toBe(true)

    mock.failNextClose('camA')   // el primer DELETE responde 500
    await exitFullscreen(page)

    // Primer intento: 500 (emitido, sin cierre) — la sesión sigue activa.
    await expect.poll(() => mock.closes.some((c) => c.cameraId === 'camA' && c.status === 500)).toBe(true)

    // El reintento SÓLO-CIERRE confirma el cierre por identidad y libera la sesión.
    await expect.poll(() => identityClosesFor(mock, start.startAttemptId!).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => mock.activeCount(), { timeout: 15_000 }).toBe(0)
  })

  test('5 · handlers bfcache: pagehide ⇒ closeView(keepalive); pageshow persistido ⇒ recarga', async ({ page }) => {
    // ALCANCE: valida la LÓGICA DE LOS HANDLERS de la página ante eventos
    // `pagehide`/`pageshow` reales del DOM. La expulsión y restauración REALES del
    // bfcache del navegador (sin control fiable en headless) son NOT_VALIDATED: se
    // despachan eventos sintéticos para ejercer el wiring, no el store del bfcache.
    await loadGrid(page)
    const viewGetsBefore = mock.viewGetCount()
    expect(viewGetsBefore).toBeGreaterThanOrEqual(1) // la carga inicial pidió /views

    // `pagehide` ⇒ disposeView ⇒ cierre de TODA la vista con keepalive.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await expect.poll(() => mock.viewCloses.length).toBeGreaterThanOrEqual(1)
    expect(mock.viewCloses[0].viewId).toMatch(/^vp_/)

    // `pageshow` persistido ⇒ el handler recarga (vista abandonada). La recarga
    // REAL remonta el harness ⇒ un GET /views ADICIONAL. Aserción concreta:
    // viewGetCount aumenta (no una variable muerta).
    const navPromise = page.waitForEvent('framenavigated').catch(() => null)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await navPromise
    await expect(page.getByTestId('video-camA')).toBeVisible()
    await expect.poll(() => mock.viewGetCount()).toBeGreaterThan(viewGetsBefore)
  })
})
