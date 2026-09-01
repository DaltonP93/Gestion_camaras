// C19 · pruebas de SISTEMA del controlador sobre el REGISTRO DE RETENCIÓN.
//
// La "conservación del FFmpeg" deja de ser una condición aislada y pasa a ser un
// estado rastreado del cliente: cuando un cierre DÉBIL confirma el último
// arrendamiento pero el backend conserva el proceso, la identidad NO se olvida
// —sale del registro activo y entra en un registro de RETENCIÓN—, para que una
// transición/dispose posterior emita un cierre TERMINANTE con el token y escale
// (mate) el huérfano.
//
// Backend falso CON retención: replica el contrato del API real —débil conserva
// y devuelve `retentionToken`; fuerte con token mata y devuelve
// `killedFfmpeg:true`; la vista entera finaliza sus retenciones—.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createViewportSessionController, type ControllerTimers,
} from './viewportSessionController'
import type { CloseAck } from './viewportSessionClose'
import type { StreamKind } from './streamTypes'
import { esCierreFuerte } from './closeReasons'

function fakeTimers() {
  let seq = 1
  const tareas = new Map<number, { fn: () => void; due: number; every?: number }>()
  let ahora = 0
  const api: ControllerTimers = {
    setTimeout: (fn, ms) => { const id = seq++; tareas.set(id, { fn, due: ahora + ms }); return id },
    clearTimeout: (id) => { tareas.delete(id as number) },
    setInterval: (fn, ms) => { const id = seq++; tareas.set(id, { fn, due: ahora + ms, every: ms }); return id },
    clearInterval: (id) => { tareas.delete(id as number) },
  }
  return {
    api,
    advance(ms: number) {
      ahora += ms
      for (const [id, t] of [...tareas]) {
        if (t.due <= ahora) {
          if (t.every) t.due += t.every; else tareas.delete(id)
          t.fn()
        }
      }
    },
  }
}

// ─── Backend falso con RETENCIÓN por generación de proceso ──────────────────
function makeRetBackend() {
  interface Ses { streamType: StreamKind; leases: Set<string> }
  const sesiones = new Map<string, Ses>()
  const ffmpeg = new Set<string>()               // paths main_h264 VIVOS
  interface Ret { token: string; path: string; gen: string; attemptId: string }
  const retenciones = new Map<string, Ret>()     // token → retención
  let retSeq = 0, genSeq = 0
  const genActual = new Map<string, string>()    // path → generación vigente
  let failClose: number | null = null            // fuerza un status HTTP en el próximo close
  let killSucceeds = true

  const pathDe = (cam: string) => `/${cam}_main_h264`

  const startStream = async (cameraId: string, body: Record<string, unknown>, signal: AbortSignal) => {
    const startAttemptId = body.startAttemptId as string
    await Promise.resolve()
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    // hevc: todo va a main_h264
    const clave = `${cameraId}:main_h264`
    const s = sesiones.get(clave) ?? { streamType: 'main_h264' as StreamKind, leases: new Set<string>() }
    s.leases.add(startAttemptId); sesiones.set(clave, s)
    const path = pathDe(cameraId)
    if (!ffmpeg.has(path)) { ffmpeg.add(path); genActual.set(path, `gen-${++genSeq}`) }
    return { streamPath: path, transcoded: true, hls: `h/${cameraId}`, startAttemptId }
  }

  const close: (c: string, t: StreamKind, r: string, v: string, e?: string, tok?: string) => CloseAck =
    (cameraId, streamType, reason, _viewId, expected, retentionToken) => {
      if (failClose !== null) { const st = failClose; failClose = null; return { emitted: true, status: st } }
      const path = pathDe(cameraId)
      const clave = `${cameraId}:${streamType}`
      const s = sesiones.get(clave)
      const fuerte = esCierreFuerte(reason)

      // Sin sesión: puede ser la escalada de una retención ya creada.
      if (!s || (expected && !s.leases.has(expected))) {
        // Escalada terminante de una retención (por token o identidad).
        if (fuerte) {
          let ret = retentionToken ? retenciones.get(retentionToken) : undefined
          if (!ret) for (const r of retenciones.values()) if (r.path === path && (!expected || r.attemptId === expected)) { ret = r; break }
          if (ret) {
            if (genActual.get(path) !== ret.gen) {
              retenciones.delete(ret.token)
              return { emitted: true, status: 200, outcome: 'ignored', reason: 'retention_gone', attemptId: expected }
            }
            if (sesiones.has(clave)) {
              retenciones.delete(ret.token)
              return { emitted: true, status: 200, outcome: 'ignored', reason: 'retention_adopted', attemptId: expected }
            }
            if (ffmpeg.has(path) && !killSucceeds) {
              return { emitted: true, status: 200, outcome: 'ignored', reason: 'retention_pending', attemptId: expected, retentionToken: ret.token }
            }
            retenciones.delete(ret.token)
            if (ffmpeg.has(path)) { ffmpeg.delete(path); genActual.delete(path); return { emitted: true, status: 200, outcome: 'session_closed', attemptId: expected, killedFfmpeg: true } }
            return { emitted: true, status: 200, outcome: 'ignored', reason: 'retention_gone', attemptId: expected }
          }
        }
        return { emitted: true, status: 200, outcome: 'ignored', reason: s ? 'attempt_not_registered' : 'no_session' }
      }

      // Con sesión y el arrendamiento pedido: soltar SÓLO ese lease.
      s.leases.delete(expected as string)
      if (s.leases.size > 0) return { emitted: true, status: 200, outcome: 'attempt_released', attemptId: expected, remainingAttempts: s.leases.size }
      sesiones.delete(clave)
      if (streamType !== 'main_h264' || !ffmpeg.has(path)) {
        return { emitted: true, status: 200, outcome: 'session_closed', attemptId: expected }
      }
      if (fuerte) {
        ffmpeg.delete(path); genActual.delete(path)
        return { emitted: true, status: 200, outcome: 'session_closed', attemptId: expected, killedFfmpeg: true }
      }
      // DÉBIL: se conserva el FFmpeg y se acuña una retención rastreada.
      const token = `ret-${++retSeq}`
      retenciones.set(token, { token, path, gen: genActual.get(path) as string, attemptId: expected as string })
      return { emitted: true, status: 200, outcome: 'session_closed', attemptId: expected, retentionToken: token }
    }

  return {
    startStream, close,
    // La vista entera: finaliza (mata) las retenciones de sus paths y borra sesiones.
    closeView: () => {
      for (const r of Array.from(retenciones.values())) {
        if (genActual.get(r.path) === r.gen && ffmpeg.has(r.path) && !sesiones.has(r.path)) {
          ffmpeg.delete(r.path); genActual.delete(r.path)
        }
        retenciones.delete(r.token)
      }
      sesiones.clear()
    },
    sesiones, ffmpeg, retenciones, genActual,
    vivas: () => Array.from(sesiones.keys()).sort(),
    failCloseNext: (st: number) => { failClose = st },
    setKillSucceeds: (v: boolean) => { killSucceeds = v },
  }
}

let be: ReturnType<typeof makeRetBackend>
let ft: ReturnType<typeof fakeTimers>
function nuevoController(closeMs = 5_000) {
  return createViewportSessionController({
    viewId: 'v1', startStream: be.startStream, close: be.close,
    closeView: be.closeView, timers: ft.api, closeRetryMs: closeMs,
  })
}
beforeEach(() => { be = makeRetBackend(); ft = fakeTimers() })
const tick = () => new Promise(r => setTimeout(r, 0))

// ─── Escenario 1 · débil 500 → fuerte 500 → retry reenvía FUERTE y mata A ────

describe('C19 · la cola conserva la intención MÁS FUERTE (P0-1)', () => {
  it('débil que falla, luego fuerte que falla: el retry reenvía el FUERTE y MATA el FFmpeg', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    const a = await c.start({ source: 'grid', cameraId: 'cA', requested: 'main_h264', scope: sA })
    expect(be.ffmpeg.size).toBe(1)

    // 1º un cierre DÉBIL que el servidor rechaza (500): queda pendiente como débil.
    be.failCloseNext(500)
    await c.close({ cameraId: 'cA', streamType: 'main_h264', reason: 'hls_fatal_error' })
    expect(c.pending().size()).toBe(1)

    // 2º un cierre FUERTE (transición) que TAMBIÉN falla (500): la cola debe
    // conservar la intención FUERTE, no la primera (débil).
    be.failCloseNext(500)
    c.closeExactEntries([{ cameraId: 'cA', streamType: 'main_h264', startAttemptId: a!.startAttemptId, ownerScope: sA }], 'page_change')
    await tick()
    expect(c.pending().size()).toBe(1)
    const enCola = c.pending().list()[0]
    expect(esCierreFuerte(enCola.reason)).toBe(true)      // FUERTE conservado
    expect(enCola.reason).toBe('page_change')
    expect(be.ffmpeg.size).toBe(1)                        // aún vivo

    // 3º el retry reenvía el FUERTE: mata el FFmpeg de A. Si conservara el débil,
    // el proceso quedaría vivo.
    await c.retryCloses()
    expect(c.pending().size()).toBe(0)
    expect(be.ffmpeg.size).toBe(0)                        // A murió de verdad
    expect(be.vivas()).toEqual([])
  })
})

// ─── Escenario 2 · débil confirmado → transición REAL emite el fuerte ────────

describe('C19 · un cierre débil confirmado no borra la identidad; la transición la escala (P0-2)', () => {
  it('débil conserva el FFmpeg y lo retiene; beginTransition lo MATA con el token', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'main_h264', scope: sA })
    expect(be.ffmpeg.size).toBe(1)

    // Cierre DÉBIL confirmado: la sesión cae, el FFmpeg se conserva (retención).
    await c.close({ cameraId: 'cA', streamType: 'main_h264', reason: 'hls_fatal_error' })
    await tick()
    expect(be.vivas()).toEqual([])           // sin sesión…
    expect(be.ffmpeg.size).toBe(1)           // …pero el proceso sigue
    expect(be.retenciones.size).toBe(1)      // rastreado como retención
    expect(c.registry().has('cA')).toBe(false)

    // Transición REAL del scope abandonado: escala la RETENCIÓN con un fuerte.
    c.beginTransition('page_change')
    await tick()
    expect(be.ffmpeg.size).toBe(0)           // el huérfano murió
    expect(be.retenciones.size).toBe(0)      // retención resuelta
  })

  it('si NO se retuviera la identidad, la transición vería un snapshot vacío (mutación de control)', async () => {
    // Contraprueba conceptual: la sesión ya no está en el registry activo tras el
    // débil, así que sólo el registro de RETENCIÓN permite que la transición la
    // cierre. Aquí verificamos justamente que la transición la alcanza.
    const c = nuevoController()
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'main_h264', scope: sA })
    await c.close({ cameraId: 'cA', streamType: 'main_h264', reason: 'grid_retry' })
    await tick()
    expect(c.snapshot()).toHaveLength(0)     // el registro activo está vacío…
    expect(be.retenciones.size).toBe(1)      // …la identidad vive en la retención
    c.beginTransition('viewport_change')
    await tick()
    expect(be.ffmpeg.size).toBe(0)
  })

  it('retention_pending conserva token+intención fuerte hasta que el retry confirma el kill', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'main_h264', scope: sA })
    await c.close({ cameraId: 'cA', streamType: 'main_h264', reason: 'hls_fatal_error' })
    expect(be.retenciones.size).toBe(1)

    be.setKillSucceeds(false)
    c.beginTransition('page_change')
    await tick()
    expect(c.pending().list()).toHaveLength(1)
    expect(c.pending().list()[0].reason).toBe('page_change')
    expect(be.ffmpeg.size).toBe(1)
    expect(be.retenciones.size).toBe(1)

    be.setKillSucceeds(true)
    await c.retryCloses()
    expect(c.pending().size()).toBe(0)
    expect(be.ffmpeg.size).toBe(0)
    expect(be.retenciones.size).toBe(0)
  })
})

// ─── Escenario 9 · disposeView (bfcache/pagehide) no deja retención viva ─────

describe('C19 · disposeView finaliza también las retenciones de la vista (P0-4)', () => {
  it('tras un débil, disposeView cierra la vista y su FFmpeg conservado muere', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'main_h264', scope: sA })
    await c.close({ cameraId: 'cA', streamType: 'main_h264', reason: 'hls_fatal_error' })
    await tick()
    expect(be.ffmpeg.size).toBe(1)           // conservado
    expect(be.retenciones.size).toBe(1)

    c.disposeView()                          // pagehide/desmontaje
    await tick()
    expect(be.vivas()).toEqual([])
    expect(be.ffmpeg.size).toBe(0)           // la vista finalizó su retención
    expect(be.retenciones.size).toBe(0)
    expect(c.isAbandoned()).toBe(true)
  })
})

// ─── closeTracked (viewport de LiveView) también escala retenciones ──────────

describe('C19 · closeTracked escala las retenciones de las cámaras que abandona', () => {
  it('una cámara retenida cerrada por viewport termina su FFmpeg', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'main_h264', scope: sA })
    await c.close({ cameraId: 'cA', streamType: 'main_h264', reason: 'hls_fatal_error' })
    await tick()
    expect(be.ffmpeg.size).toBe(1)

    await c.closeTracked(['cA'], 'viewport_change')
    await tick()
    expect(be.ffmpeg.size).toBe(0)           // el huérfano retenido murió
    expect(be.retenciones.size).toBe(0)
  })
})
