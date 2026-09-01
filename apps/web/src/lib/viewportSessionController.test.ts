// A1 (post #160) · pruebas de SISTEMA del controlador de ciclo de vida.
//
// El controlador es el único dueño del arranque, cierre, timers, heartbeat,
// registro y cola. Acá se ejercita su orquestación contra un backend falso que
// aplica la MISMA regla de identidad que el API real (`decideAttemptRelease`):
// un cierre suelta sólo su arrendamiento, la sesión cae con el último, y el
// FFmpeg de `main_h264` muere con la sesión. Los timers son inyectados y
// controlables, así que todo se prueba sin DOM.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createViewportSessionController, type ControllerTimers,
} from './viewportSessionController'
import type { CloseAck } from './viewportSessionClose'
import type { StreamKind } from './streamTypes'

// ─── Timers controlables ─────────────────────────────────────────────────────
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
    /** Dispara los timers vencidos. Los intervalos se reprograman. */
    advance(ms: number) {
      ahora += ms
      for (const [id, t] of [...tareas]) {
        if (t.due <= ahora) {
          if (t.every) t.due += t.every          // el intervalo persiste…
          else tareas.delete(id)                  // …el timeout es de una vez
          t.fn()
        }
      }
    },
    pending: () => tareas.size,
  }
}

// ─── Backend falso con identidad por arrendamiento ──────────────────────────
type Cam = 'hevc' | 'h264' | 'subHevcMainOk'   // decide la redirección efectiva
function makeBackend() {
  interface Ses { streamType: StreamKind; leases: Set<string> }
  const sesiones = new Map<string, Ses>()      // `${cam}:${tipo}` → sesión
  const ffmpeg = new Set<string>()             // paths main_h264 vivos
  const heartbeatsRecibidos: string[][] = []   // cámaras de cada heartbeat
  let camKind: Cam = 'hevc'
  let siguienteError: 'abort' | number | 'network' | null = null

  const efectivo = (requested: StreamKind): { tipo: StreamKind; path: string; transcoded: boolean } => {
    if (requested === 'main_h264') return { tipo: 'main_h264', path: 'main_h264', transcoded: true }
    if (requested === 'main') {
      return camKind === 'hevc'
        ? { tipo: 'main_h264', path: 'main_h264', transcoded: true }
        : { tipo: 'main', path: 'main', transcoded: false }
    }
    // sub
    if (camKind === 'hevc') return { tipo: 'main_h264', path: 'main_h264', transcoded: true } // sub→main_h264
    if (camKind === 'subHevcMainOk') return { tipo: 'main', path: 'main', transcoded: false }  // sub→main
    return { tipo: 'sub', path: 'sub', transcoded: false }
  }

  const startStream = async (cameraId: string, body: Record<string, unknown>, signal: AbortSignal) => {
    const requested = (body.streamType as StreamKind) ?? 'sub'
    const startAttemptId = body.startAttemptId as string
    await Promise.resolve()
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (siguienteError) {
      const e = siguienteError; siguienteError = null
      if (e === 'network') throw new Error('network')
      throw Object.assign(new Error('http'), { response: { status: e } })
    }
    const { tipo, path, transcoded } = efectivo(requested)
    const clave = `${cameraId}:${tipo}`
    const s = sesiones.get(clave) ?? { streamType: tipo, leases: new Set<string>() }
    s.leases.add(startAttemptId)
    sesiones.set(clave, s)
    if (tipo === 'main_h264') ffmpeg.add(`/${cameraId}_main_h264`)
    return { streamPath: `/${cameraId}_${path}`, transcoded, hls: `h/${cameraId}`, startAttemptId }
  }

  const close: (c: string, t: StreamKind, r: string, v: string, e?: string) => CloseAck =
    (cameraId, streamType, _reason, _viewId, expected) => {
      const clave = `${cameraId}:${streamType}`
      const s = sesiones.get(clave)
      if (!expected) {
        if (!s) return { emitted: true, status: 200, outcome: 'ignored', reason: 'no_session' }
        sesiones.delete(clave); ffmpeg.delete(`/${cameraId}_main_h264`)
        return { emitted: true, status: 200, outcome: 'session_closed' }
      }
      if (!s) return { emitted: true, status: 200, outcome: 'ignored', reason: 'no_session' }
      if (!s.leases.has(expected)) return { emitted: true, status: 200, outcome: 'ignored', reason: 'attempt_not_registered' }
      s.leases.delete(expected)
      if (s.leases.size > 0) return { emitted: true, status: 200, outcome: 'attempt_released', attemptId: expected, remainingAttempts: s.leases.size }
      sesiones.delete(clave); ffmpeg.delete(`/${cameraId}_main_h264`)
      return { emitted: true, status: 200, outcome: 'session_closed', attemptId: expected }
    }

  return {
    startStream, close,
    /** Abre una sesión con arrendamientos directos (simula un start cuya respuesta se perdió). */
    abrir: (cam: string, tipo: StreamKind, ...leases: string[]) => {
      const clave = `${cam}:${tipo}`
      const s = sesiones.get(clave) ?? { streamType: tipo, leases: new Set<string>() }
      leases.forEach(l => s.leases.add(l))
      sesiones.set(clave, s)
      if (tipo === 'main_h264') ffmpeg.add(`/${cam}_main_h264`)
    },
    closeView: () => { sesiones.clear(); ffmpeg.clear() },
    heartbeat: async (cams: string[], signal: AbortSignal) => {
      await Promise.resolve()
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      heartbeatsRecibidos.push(cams)
      return { streams: {} }
    },
    sesiones, ffmpeg, heartbeatsRecibidos,
    setCam: (k: Cam) => { camKind = k },
    failNext: (e: 'abort' | number | 'network') => { siguienteError = e },
    leasesDe: (cam: string, tipo: StreamKind) => Array.from(sesiones.get(`${cam}:${tipo}`)?.leases ?? []),
    vivas: () => Array.from(sesiones.keys()).sort(),
  }
}

let be: ReturnType<typeof makeBackend>
let ft: ReturnType<typeof fakeTimers>
function nuevoController() {
  return createViewportSessionController({
    viewId: 'v1',
    startStream: be.startStream,
    close: be.close,
    closeView: be.closeView,
    timers: ft.api,
  })
}
beforeEach(() => { be = makeBackend(); ft = fakeTimers() })

const tick = () => new Promise(r => setTimeout(r, 0))

describe('arranque: acepta en scope, descarta fuera de scope', () => {
  it('acepta y registra por tipo efectivo + intento REAL', async () => {
    const c = nuevoController()
    const s = c.publishScope()
    const r = await c.start({ source: 'grid', cameraId: 'c1', requested: 'sub', scope: s })
    expect(r).not.toBeNull()
    expect(r!.effectiveType).toBe('main_h264')            // hevc: sub→main_h264
    expect(c.registry().attemptsOf('c1', 'main_h264')).toEqual([r!.startAttemptId])
    expect(be.ffmpeg.has('/c1_main_h264')).toBe(true)
  })

  it('scope cambió ANTES del POST: no emite, no registra', async () => {
    const c = nuevoController()
    const s = c.publishScope()
    c.publishScope()                                       // otro scope se publicó
    const r = await c.start({ source: 'grid', cameraId: 'c1', requested: 'sub', scope: s })
    expect(r).toBeNull()
    expect(be.vivas()).toEqual([])                         // nunca se creó nada
  })

  it('scope cambió DESPUÉS de la respuesta: se descarta por identidad, no registra', async () => {
    const c = nuevoController()
    const s = c.publishScope()
    const p = c.start({ source: 'grid', cameraId: 'c1', requested: 'sub', scope: s })
    c.publishScope()                                       // cambia mientras viaja
    const r = await p
    expect(r).toBeNull()
    await tick()
    expect(c.registry().has('c1')).toBe(false)             // no se anotó
    expect(be.vivas()).toEqual([])                         // la sesión creada se cerró
    expect(be.ffmpeg.size).toBe(0)                         // y su FFmpeg murió
  })
})

describe('transición atómica ACTIVE(A) → ACTIVE(B)', () => {
  it('publica scope nuevo, cierra A por identidad y deja vivo sólo B', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'sub', scope: sA })
    expect(be.vivas()).toEqual(['cA:main_h264'])

    const sB = c.beginTransition('page_change')            // A→B
    expect(c.isCurrent(sA)).toBe(false)
    expect(c.isCurrent(sB)).toBe(true)
    await tick()                                           // deja correr los cierres
    expect(be.vivas()).toEqual([])                         // A cerrada por identidad
    expect(be.ffmpeg.size).toBe(0)

    await c.start({ source: 'grid', cameraId: 'cB', requested: 'sub', scope: sB })
    expect(be.vivas()).toEqual(['cB:main_h264'])           // sólo B vigente
  })

  it('la request de A en vuelo al transicionar se descarta por identidad (no se orfana)', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    const p = c.start({ source: 'grid', cameraId: 'cA', requested: 'sub', scope: sA })
    c.beginTransition('nvr_change')                        // publica scope nuevo (NO aborta el arranque)
    const r = await p
    await tick()
    // La respuesta de A no registra nada y su sesión server-side se cerró por
    // identidad: nunca queda un FFmpeg huérfano por haber abortado el cliente.
    expect(r).toBeNull()
    expect(c.registry().has('cA')).toBe(false)
    expect(be.vivas()).toEqual([])
    expect(be.ffmpeg.size).toBe(0)
  })

  it('el cierre no confirmado de A queda en pending y el retry es SÓLO-CIERRE', async () => {
    // Un close que falla la PRIMERA vez (500) y confirma después.
    let fallar = true
    const closeConFallo: typeof be.close = (cam, tipo, reason, viewId, expected) => {
      if (fallar) { fallar = false; return { emitted: true, status: 500 } as CloseAck }
      return be.close(cam, tipo, reason, viewId, expected)
    }
    const c = createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: closeConFallo,
      closeView: be.closeView, timers: ft.api,
    })
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'sub', scope: sA })
    expect(be.vivas()).toEqual(['cA:main_h264'])

    c.beginTransition('page_change')
    await tick()
    expect(c.pending().size()).toBe(1)                     // 500 → no confirmado → pendiente
    expect(be.vivas()).toEqual(['cA:main_h264'])           // A sigue viva

    // El retry SÓLO cierra: ahora confirma. Nunca arranca ni renueva A.
    await c.retryCloses()
    expect(c.pending().size()).toBe(0)
    expect(be.vivas()).toEqual([])                         // recién ahora cae A
    expect(be.ffmpeg.size).toBe(0)
  })
})

describe('A y B misma cámara/tipo efectivo: A nunca toca B', () => {
  it('el descarte tardío de A no toca la sesión B vigente (identidad exacta)', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    const a = await c.start({ source: 'grid', cameraId: 'c1', requested: 'main_h264', scope: sA })
    // B llega y se suma a la misma ranura.
    const b = await c.start({ source: 'grid', cameraId: 'c1', requested: 'main_h264', scope: sA })
    // Simulamos el descarte tardío de A por identidad soltando SU intento.
    be.close('c1', 'main_h264', 'stale_response', 'v1', a!.startAttemptId)
    expect(be.leasesDe('c1', 'main_h264')).toEqual([b!.startAttemptId])
    expect(be.ffmpeg.has('/c1_main_h264')).toBe(true)      // B sostiene el proceso
  })
})

describe('timers HLS registrados y atados a scope', () => {
  it('el timer sólo corre si el scope sigue vigente', () => {
    const c = nuevoController()
    const s = c.publishScope()
    let corrio = false
    c.scheduleHlsRestart('c1', s, 2000, () => { corrio = true })
    expect(c.timerCount()).toBe(1)
    c.publishScope()                                       // cambia el scope
    ft.advance(2000)
    expect(corrio).toBe(false)                             // no corre: scope viejo
    expect(c.timerCount()).toBe(0)
  })

  it('re-programar la misma clave cancela el anterior', () => {
    const c = nuevoController()
    const s = c.publishScope()
    let n = 0
    c.scheduleHlsRestart('c1', s, 2000, () => { n++ })
    c.scheduleHlsRestart('c1', s, 2000, () => { n++ })
    expect(c.timerCount()).toBe(1)
    ft.advance(2000)
    expect(n).toBe(1)
  })

  it('beginTransition cancela todos los timers', () => {
    const c = nuevoController()
    const s = c.publishScope()
    c.scheduleHlsRestart('c1', s, 2000, () => {})
    c.scheduleHlsRestart('c2', s, 2000, () => {})
    expect(c.timerCount()).toBe(2)
    c.beginTransition('page_change')
    expect(c.timerCount()).toBe(0)
  })
})

describe('heartbeat: parado en la transición, sin cámaras de A después', () => {
  it('tras beginTransition no se envía heartbeat de A', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    let cams = ['cA']
    c.bindHeartbeat({ intervalMs: 30_000, isHidden: () => false, send: (sig) => be.heartbeat(cams, sig) })
    c.startHeartbeat()
    await c.beatNow()                                      // un latido de A
    expect(be.heartbeatsRecibidos).toEqual([['cA']])

    c.beginTransition('page_change')                       // detiene el heartbeat
    cams = ['cB']
    await c.beatNow()                                      // no hay scheduler activo…
    // …así que no se envió ningún heartbeat nuevo con cámaras de A ni de B.
    expect(be.heartbeatsRecibidos).toEqual([['cA']])
  })
})

describe('disposeView: abandono real', () => {
  it('aborta, cancela timers, para heartbeat y cierra la vista', async () => {
    const c = nuevoController()
    const s = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'c1', requested: 'sub', scope: s })
    c.scheduleHlsRestart('c1', s, 2000, () => {})
    let cerroVista = false
    const c2 = createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: be.close,
      closeView: () => { cerroVista = true }, timers: ft.api,
    })
    const s2 = c2.publishScope()
    c2.scheduleHlsRestart('x', s2, 2000, () => {})
    c2.disposeView()
    expect(cerroVista).toBe(true)
    expect(c2.timerCount()).toBe(0)
  })
})

// ─── Cableado de producción: A→B con B colgada o en error ───────────────────
describe('A activo con heartbeat → transición a B colgada', () => {
  function conRetry(closeMs = 5_000) {
    return createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: be.close,
      closeView: be.closeView, timers: ft.api, closeRetryMs: closeMs,
    })
  }

  it('tras beginTransition: cero heartbeats con cámaras de A; A cerrada o en retry', async () => {
    const c = conRetry()
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'sub', scope: sA })
    let cams = ['cA']
    c.bindHeartbeat({ intervalMs: 30_000, isHidden: () => false, scope: sA, send: (sig) => be.heartbeat(cams, sig) })
    c.startHeartbeat()
    await c.beatNow()
    expect(be.heartbeatsRecibidos).toEqual([['cA']])

    // Commit de ruta B (B aún no carga: no se liga su heartbeat todavía).
    c.beginTransition('page_change')
    await tick()
    // A se cerró por identidad (o quedó en cola); su sesión no sigue viva sin dueño.
    expect(c.registry().snapshot().filter(e => e.cameraId === 'cA')).toEqual([])
    // Aunque el scheduler viejo intentara latir, el scope viejo lo bloquea.
    cams = ['cA']
    await c.beatNow()
    expect(be.heartbeatsRecibidos).toEqual([['cA']])   // NINGÚN latido nuevo con cámaras de A
    expect(be.vivas()).toEqual([])
  })

  it('cierre de A que falla (500) durante B colgada: el retry SÓLO-CIERRE lo libera sin heartbeat', async () => {
    let fallar = true
    const closeConFallo: typeof be.close = (cam, tipo, r, v, e) =>
      fallar ? ((fallar = false), { emitted: true, status: 500 }) : be.close(cam, tipo, r, v, e)
    const c = createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: closeConFallo,
      closeView: be.closeView, timers: ft.api, closeRetryMs: 5_000,
    })
    const sA = c.publishScope()
    await c.start({ source: 'grid', cameraId: 'cA', requested: 'sub', scope: sA })

    c.beginTransition('nvr_change')
    await tick()
    // El primer cierre falló → queda pendiente y la sesión sigue viva.
    expect(c.pending().size()).toBe(1)
    expect(be.vivas()).toEqual(['cA:main_h264'])
    const beatsAntes = be.heartbeatsRecibidos.length

    // El retry SÓLO-CIERRE corre solo (sin heartbeat) y libera A.
    ft.advance(5_000)
    await tick()
    expect(c.pending().size()).toBe(0)
    expect(be.vivas()).toEqual([])
    expect(be.heartbeatsRecibidos.length).toBe(beatsAntes)   // no hubo ningún POST de heartbeat
  })

  it('un heartbeat de A en vuelo que resuelve tras la transición no se aplica', async () => {
    const c = conRetry()
    const sA = c.publishScope()
    let aplicado: unknown = null
    // Gate manual: el heartbeat de A queda en vuelo hasta que lo soltamos.
    let soltar!: () => void
    const enVuelo = new Promise<void>(r => { soltar = r })
    c.bindHeartbeat({
      intervalMs: 30_000, isHidden: () => false, scope: sA,
      send: async () => { await enVuelo; return { streams: { cA: { hls: 'x' } } } },
      onResult: (res) => { aplicado = res },
    })
    c.startHeartbeat()
    const beat = c.beatNow()

    // El scope cambia mientras el latido de A viaja (sin detener el scheduler:
    // así se ejercita la guarda de scope de `onResult`, no el abort del stop).
    c.publishScope()
    soltar()                            // recién ahora resuelve A
    await beat
    expect(aplicado).toBeNull()         // el resultado de A NO se aplicó (scope viejo)
  })
})

describe('transición cierra SÓLO el scope abandonado, nunca una B de otro scope', () => {
  it('dos attempts A y B (misma cámara/tipo, distinto scope): la transición cierra sólo A', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    const a = await c.start({ source: 'grid', cameraId: 'c1', requested: 'main_h264', scope: sA })
    // B se registra en un scope NUEVO (como si otra ruta ya la hubiera abierto).
    const sB = c.publishScope()
    const b = await c.start({ source: 'grid', cameraId: 'c1', requested: 'main_h264', scope: sB })
    expect(be.leasesDe('c1', 'main_h264').sort()).toEqual([a!.startAttemptId, b!.startAttemptId].sort())

    // Transición que abandona sB: cierra sólo lo de sB… pero A es de sA y sigue.
    // (Elegimos cerrar el scope B para mostrar que A —de otro scope— no se toca.)
    c.closeExactEntries(
      c.registry().snapshot().filter(e => e.ownerScope === sB),
      'page_change',
    )
    await tick()
    expect(be.leasesDe('c1', 'main_h264')).toEqual([a!.startAttemptId])   // sólo B soltó
    expect(c.registry().attemptsOf('c1', 'main_h264')).toEqual([a!.startAttemptId])
    expect(be.ffmpeg.has('/c1_main_h264')).toBe(true)                     // A sostiene el proceso
  })
})

// ─── Activación UNIVERSAL del retry + single-flight + reconcile ─────────────
describe('el retry SÓLO-CIERRE se activa venga el cierre de donde venga', () => {
  function conFallo1(camKind: Cam = 'hevc') {
    let fallar = true
    const closeConFallo: typeof be.close = (c, t, r, v, e) =>
      fallar ? ((fallar = false), { emitted: true, status: 500 } as CloseAck) : be.close(c, t, r, v, e)
    be.setCam(camKind)
    return createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: closeConFallo,
      closeView: be.closeView, timers: ft.api, closeRetryMs: 5_000,
    })
  }

  it('start A responde TRAS la transición: stale 500 → pending → retry AUTOMÁTICO libera A sin heartbeat', async () => {
    const c = conFallo1('hevc')                      // sub → main_h264
    const sA = c.publishScope()
    const p = c.start({ source: 'grid', cameraId: 'cA', requested: 'sub', scope: sA })
    c.beginTransition('page_change')                 // B toma el control; A aún no registrada
    const r = await p
    expect(r).toBeNull()                             // A llegó tarde → se descartó por identidad…
    await tick()
    expect(c.pending().size()).toBe(1)               // …pero el DELETE dio 500 → quedó pendiente
    expect(be.vivas()).toEqual(['cA:main_h264'])
    const beats = be.heartbeatsRecibidos.length

    ft.advance(5_000); await tick()                  // el retry corre SOLO (activado por discardStale)
    expect(c.pending().size()).toBe(0)
    expect(be.vivas()).toEqual([])
    expect(be.heartbeatsRecibidos.length).toBe(beats)   // NUNCA usó el heartbeat
  })

  it('sub→main con una B vigente del mismo tipo: el retry de A jamás toca B', async () => {
    const c = conFallo1('subHevcMainOk')             // sub → main
    const sA = c.publishScope()
    const a = await c.start({ source: 'grid', cameraId: 'c1', requested: 'sub', scope: sA })
    expect(a!.effectiveType).toBe('main')
    // B se registra en un scope nuevo, misma cámara/tipo.
    const sB = c.publishScope()
    const b = await c.start({ source: 'grid', cameraId: 'c1', requested: 'sub', scope: sB })
    expect(be.leasesDe('c1', 'main').sort()).toEqual([a!.startAttemptId, b!.startAttemptId].sort())

    // Se cierra sólo la identidad de A (scope sA); su primer DELETE falla (500).
    c.closeExactEntries(c.registry().snapshot().filter(e => e.ownerScope === sA), 'page_change')
    await tick()
    expect(c.pending().size()).toBe(1)
    ft.advance(5_000); await tick()
    expect(c.pending().size()).toBe(0)
    expect(be.leasesDe('c1', 'main')).toEqual([b!.startAttemptId])   // B intacta
  })

  it('retry single-flight: dos retryCloses concurrentes → un solo DELETE en vuelo', async () => {
    let concurrentes = 0, pico = 0
    let liberar!: () => void
    const gate = new Promise<void>(r => { liberar = r })
    // Close async con barrera: deja cruzar dos retries para observar el pico.
    const closeAsync = (async () => {
      concurrentes++; pico = Math.max(pico, concurrentes)
      await gate; concurrentes--
      return { emitted: true, status: 500 } as CloseAck
    }) as unknown as typeof be.close
    const c = createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: closeAsync,
      closeView: be.closeView, timers: ft.api,
    })
    c.pending().add({ cameraId: 'cA', streamType: 'sub', startAttemptId: 'sa-1', reason: 'x' })

    const r1 = c.retryCloses()
    const r2 = c.retryCloses()          // single-flight: retorna temprano
    liberar()
    await Promise.all([r1, r2])
    expect(pico).toBe(1)                 // jamás dos DELETE simultáneos
  })
})

// ─── P0: single-flight por IDENTIDAD para TODOS los cierres ─────────────────
describe('un solo DELETE por identidad, aunque coincidan retry y cierre exacto/close', () => {
  function conCloseContado() {
    const deletes: Record<string, number> = {}
    let liberar!: () => void
    const gate = new Promise<void>(r => { liberar = r })
    const closeContado: typeof be.close = (async (cam: string, tipo: StreamKind, r: string, v: string, e?: string) => {
      deletes[`${cam}:${tipo}:${e}`] = (deletes[`${cam}:${tipo}:${e}`] ?? 0) + 1
      await gate
      return be.close(cam, tipo, r, v, e)
    }) as unknown as typeof be.close
    const c = createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: closeContado,
      closeView: be.closeView, timers: ft.api,
    })
    return { c, deletes, liberar }
  }

  it('close + closeExactEntries concurrentes de A (B viva): un solo DELETE, pending vacío, B intacta', async () => {
    const { c, deletes, liberar } = conCloseContado()
    be.abrir('c1', 'main_h264', 'sa-A', 'sa-B')
    c.registerReconciled('c1', 'main_h264', 'sa-A')

    const p1 = c.close({ cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus' })
    c.closeExactEntries([{ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'sa-A' }], 'page_change')
    await tick()                                   // ambos llegaron a `closeCoord`
    liberar()
    await p1; await tick()

    expect(deletes['c1:main_h264:sa-A']).toBe(1)   // UN solo DELETE de A
    expect(c.pending().size()).toBe(0)             // sin entrada huérfana
    expect(be.leasesDe('c1', 'main_h264')).toEqual(['sa-B'])   // B intacta
    expect(be.ffmpeg.has('/c1_main_h264')).toBe(true)
  })

  it('closeTracked + retry concurrentes de A: un solo DELETE, B intacta', async () => {
    const { c, deletes, liberar } = conCloseContado()
    be.abrir('c1', 'main_h264', 'sa-A', 'sa-B')
    c.registerReconciled('c1', 'main_h264', 'sa-A')
    // La pendiente lleva la razón del cierre que la encoló (misma fuerza que el
    // closeTracked de abajo): dos cierres de la MISMA fuerza comparten el DELETE.
    c.pending().add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'sa-A', reason: 'page_change' })

    const p1 = c.closeTracked(['c1'], 'page_change')
    const p2 = c.retryCloses()
    await tick()
    liberar()
    await Promise.all([p1, p2]); await tick()

    expect(deletes['c1:main_h264:sa-A']).toBe(1)
    expect(be.leasesDe('c1', 'main_h264')).toEqual(['sa-B'])
  })

  it('closeStale + closeExact concurrentes de A: un solo DELETE, B intacta', async () => {
    const { c, deletes, liberar } = conCloseContado()
    be.abrir('c1', 'main_h264', 'sa-A', 'sa-B')

    const p1 = c.closeStale({ cameraId: 'c1', info: { transcoded: true, streamPath: '/c1_main_h264' }, requested: 'main', startAttemptId: 'sa-A' })
    c.closeExactEntries([{ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'sa-A' }], 'page_change')
    await tick()
    liberar()
    await p1; await tick()

    expect(deletes['c1:main_h264:sa-A']).toBe(1)
    expect(be.leasesDe('c1', 'main_h264')).toEqual(['sa-B'])
  })

  it('una identidad ya confirmada (misma fuerza) no vuelve a emitir DELETE ni se re-encola', async () => {
    const { c, deletes, liberar } = conCloseContado()
    be.abrir('c1', 'main_h264', 'sa-A', 'sa-B')
    // A se registra ANTES del primer cierre: así `close` SÍ la cierra (si no, el
    // primer DELETE saldría recién de closeExactEntries y el test sería un falso
    // positivo).
    c.registerReconciled('c1', 'main_h264', 'sa-A')
    const p1 = c.close({ cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus' })  // terminante (strong)
    liberar()
    await p1; await tick()
    expect(deletes['c1:main_h264:sa-A']).toBe(1)
    // SECUENCIAL: un cierre TERMINANTE posterior de A ya confirmada-fuerte.
    c.closeExactEntries([{ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'sa-A' }], 'page_change')
    await tick()
    // No hubo un segundo DELETE (fuerte ya satisfecho), ni A quedó en cola.
    expect(deletes['c1:main_h264:sa-A']).toBe(1)
    expect(c.pending().has('c1', 'main_h264', 'sa-A')).toBe(false)
    expect(be.leasesDe('c1', 'main_h264')).toEqual(['sa-B'])
  })

  it('FUERZA: un cierre CONSERVADOR confirmado NO suprime un cierre TERMINANTE posterior', async () => {
    // El corazón de P0-1 del lado cliente: una confirmación débil no puede
    // consumir un cierre fuerte. El fuerte DEBE salir (para escalar en el backend).
    const { c, deletes, liberar } = conCloseContado()
    be.abrir('c1', 'main_h264', 'sa-A')
    c.registerReconciled('c1', 'main_h264', 'sa-A')
    // Conservador (hls_fatal_error = weak): confirma y borra la anotación.
    const p1 = c.close({ cameraId: 'c1', streamType: 'main_h264', reason: 'hls_fatal_error' })
    liberar()
    await p1; await tick()
    expect(deletes['c1:main_h264:sa-A']).toBe(1)
    // Terminante (page_change = strong) POSTERIOR de la MISMA identidad, por el
    // camino exacto (que lleva el intento explícito, no depende del registro):
    // NO se suprime, sale su DELETE para que el backend escale.
    c.closeExactEntries([{ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'sa-A' }], 'page_change')
    await tick()
    expect(deletes['c1:main_h264:sa-A']).toBe(2)
  })

  it('FUERZA: dos conservadores de la misma identidad SÍ comparten un DELETE', async () => {
    const { c, deletes, liberar } = conCloseContado()
    be.abrir('c1', 'main_h264', 'sa-A')
    c.registerReconciled('c1', 'main_h264', 'sa-A')
    const p1 = c.close({ cameraId: 'c1', streamType: 'main_h264', reason: 'hls_fatal_error' })
    liberar()
    await p1; await tick()
    // Otro conservador ya satisfecho-débil: no re-emite.
    await c.close({ cameraId: 'c1', streamType: 'main_h264', reason: 'grid_retry' })
    expect(deletes['c1:main_h264:sa-A']).toBe(1)
  })
})

describe('respuesta perdida: el heartbeat recupera la identidad real y la transición la cierra', () => {
  it('reconcile registra el srv-* real; beginTransition la cierra EXACTO', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    // El backend ACEPTÓ el start (creó la sesión) pero la respuesta HTTP se
    // perdió: el cliente no la registró. El heartbeat trae su identidad REAL.
    be.abrir('cA', 'main_h264', 'srv-1')
    c.registerReconciled('cA', 'main_h264', 'srv-1')
    expect(c.registry().attemptsOf('cA', 'main_h264')).toEqual(['srv-1'])
    expect(be.vivas()).toEqual(['cA:main_h264'])

    // La transición cierra esa identidad exacta —recuperada por el heartbeat—.
    c.beginTransition('page_change')
    await tick()
    expect(be.vivas()).toEqual([])
    expect(be.ffmpeg.size).toBe(0)
    // Y jamás se fabricó un `hb:*`.
    void sA
  })
})

describe('disposeView (bfcache/desmontaje): abandona TODO, incl. maquinaria adoptada', () => {
  it('ejecuta los hooks de dispose (detiene el scheduler adoptado), cancela timers, cierra la vista y marca abandonado', () => {
    let cerroVista = false
    let adoptadoDetenido = false
    const c = createViewportSessionController({
      viewId: 'v1', startStream: be.startStream, close: be.close,
      closeView: () => { cerroVista = true }, timers: ft.api,
    })
    // La página adopta su scheduler y registra su parada como hook de dispose.
    c.onDispose(() => { adoptadoDetenido = true })
    const s = c.publishScope()
    c.scheduleHlsRestart('k', s, 2000, () => {})
    expect(c.timerCount()).toBe(1)
    expect(c.isAbandoned()).toBe(false)

    c.disposeView()

    expect(adoptadoDetenido).toBe(true)   // el HOOK adoptado se ejecutó (no sólo onDispose de nombre)
    expect(c.timerCount()).toBe(0)         // timers cancelados
    expect(cerroVista).toBe(true)          // vista cerrada por keepalive
    expect(c.isAbandoned()).toBe(true)     // marcada abandonada → pageshow recarga
  })

  it('tras disposeView el scope queda invalidado: una respuesta de arranque tardía no registra', async () => {
    const c = nuevoController()
    const sA = c.publishScope()
    const p = c.start({ source: 'grid', cameraId: 'cA', requested: 'sub', scope: sA })
    c.disposeView()                        // aborta A en vuelo + invalida el scope
    const r = await p.catch(() => 'abortada')
    await tick()
    // A no registró nada: fue abortada, o (si resolvió) el scope invalidado la
    // descartó por identidad. En ninguno de los dos casos queda anotada.
    expect(r === null || r === 'abortada').toBe(true)
    expect(c.registry().has('cA')).toBe(false)
  })
})

describe('reconcile: identidad REAL srv-*, nunca sintética', () => {
  it('registra con el srv-* que devolvió el backend', () => {
    const c = nuevoController()
    c.publishScope()
    expect(c.registerReconciled('c1', 'sub', 'srv-abc')).toBe(true)
    expect(c.registry().attemptsOf('c1', 'sub')).toEqual(['srv-abc'])
  })
  it('sin identidad real no anota nada', () => {
    const c = nuevoController()
    c.publishScope()
    expect(c.registerReconciled('c1', 'sub', '')).toBe(false)
    expect(c.registry().has('c1')).toBe(false)
  })
})
