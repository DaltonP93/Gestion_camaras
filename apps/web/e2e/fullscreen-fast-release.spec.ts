// E2E en navegador REAL del ciclo de vida de pantalla completa de ViewPlayerPage.
//
// Monta el COMPONENTE REAL (ver e2e/harness/main.tsx) en Chromium y ejerce, a
// través de la UI y de eventos reales del DOM, el contrato de LIBERACIÓN RÁPIDA
// (Hito 5, C23):
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

test.describe('ViewPlayer — liberación rápida de pantalla completa', () => {
  let mock: ApiMock

  test.beforeEach(async ({ page }) => {
    mock = await installApiMock(page)
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

  test('5 · bfcache: pagehide abandona la vista (closeView); pageshow persistido recarga', async ({ page }) => {
    await loadGrid(page)
    const viewsBefore = mock.starts.length  // (no importa; medimos GET /views por recarga)

    // `pagehide` ⇒ disposeView ⇒ cierre de TODA la vista con keepalive.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await expect.poll(() => mock.viewCloses.length).toBeGreaterThanOrEqual(1)
    expect(mock.viewCloses[0].viewId).toMatch(/^vp_/)

    // `pageshow` persistido ⇒ recarga limpia (la vista fue abandonada). La recarga
    // real vuelve a montar el harness ⇒ nuevo GET /views. Lo detectamos esperando
    // a que el tile vuelva a aparecer tras el navigate de recarga.
    const navPromise = page.waitForEvent('framenavigated').catch(() => null)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await navPromise
    await expect(page.getByTestId('video-camA')).toBeVisible()
    void viewsBefore
  })
})
