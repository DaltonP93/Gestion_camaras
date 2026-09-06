// Interceptor de red determinista para el harness de ViewPlayerPage.
//
// No hay backend, MediaMTX ni NVR: se interceptan las llamadas `/api/**` que hace
// el código REAL (axios + `fetch(keepalive)` de sessionClose) y se registra cada
// arranque y cierre para poder ASERTAR el contrato de liberación rápida:
//   · qué `startAttemptId` se abrió,
//   · que el cierre deliberado llega con la MISMA identidad (`expectedStartAttemptId`),
//   · que ninguna sesión queda «activa» tras cerrarse (sin fuga),
//   · que un 500 en el cierre se reintenta hasta confirmar.
//
// El estado de sesiones vive en el proceso de Node del test (no en el navegador):
// se añade en cada `start-stream` y se quita en cada DELETE confirmado por
// identidad, imitando el arrendamiento único por `startAttemptId` del servidor.
import type { Page, Route, Request } from '@playwright/test'

export interface StartCall {
  cameraId: string
  streamType: string
  viewId?: string
  startAttemptId?: string
  at: number
}

export interface CloseCall {
  cameraId: string
  streamType?: string
  reason?: string
  viewId?: string
  expectedStartAttemptId?: string
  at: number
  status: number
}

export interface ViewCloseCall { viewId?: string; at: number }

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

const now = () => Date.now()

// Cámaras del harness: camA principal H.264 (HD = `main`), camB principal HEVC
// (HD = `main_h264`, para ejercer la ruta sub→main_h264 de `pickHdStreamType`).
const CAMERAS: Record<string, Record<string, unknown>> = {
  camA: {
    id: 'camA', nvrId: 'n1', channel: 1, name: 'Cam A',
    mainCodec: 'h264', subCodec: 'h264', mainResolution: '1920x1080', subResolution: '640x480',
    ptzEnabled: false, active: true, online: true,
  },
  camB: {
    id: 'camB', nvrId: 'n1', channel: 2, name: 'Cam B',
    mainCodec: 'hevc', subCodec: 'h264', mainResolution: '2560x1440', subResolution: '640x480',
    ptzEnabled: false, active: true, online: true,
  },
}

const VIEW = {
  id: 'v1', name: 'Vista E2E', layout: '2x2',
  cameraSlots: [
    { slotIndex: 0, cameraId: 'camA', size: 'normal' },
    { slotIndex: 1, cameraId: 'camB', size: 'normal' },
  ],
  slideshowEnabled: false, slideshowInterval: 10, isPublic: true,
  createdById: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

function subStream(cameraId: string) {
  return {
    cameraId, streamPath: `${cameraId}_sub`, hls: `/hls/${cameraId}_sub.m3u8`,
    webrtc: '', channel: CAMERAS[cameraId]?.channel ?? 1, nvrName: 'NVR1', streamType: 'sub',
  }
}

export interface ApiMock {
  starts: StartCall[]
  closes: CloseCall[]
  viewCloses: ViewCloseCall[]
  /** Cantidad de sesiones "activas" (abiertas y no cerradas por identidad). */
  activeCount(): number
  /** ¿Sigue activa esta identidad? */
  isActive(startAttemptId: string): boolean
  /** Retiene la respuesta de `start-stream` de una cámara hasta `releaseStart`. */
  holdStart(cameraId: string): void
  releaseStart(cameraId: string): void
  /** El próximo DELETE de esa cámara responde 500 una vez (luego, normal). */
  failNextClose(cameraId: string): void
}

export async function installApiMock(page: Page): Promise<ApiMock> {
  const starts: StartCall[] = []
  const closes: CloseCall[] = []
  const viewCloses: ViewCloseCall[] = []
  const active = new Set<string>()                 // startAttemptId vigentes
  const holds = new Map<string, Deferred>()        // cameraId → gate de start
  const failClose = new Set<string>()              // cameraId con 500 pendiente

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/**', async (route: Route, request: Request) => {
    const method = request.method()
    const url = new URL(request.url())
    const p = url.pathname.replace(/^.*?\/api/, '') // parte tras /api

    // ── GET vista / cámara / stream sub ──
    if (method === 'GET' && /^\/views\/[^/]+$/.test(p)) return json(route, VIEW)
    if (method === 'GET' && /^\/cameras\/[^/]+\/stream$/.test(p)) {
      const cameraId = p.split('/')[2]
      return json(route, subStream(cameraId))
    }
    if (method === 'GET' && /^\/cameras\/[^/]+$/.test(p)) {
      const cameraId = p.split('/')[2]
      return json(route, CAMERAS[cameraId] ?? { id: cameraId, name: cameraId, ptzEnabled: false, active: true, online: true })
    }

    // ── POST arranque de stream ──
    if (method === 'POST' && /^\/cameras\/[^/]+\/start-stream$/.test(p)) {
      const cameraId = p.split('/')[2]
      let body: any = {}
      try { body = request.postDataJSON() } catch { /* sin cuerpo */ }
      const streamType = String(body?.streamType ?? 'sub')
      const startAttemptId = body?.startAttemptId ? String(body.startAttemptId) : undefined
      starts.push({ cameraId, streamType, viewId: body?.viewId, startAttemptId, at: now() })
      if (startAttemptId) active.add(startAttemptId)
      // Gate de latencia: si el test retuvo esta cámara, esperar a `releaseStart`.
      const gate = holds.get(cameraId)
      if (gate) await gate.promise
      return json(route, {
        cameraId, streamType, streamPath: `${cameraId}_${streamType}`,
        hls: `/hls/${cameraId}_${streamType}.m3u8`, webrtc: '',
        channel: CAMERAS[cameraId]?.channel ?? 1, nvrName: 'NVR1',
      })
    }

    // ── DELETE cierre de TODA la vista (disposeView / bfcache) ──
    if (method === 'DELETE' && /^\/cameras\/my-sessions$/.test(p)) {
      viewCloses.push({ viewId: url.searchParams.get('viewId') ?? undefined, at: now() })
      return json(route, { outcome: 'session_closed' })
    }

    // ── DELETE cierre de UNA sesión por identidad ──
    if (method === 'DELETE' && /^\/cameras\/[^/]+\/stream$/.test(p)) {
      const cameraId = p.split('/')[2]
      const expected = url.searchParams.get('expectedStartAttemptId') ?? undefined
      const reason = url.searchParams.get('reason') ?? undefined
      // Inyección de fallo: un 500 (petición emitida, sin cierre) fuerza el
      // reintento SÓLO-CIERRE del controlador.
      if (failClose.has(cameraId)) {
        failClose.delete(cameraId)
        closes.push({ cameraId, streamType: url.searchParams.get('streamType') ?? undefined, reason, viewId: url.searchParams.get('viewId') ?? undefined, expectedStartAttemptId: expected, at: now(), status: 500 })
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'inyectado' }) })
      }
      if (expected) active.delete(expected)
      closes.push({ cameraId, streamType: url.searchParams.get('streamType') ?? undefined, reason, viewId: url.searchParams.get('viewId') ?? undefined, expectedStartAttemptId: expected, at: now(), status: 200 })
      return json(route, { outcome: 'session_closed', attemptId: expected, remainingAttempts: 0, killedFfmpeg: true })
    }

    // ── Heartbeat de live-view ──
    if (method === 'POST' && /^\/live-view\/heartbeat$/.test(p)) {
      return json(route, { streams: {} })
    }

    // Cualquier otra ruta /api: 200 vacío (no debería ocurrir en estos tests).
    return json(route, {})
  })

  // Los .m3u8/.ts del stub no se piden (VideoPlayer está aliaseado), pero por si
  // acaso se aborta silenciosamente cualquier pedido HLS.
  await page.route('**/hls/**', (route) => route.abort())

  return {
    starts, closes, viewCloses,
    activeCount: () => active.size,
    isActive: (id: string) => active.has(id),
    holdStart: (cameraId: string) => { if (!holds.has(cameraId)) holds.set(cameraId, deferred()) },
    releaseStart: (cameraId: string) => { holds.get(cameraId)?.resolve(); holds.delete(cameraId) },
    failNextClose: (cameraId: string) => { failClose.add(cameraId) },
  }
}
