// A1 (post #160) · el camino compartido de cierre.
//
// Tres fugas verificadas se cruzan acá:
//
//   1. el backend redirige `sub` → `main` (substream HEVC con principal H.264, y
//      `streamHealthStatus=USING_MAIN_STREAM`) y el frontend cerraba algunas
//      respuestas tardías como `sub`: la sesión real quedaba viva;
//   2. se cerraban con `viewport_changed`, que NO está en
//      `TRANSCODE_KILL_REASONS` —el conjunto tiene `viewport_change`—, así que
//      una sesión `main_h264` se borraba sin matar su FFmpeg;
//   3. el descarte tardío borraba del registro la entrada de la ranura sin
//      mirar QUÉ solicitud la había creado, así que se llevaba la anotación de
//      la sesión vigente de otra.
//
// El "backend" de este banco no borra por tipo a secas: guarda cada sesión con
// su intento propietario y aplica la MISMA regla de identidad que el API
// —rechazar el cierre tardío cuyo intento no coincide—. La decisión real de
// `stopStream` se ejecuta del lado del API, en `stream-manager-stale-close.test.ts`
// y `stale-close-identity.test.ts`; acá se comprueba lo que emite el cliente y
// cómo cuida su registro.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  closeTrackedSessions, closeStaleStart, forgetStoppedSubSessions,
  closeOneSession, retryPendingCloses,
} from './viewportSessionClose'
import { createPendingCloseQueue, type PendingCloseQueue } from './pendingCloses'
import { createSessionRegistry, type SessionRegistry } from './sessionRegistry'
import { resolveCreatedType, type StreamKind } from './streamTypes'
import type { CloseAck } from './viewportSessionClose'
import { STALE_RESPONSE, MATAN_FFMPEG } from './closeReasons'

interface SesionBackend { streamType: StreamKind; leases: Set<string> }

function makeBackend() {
  /** Sesiones vivas: `${cameraId}:${tipo}` → arrendamientos que la sostienen. */
  const sesiones = new Map<string, SesionBackend>()
  /** Procesos FFmpeg vivos, por streamPath. Sólo `main_h264` tiene uno. */
  const procesos = new Set<string>()
  const llamadas: Array<{
    cameraId: string; streamType: string; reason: string; expected?: string
  }> = []

  const abrir = (cameraId: string, tipo: StreamKind, ...leases: string[]) => {
    sesiones.set(`${cameraId}:${tipo}`, { streamType: tipo, leases: new Set(leases) })
    if (tipo === 'main_h264') procesos.add(`/${cameraId}_main_h264`)
  }

  /**
   * Réplica del contrato del backend, con la MISMA regla de arrendamientos que
   * `decideAttemptRelease`: un cierre tardío suelta sólo el suyo, y la sesión
   * cae únicamente cuando se suelta el último. Devuelve el desenlace explícito,
   * igual que la ruta HTTP.
   */
  const close = (
    cameraId: string, streamType: StreamKind, reason: string,
    _viewId: string, expected?: string,
  ): CloseAck => {
    llamadas.push({ cameraId, streamType, reason, expected })
    const clave = `${cameraId}:${streamType}`
    const viva = sesiones.get(clave)
    const isStale = reason === STALE_RESPONSE
    // Sólo estas razones autorizan matar el FFmpeg. `grid_retry`/`hls_fatal_error`
    // NO están: conservan el proceso a propósito.
    const mata = (MATAN_FFMPEG as readonly string[]).includes(reason)

    // Réplica EXACTA del contrato del backend (`decideAttemptRelease`): la
    // IDENTIDAD —no la razón— decide el modo.
    if (!expected) {
      // Sin identidad: una respuesta tardía se rechaza; un cierre deliberado a
      // granel cierra la ranura entera.
      if (isStale) return { emitted: true, status: 200, outcome: 'ignored', reason: 'missing_expected_id' }
      if (!viva) return { emitted: true, status: 200, outcome: 'ignored', reason: 'no_session' }
      sesiones.delete(clave)
      if (streamType === 'main_h264' && mata) procesos.delete(`/${cameraId}_main_h264`)
      return { emitted: true, status: 200, outcome: 'session_closed' }
    }

    // Con identidad: sólo se suelta ESE arrendamiento.
    if (!viva) return { emitted: true, status: 200, outcome: 'ignored', reason: 'no_session' }
    if (!viva.leases.has(expected)) {
      return { emitted: true, status: 200, outcome: 'ignored', reason: 'attempt_not_registered' }
    }
    viva.leases.delete(expected)
    if (viva.leases.size > 0) {
      return {
        emitted: true, status: 200, outcome: 'attempt_released',
        attemptId: expected, remainingAttempts: viva.leases.size,
      }
    }
    sesiones.delete(clave)
    if (streamType === 'main_h264' && mata) procesos.delete(`/${cameraId}_main_h264`)
    return { emitted: true, status: 200, outcome: 'session_closed', attemptId: expected }
  }

  return { sesiones, procesos, llamadas, abrir, close }
}

let be: ReturnType<typeof makeBackend>
let reg: SessionRegistry
let cola: PendingCloseQueue
beforeEach(() => {
  be = makeBackend(); reg = createSessionRegistry(); cola = createPendingCloseQueue()
})

const vivas = () => Array.from(be.sesiones.keys()).sort()

// ─── 1 · resolución del tipo creado ──────────────────────────────────────────

describe('(1) resolveCreatedType respeta el orden de fuentes', () => {
  it('`streamType` de la respuesta gana sobre todo lo demás', () => {
    expect(resolveCreatedType({ streamType: 'main', streamPath: 'cam_main' }, 'sub')).toBe('main')
  })

  it('sin `streamType`, manda el sufijo del path — primero el más específico', () => {
    expect(resolveCreatedType({ streamPath: '/live/cam_main_h264' }, 'sub')).toBe('main_h264')
    expect(resolveCreatedType({ streamPath: '/live/cam_main' }, 'sub')).toBe('main')
  })

  it('después la bandera `transcoded`, y sólo al final el tipo pedido', () => {
    expect(resolveCreatedType({ transcoded: true }, 'sub')).toBe('main_h264')
    expect(resolveCreatedType({ streamPath: '/live/cam_sub' }, 'sub')).toBe('sub')
    expect(resolveCreatedType({}, 'main')).toBe('main')
    expect(resolveCreatedType(undefined, 'sub')).toBe('sub')
  })

  it('un `streamType` basura no se cuela: se ignora y sigue la cadena', () => {
    expect(resolveCreatedType({ streamType: 'lo-que-sea', streamPath: '/c_main' }, 'sub')).toBe('main')
  })
})

// ─── 2 · respuesta tardía de grilla, sub → main ──────────────────────────────

describe('(2) respuesta tardía de grilla redirigida sub → main', () => {
  it('cierra `main`, nunca `sub`, y no queda sesión en el backend', async () => {
    be.abrir('c1', 'main', 'A')          // el backend redirigió y creó main

    const r = await closeStaleStart({
      cameraId: 'c1',
      info: { streamType: 'main', streamPath: '/c1_main' },
      requested: 'sub',                  // …pero la grilla había pedido sub
      startAttemptId: 'A',
      viewId: 'v1',
      close: be.close,
      registry: reg,
      pending: cola,
    })

    expect(r.created).toBe('main')
    expect(be.llamadas).toEqual([
      { cameraId: 'c1', streamType: 'main', reason: STALE_RESPONSE, expected: 'A' },
    ])
    expect(vivas()).toEqual([])
  })

  it('cerrar el tipo PEDIDO —el defecto— habría dejado la sesión viva', () => {
    be.abrir('c1', 'main', 'A')
    be.close('c1', 'sub', STALE_RESPONSE, 'v1', 'A')

    expect(vivas()).toEqual(['c1:main'])
  })
})

// ─── 3 · respuesta tardía main → main_h264 ───────────────────────────────────

describe('(3) respuesta tardía redirigida main → main_h264', () => {
  it('cierra main_h264 y, sin otro dueño, termina el FFmpeg', async () => {
    be.abrir('c1', 'main_h264', 'A')
    expect(be.procesos.has('/c1_main_h264')).toBe(true)

    await closeStaleStart({
      cameraId: 'c1',
      info: { transcoded: true, streamPath: '/c1_main_h264' },
      requested: 'main',
      startAttemptId: 'A',
      viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(vivas()).toEqual([])
    expect(Array.from(be.procesos)).toEqual([])
  })

  it('la razón es `stale_response`: con `viewport_changed` el proceso sobrevivía', async () => {
    be.abrir('c1', 'main_h264', 'A')
    await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })
    expect(be.llamadas[0].reason).toBe('stale_response')

    // Contraste explícito con la cadena que se enviaba antes.
    be.abrir('c2', 'main_h264', 'A')
    be.close('c2', 'main_h264', 'viewport_changed', 'v1')
    expect(be.sesiones.has('c2:main_h264')).toBe(false)   // la sesión sí se borra…
    expect(be.procesos.has('/c2_main_h264')).toBe(true)   // …pero el FFmpeg queda vivo
  })

  it('la confirmación es el desenlace del servidor, no que el fetch no lanzara', async () => {
    be.abrir('c1', 'main_h264', 'A')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })

    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(r.outcome).toBe('session_closed')
    expect(r.confirmed).toBe(true)
    expect(r.registryEntryRemoved).toBe(true)
  })
})

// ─── 3 bis · arrendamientos, no dueño único ──────────────────────────────────

describe('(3 bis) A y B sostienen la MISMA sesión main_h264', () => {
  beforeEach(() => {
    // El usuario inicia A y luego B. Las dos llegaron al servidor y las dos
    // quedaron registradas: la sesión tiene DOS arrendamientos.
    be.abrir('c1', 'main_h264', 'A', 'B')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })
  })

  it('el descarte de A suelta sólo A: la sesión y el FFmpeg de B siguen', async () => {
    const r = await closeStaleStart({
      cameraId: 'c1',
      info: { transcoded: true, streamPath: '/c1_main_h264' },
      requested: 'main',
      startAttemptId: 'A',
      viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(r.outcome).toBe('attempt_released')
    expect(r.confirmed).toBe(true)
    expect(vivas()).toEqual(['c1:main_h264'])
    expect(Array.from(be.sesiones.get('c1:main_h264')!.leases)).toEqual(['B'])
    expect(Array.from(be.procesos)).toEqual(['/c1_main_h264'])
  })

  it('y en el registro local sólo desaparece la entrada de A', async () => {
    await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['B'])
    expect(reg.size()).toBe(1)
  })

  it('cuando B también suelta, recién ahí cae la sesión y muere el proceso', async () => {
    await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main_h264',
      startAttemptId: 'B', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(r.outcome).toBe('session_closed')
    expect(vivas()).toEqual([])
    expect(Array.from(be.procesos)).toEqual([])
    expect(reg.size()).toBe(0)
  })

  it('el DELETE declara el intento propio en cada caso', async () => {
    await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(be.llamadas).toEqual([
      { cameraId: 'c1', streamType: 'main_h264', reason: STALE_RESPONSE, expected: 'A' },
    ])
  })
})

describe('(3 ter) un intento que NO está registrado no puede tocar nada', () => {
  beforeEach(() => {
    be.abrir('c1', 'main_h264', 'B')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })
  })

  it('el servidor responde `ignored` y el cliente no confirma nada', async () => {
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(r.outcome).toBe('ignored')
    expect(r.confirmed).toBe(false)
    expect(r.registryEntryRemoved).toBe(false)
  })

  it('la sesión, el proceso y la entrada de B quedan intactos', async () => {
    await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(vivas()).toEqual(['c1:main_h264'])
    expect(Array.from(be.procesos)).toEqual(['/c1_main_h264'])
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['B'])
  })
})

describe('(3 quater) sin confirmación explícita, la entrada NO se quita', () => {
  beforeEach(() => {
    be.abrir('c1', 'main_h264', 'A')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })
  })

  const casos: Array<[string, CloseAck]> = [
    ['401 (sesión expirada)', { emitted: true, status: 401 }],
    ['500 (error del servidor)', { emitted: true, status: 500 }],
    ['red caída', { emitted: false }],
    ['200 sin cuerpo legible', { emitted: true, status: 200 }],
    ['`ignored` del backend', { emitted: true, status: 200, outcome: 'ignored' }],
  ]

  it.each(casos)('%s: se conserva el registro', async (_titulo, ack) => {
    // Un `fetch` que no lanza NO es un cierre. Borrar la anotación acá dejaba
    // una sesión viva que nadie recordaba, y sólo el TTL la recogía.
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', registry: reg, pending: cola,
      close: () => ack,
    })

    expect(r.confirmed).toBe(false)
    expect(r.registryEntryRemoved).toBe(false)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
    // Y ADEMÁS queda en la cola: sin `pending.add` la sesión se perdería, y en
    // ViewPlayer —donde el descarte ni siquiera se registró— nada la cerraría.
    expect(r.enqueued).toBe(true)
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)
    expect(cola.list()[0]).toMatchObject({ reason: STALE_RESPONSE })
  })

  it('un `session_closed` SIN attemptId no confirma nada', async () => {
    // El caso exacto del contrato de confirmación exacta: aceptar la ausencia
    // como coincidencia convertía un cuerpo incompleto en una confirmación, y
    // la anotación de A desaparecía sin que nadie hubiera soltado su
    // arrendamiento.
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', registry: reg, pending: cola,
      close: () => ({ emitted: true, status: 200, outcome: 'session_closed' as const }),
    })

    expect(r.confirmed).toBe(false)
    expect(r.registryEntryRemoved).toBe(false)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
  })

  it('un `attempt_released` SIN attemptId tampoco', async () => {
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', registry: reg, pending: cola,
      close: () => ({ emitted: true, status: 200, outcome: 'attempt_released' as const }),
    })

    expect(r.confirmed).toBe(false)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
  })

  it('sólo la coincidencia EXACTA confirma', async () => {
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', registry: reg, pending: cola,
      close: () => ({
        emitted: true, status: 200, outcome: 'session_closed' as const, attemptId: 'A',
      }),
    })

    expect(r.confirmed).toBe(true)
    expect(r.registryEntryRemoved).toBe(true)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual([])
    // Confirmado: NO se encola. Encolar un cierre ya cumplido lo reintentaría
    // para siempre.
    expect(r.enqueued).toBe(false)
    expect(cola.size()).toBe(0)
  })

  it('un desenlace que habla de OTRO intento tampoco confirma', async () => {
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', registry: reg, pending: cola,
      close: () => ({ emitted: true, status: 200, outcome: 'session_closed' as const, attemptId: 'B' }),
    })

    expect(r.confirmed).toBe(false)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
  })

  it('un cierre que no informa (void, keepalive en descarga) tampoco confirma', async () => {
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', registry: reg, pending: cola,
      close: () => {},
    })

    expect(r.confirmed).toBe(false)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
  })
})

// ─── 3 quinquies · el descarte no confirmado se reintenta desde la cola ──────

describe('(3 quinquies) un descarte tardío no confirmado se reintenta y cierra', () => {
  const fallo500 = () => ({ emitted: true as const, status: 500 })

  it('HD sin otro lease: 500 → encola → retry confirma → cierra y mata el FFmpeg', async () => {
    // La sesión ni siquiera está en el registro local (caso ViewPlayer): la
    // cola es la ÚNICA memoria de que hay que cerrarla.
    be.abrir('c1', 'main_h264', 'A')
    expect(be.procesos.has('/c1_main_h264')).toBe(true)

    const r = await closeStaleStart({
      cameraId: 'c1', info: { transcoded: true, streamPath: '/c1_main_h264' },
      requested: 'main', startAttemptId: 'A', viewId: 'v1',
      close: fallo500, registry: reg, pending: cola,
    })
    // No confirmado: la sesión sigue viva y queda exactamente una pendiente.
    expect(r.confirmed).toBe(false)
    expect(r.enqueued).toBe(true)
    expect(cola.size()).toBe(1)
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)
    expect(vivas()).toEqual(['c1:main_h264'])
    expect(be.procesos.has('/c1_main_h264')).toBe(true)

    // El siguiente heartbeat reintenta contra el backend REAL.
    const res = await retryPendingCloses({ pending: cola, registry: reg, viewId: 'v1', close: be.close })
    expect(res.resueltos).toBe(1)
    expect(cola.size()).toBe(0)
    expect(vivas()).toEqual([])                       // cerró A, último lease
    expect(Array.from(be.procesos)).toEqual([])       // y murió su FFmpeg
  })

  it('A redirigido a main_h264 con B vigente: el retry de A jamás toca B', async () => {
    be.abrir('c1', 'main_h264', 'A', 'B')             // A y B sostienen la sesión
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })

    const r = await closeStaleStart({
      cameraId: 'c1', info: { transcoded: true, streamPath: '/c1_main_h264' },
      requested: 'main', startAttemptId: 'A', viewId: 'v1',
      close: fallo500, registry: reg, pending: cola,
    })
    expect(r.enqueued).toBe(true)
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)

    // Retry con el backend real: suelta SÓLO A. B y su FFmpeg siguen.
    await retryPendingCloses({ pending: cola, registry: reg, viewId: 'v1', close: be.close })
    expect(cola.size()).toBe(0)
    expect(vivas()).toEqual(['c1:main_h264'])
    expect(Array.from(be.sesiones.get('c1:main_h264')!.leases)).toEqual(['B'])
    expect(Array.from(be.procesos)).toEqual(['/c1_main_h264'])
    // La entrada local de B queda intacta: el retry de A no la tocó.
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['B'])
  })

  it('`attempt_not_registered` NO confirma: se conserva en la cola y se reintenta', async () => {
    // Una sesión reabierta por otra solicitud responde `attempt_not_registered`
    // al intento viejo. No es "no existe": el cierre no se da por hecho.
    be.abrir('c1', 'main_h264', 'B')                  // sólo B; A ya no tiene lease
    const r = await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'A', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })
    expect(r.outcome).toBe('ignored')
    expect(r.confirmed).toBe(false)
    expect(r.enqueued).toBe(true)
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)
  })
})

// ─── 3 sexies · confirmación = el MISMO contrato que la cola ──────────────────
//
// `closeStaleStart` ya no duplica la regla de confirmación: reusa
// `cierreConfirmado`. La copia local trataba un `ignored/no_session` como NO
// confirmado y lo reencolaba para siempre, aunque el backend ya hubiera
// declarado que la sesión no existe.
describe('(3 sexies) closeStaleStart confirma con el contrato de la cola', () => {
  beforeEach(() => {
    // Hay una anotación local del intento A: si se confirma, debe irse.
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })
  })

  const correr = (ack: CloseAck) => closeStaleStart({
    cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
    startAttemptId: 'A', viewId: 'v1', registry: reg, pending: cola,
    close: () => ack,
  })

  it('`ignored/no_session` CONFIRMA: no encola y limpia la anotación', async () => {
    const r = await correr({ emitted: true, status: 200, outcome: 'ignored', reason: 'no_session' })
    expect(r.confirmed).toBe(true)
    expect(r.enqueued).toBe(false)
    expect(r.registryEntryRemoved).toBe(true)
    expect(cola.size()).toBe(0)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual([])
  })

  it('`ignored/already_gone` CONFIRMA: tampoco encola', async () => {
    const r = await correr({ emitted: true, status: 200, outcome: 'ignored', reason: 'already_gone' })
    expect(r.confirmed).toBe(true)
    expect(r.enqueued).toBe(false)
    expect(cola.size()).toBe(0)
  })

  it('`ignored/attempt_not_registered` NO confirma: queda pendiente', async () => {
    const r = await correr({ emitted: true, status: 200, outcome: 'ignored', reason: 'attempt_not_registered' })
    expect(r.confirmed).toBe(false)
    expect(r.enqueued).toBe(true)
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)
    // Y NO se toca la anotación local: la sesión puede seguir viva.
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
  })
})

// ─── 4 · cierre por transición ───────────────────────────────────────────────

describe('(4) cierre por transición con main_h264', () => {
  it('no deja ni sesión ni proceso', async () => {
    be.abrir('c1', 'main_h264', 'A')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })

    await closeTrackedSessions({
      cameraIds: ['c1'], registry: reg, reason: 'viewport_change',
      viewId: 'v1', close: be.close, pending: cola,
    })

    expect(vivas()).toEqual([])
    expect(Array.from(be.procesos)).toEqual([])
    expect(reg.size()).toBe(0)
  })

  it('cierra la ranura aunque la creara otro intento: es deliberado', async () => {
    be.abrir('c1', 'main_h264', 'B')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })

    await closeTrackedSessions({
      cameraIds: ['c1'], registry: reg, reason: 'nvr_change', viewId: 'v1', close: be.close, pending: cola,
    })

    expect(vivas()).toEqual([])
    // Declara identidad AUNQUE sea deliberado: un retry tardío no puede cerrar
    // una sesión distinta. Acá coincide (B es lo registrado) y cierra.
    expect(be.llamadas[0].expected).toBe('B')
  })

  it('un retry deliberado de A NO cierra la sesión B que ocupó la ranura después', async () => {
    // El corazón de esta ronda, del lado del cliente. La cola recuerda que hay
    // que cerrar A; para cuando el retry corre, el backend ya sólo tiene a B.
    be.abrir('c1', 'main_h264', 'B')
    cola.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })

    const r = await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1', close: be.close,
    })

    // A no está registrada ⇒ `attempt_not_registered`. Eso NO confirma: la
    // ranura existe (es B), sólo que sin el lease A. B —sesión, lease y FFmpeg—
    // queda intacta, y A sigue en cola (no se toma por resuelta).
    expect(r).toEqual({ resueltos: 0, siguenPendientes: 1 })
    expect(be.llamadas).toEqual([
      { cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', expected: 'A' },
    ])
    expect(vivas()).toEqual(['c1:main_h264'])
    expect(Array.from(be.sesiones.get('c1:main_h264')!.leases)).toEqual(['B'])
    expect(Array.from(be.procesos)).toEqual(['/c1_main_h264'])
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)
  })

  it('cerrar todo como `sub` —el defecto— no cerraba nada', () => {
    be.abrir('c1', 'main_h264', 'A')
    be.close('c1', 'sub', 'viewport_change', 'v1')

    expect(vivas()).toEqual(['c1:main_h264'])
    expect(Array.from(be.procesos)).toEqual(['/c1_main_h264'])
  })
})

// ─── 5 · dos sesiones simultáneas por cámara ─────────────────────────────────

describe('(5) una cámara con `sub` de grilla y `main_h264` de foco', () => {
  beforeEach(() => {
    be.abrir('c1', 'sub', 'S')
    be.abrir('c1', 'main_h264', 'H')
    reg.add({ cameraId: 'c1', streamType: 'sub', startAttemptId: 'S' })
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'H' })
  })

  it('el cierre de la vista se lleva las DOS', async () => {
    await closeTrackedSessions({
      cameraIds: ['c1'], registry: reg, reason: 'nvr_change', viewId: 'v1', close: be.close, pending: cola,
    })

    expect(vivas()).toEqual([])
    expect(Array.from(be.procesos)).toEqual([])
    // Y en orden: primero lo que tiene proceso propio.
    expect(be.llamadas.map(l => l.streamType)).toEqual(['main_h264', 'sub'])
  })

  it('salir del foco se lleva sólo la de HD; la de la grilla sobrevive', () => {
    ;(['main', 'main_h264'] as StreamKind[]).forEach(t => {
      if (reg.hasType('c1', t)) { be.close('c1', t, 'exit_focus', 'v1'); reg.removeType('c1', t) }
    })

    expect(vivas()).toEqual(['c1:sub'])
    expect(Array.from(be.procesos)).toEqual([])
    expect(reg.typesOf('c1')).toEqual(['sub'])
  })

  it('un descarte tardío de la de HD no toca la de la grilla', async () => {
    await closeStaleStart({
      cameraId: 'c1', info: { streamType: 'main_h264' }, requested: 'main',
      startAttemptId: 'H', viewId: 'v1', close: be.close, registry: reg, pending: cola,
    })

    expect(vivas()).toEqual(['c1:sub'])
    expect(reg.typesOf('c1')).toEqual(['sub'])
    expect(reg.attemptsOf('c1', 'sub')).toEqual(['S'])
  })

  it('un `stoppedId` del heartbeat elimina SÓLO el `sub`', () => {
    // `reconcileView` sólo detiene sesiones sub; olvidar la cámara entera
    // borraba la anotación del HD concurrente y nadie volvía a cerrarlo.
    const quitadas = forgetStoppedSubSessions(reg, ['c1'])

    expect(quitadas).toEqual([{ cameraId: 'c1', streamType: 'sub' }])
    expect(reg.typesOf('c1')).toEqual(['main_h264'])
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['H'])
    // La sesión HD del backend sigue viva, que es coherente con lo anotado.
    expect(vivas()).toEqual(['c1:main_h264', 'c1:sub'])
  })

  it('un `stoppedId` de una cámara sin `sub` anotado no quita nada', () => {
    reg.removeType('c1', 'sub')
    expect(forgetStoppedSubSessions(reg, ['c1', 'c9'])).toEqual([])
    expect(reg.typesOf('c1')).toEqual(['main_h264'])
  })
})

// ─── 6 · cierre en lote ──────────────────────────────────────────────────────

describe('el cierre en lote sólo toca lo registrado', () => {
  it('una cámara sin sesiones no genera ninguna llamada', async () => {
    reg.add({ cameraId: 'c1', streamType: 'sub', startAttemptId: 'S' })
    be.abrir('c1', 'sub', 'S')

    const cerradas = await closeTrackedSessions({
      cameraIds: ['c1', 'c2', 'c3'], registry: reg, reason: 'stop_all',
      viewId: 'v1', close: be.close, pending: cola,
    })

    expect(cerradas).toEqual([{
      cameraId: 'c1',
      targets: [{ streamType: 'sub', startAttemptId: 'S' }],
      confirmadas: [{ streamType: 'sub', startAttemptId: 'S' }],
      pendientes: [],
    }])
    expect(be.llamadas.map(l => l.cameraId)).toEqual(['c1'])
    expect(cola.size()).toBe(0)
  })

  it('cada cámara se cierra con SUS tipos, no con los de la otra', async () => {
    be.abrir('c1', 'sub', 'A'); reg.add({ cameraId: 'c1', streamType: 'sub', startAttemptId: 'A' })
    be.abrir('c2', 'main', 'B'); reg.add({ cameraId: 'c2', streamType: 'main', startAttemptId: 'B' })
    be.abrir('c3', 'main_h264', 'C'); reg.add({ cameraId: 'c3', streamType: 'main_h264', startAttemptId: 'C' })

    await closeTrackedSessions({
      cameraIds: ['c1', 'c2', 'c3'], registry: reg, reason: 'layout_change',
      viewId: 'v1', close: be.close, pending: cola,
    })

    expect(vivas()).toEqual([])
    expect(Array.from(be.procesos)).toEqual([])
    expect(reg.size()).toBe(0)
  })

  it('si el cierre falla, la anotación se CONSERVA y queda en cola', async () => {
    // Antes se hacía `forget(cameraId)` pasara lo que pasara: la vista olvidaba
    // una sesión que seguía viva y nadie volvía a intentarlo. Para el HD ni
    // siquiera lo recogía el TTL, porque el heartbeat de grilla lo renueva.
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })
    be.abrir('c1', 'main_h264', 'A')

    const r = await closeTrackedSessions({
      cameraIds: ['c1'], registry: reg, reason: 'stop_all', viewId: 'v1',
      pending: cola, close: async () => { throw new Error('red caída') },
    })

    expect(r[0]).toMatchObject({
      confirmadas: [],
      pendientes: [{ streamType: 'main_h264', startAttemptId: 'A' }],
    })
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
    expect(cola.list()).toEqual([
      { cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'stop_all', attempts: 1, lastOutcome: 'no_ack' },
    ])
  })
})


// ─── 7 · cierres deliberados: sólo se olvida lo confirmado ───────────────────

describe('(7) el cierre deliberado exige confirmación', () => {
  beforeEach(() => {
    be.abrir('c1', 'sub', 'S')
    be.abrir('c1', 'main_h264', 'H')
    reg.add({ cameraId: 'c1', streamType: 'sub', startAttemptId: 'S' })
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'H' })
  })

  const sinConfirmar: Array<[string, CloseAck | undefined]> = [
    ['500 del servidor', { emitted: true, status: 500 }],
    ['401 (sesión expirada)', { emitted: true, status: 401 }],
    ['red caída', { emitted: false }],
    ['`ignored` por rechazo', { emitted: true, status: 200, outcome: 'ignored', reason: 'reaffirmed_by_newer_request' }],
    ['200 sin cuerpo legible', { emitted: true, status: 200 }],
  ]

  it.each(sinConfirmar)('%s: `closeOneSession` conserva el HD y lo encola', async (_t, ack) => {
    const resuelto = await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', viewId: 'v1',
      registry: reg, pending: cola, close: () => ack,
    })

    expect(resuelto).toBe(false)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['H'])
    expect(cola.has('c1', 'main_h264', 'H')).toBe(true)
  })

  it('un `session_closed` sí resuelve y limpia', async () => {
    const resuelto = await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', viewId: 'v1',
      registry: reg, pending: cola, close: be.close,
    })

    expect(resuelto).toBe(true)
    expect(reg.typesOf('c1')).toEqual(['sub'])
    expect(cola.size()).toBe(0)
    expect(Array.from(be.procesos)).toEqual([])
  })

  it('un `ignored` porque ya no existe también resuelve: no hay qué reintentar', async () => {
    const resuelto = await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', viewId: 'v1',
      registry: reg, pending: cola,
      close: () => ({ emitted: true, status: 200, outcome: 'ignored' as const, reason: 'no_session' }),
    })

    expect(resuelto).toBe(true)
    expect(reg.hasType('c1', 'main_h264')).toBe(false)
    expect(cola.size()).toBe(0)
  })

  it('el cierre en lote conserva lo no confirmado y confirma el resto', async () => {
    const r = await closeTrackedSessions({
      cameraIds: ['c1'], registry: reg, reason: 'nvr_change', viewId: 'v1', pending: cola,
      // El sub cierra; el HD contesta 500.
      close: (id, tipo, razon, v, exp) =>
        tipo === 'main_h264' ? { emitted: true, status: 500 } : be.close(id, tipo, razon, v, exp),
    })

    expect(r[0]).toMatchObject({
      confirmadas: [{ streamType: 'sub', startAttemptId: 'S' }],
      pendientes: [{ streamType: 'main_h264', startAttemptId: 'H' }],
    })
    expect(reg.typesOf('c1')).toEqual(['main_h264'])
    expect(cola.has('c1', 'main_h264', 'H')).toBe(true)
    // Y la sesión HD, efectivamente, sigue viva del otro lado.
    expect(vivas()).toEqual(['c1:main_h264'])
  })
})

// ─── 8 · reintento hasta confirmar ───────────────────────────────────────────

describe('(8) la cola de cierres pendientes se reintenta', () => {
  beforeEach(() => {
    be.abrir('c1', 'main_h264', 'H')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'H' })
  })

  it('un reintento confirmado limpia registro y cola', async () => {
    // Primer intento: 500. Queda pendiente.
    await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', viewId: 'v1',
      registry: reg, pending: cola, close: () => ({ emitted: true, status: 500 }),
    })
    expect(cola.size()).toBe(1)

    // Segundo: el servidor responde y cierra.
    const r = await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1', close: be.close,
    })

    expect(r).toEqual({ resueltos: 1, siguenPendientes: 0 })
    expect(reg.size()).toBe(0)
    expect(vivas()).toEqual([])
    expect(Array.from(be.procesos)).toEqual([])
  })

  it('mientras no se confirme, sigue en cola y cuenta los intentos', async () => {
    await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', viewId: 'v1',
      registry: reg, pending: cola, close: () => ({ emitted: true, status: 500 }),
    })
    await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1', close: () => ({ emitted: false }),
    })
    await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1', close: () => ({ emitted: false }),
    })

    expect(cola.list()[0]).toMatchObject({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', attempts: 3,
    })
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['H'])
    expect(vivas()).toEqual(['c1:main_h264'])
  })

  it('el reintento conserva la razón original del cierre', async () => {
    await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'switch_to_sub', viewId: 'v1',
      registry: reg, pending: cola, close: () => ({ emitted: true, status: 500 }),
    })

    await retryPendingCloses({ pending: cola, registry: reg, viewId: 'v1', close: be.close })

    // `switch_to_sub` está en el conjunto que mata FFmpeg; una razón inventada
    // en el reintento habría dejado el proceso vivo.
    expect(be.llamadas[be.llamadas.length - 1]).toMatchObject({ reason: 'switch_to_sub' })
    expect(Array.from(be.procesos)).toEqual([])
  })

  it('con la cola vacía no hace nada', async () => {
    const r = await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1', close: be.close,
    })

    expect(r).toEqual({ resueltos: 0, siguenPendientes: 0 })
    expect(be.llamadas).toEqual([])
  })
})

// ─── 9 · identidad del objetivo en cierres deliberados y sus retries ─────────
//
// Séptima revisión: un retry de `exit_focus` del intento A no puede cerrar una
// sesión B abierta después sobre la misma cámara/tipo.

describe('(9) un retry deliberado nunca cierra una sesión abierta después', () => {
  it('exit_focus falla → reentrada B → retry: B, registro y FFmpeg siguen vivos', async () => {
    // 1 · foco A: sesión HD con lease A, anotada.
    be.abrir('c1', 'main_h264', 'A')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })

    // 2 · salir de foco, pero el cierre falla (500): A queda en cola, anotado.
    const primero = await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', viewId: 'v1',
      registry: reg, pending: cola, close: () => ({ emitted: true, status: 500 }),
    })
    expect(primero).toBe(false)
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)

    // 3 · el usuario RE-ENTRA a foco: el backend reutiliza la sesión y suma B;
    //     la vista anota B.
    be.abrir('c1', 'main_h264', 'A', 'B')   // el backend ahora sostiene {A, B}
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })

    // 4 · corre el retry de A (desde la cadencia del heartbeat).
    const r = await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1', close: be.close,
    })

    // A se suelta (attempt_released), pero B —sesión, registro y FFmpeg— sobrevive.
    expect(r).toEqual({ resueltos: 1, siguenPendientes: 0 })
    expect(vivas()).toEqual(['c1:main_h264'])
    expect(Array.from(be.sesiones.get('c1:main_h264')!.leases)).toEqual(['B'])
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['B'])
    expect(Array.from(be.procesos)).toEqual(['/c1_main_h264'])
  })

  it('un ack de A (attempt_released) no elimina la anotación de B', async () => {
    // B es la sesión vigente y está anotada. El retry de A recibe su propio
    // desenlace —`attempt_released` con attemptId A—: se limpia A y B queda
    // intacta. La confirmación se ata al attemptId, así que jamás borra a B.
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })
    cola.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })

    await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1',
      close: () => ({ emitted: true, status: 200, outcome: 'attempt_released' as const, attemptId: 'A', remainingAttempts: 1 }),
    })

    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['B'])   // B intacta
    expect(cola.has('c1', 'main_h264', 'A')).toBe(false)       // A confirmada, sale de la cola
  })

  it('`attempt_not_registered` en un retry NO lo saca de la cola (regresión #7)', async () => {
    // La ranura existe (B) pero sin el lease A: NO es confirmación. A se conserva
    // para reintentar; tratarlo como resuelto olvidaba sesiones de reconcile.
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })
    cola.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })

    const r = await retryPendingCloses({
      pending: cola, registry: reg, viewId: 'v1',
      close: () => ({ emitted: true, status: 200, outcome: 'ignored' as const, reason: 'attempt_not_registered' }),
    })

    expect(r).toEqual({ resueltos: 0, siguenPendientes: 1 })
    expect(cola.has('c1', 'main_h264', 'A')).toBe(true)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['A'])
  })

  it('grid retry de main_h264 envía exactamente "main_h264" (no el objeto SessionEntry)', async () => {
    be.abrir('c1', 'main_h264', 'H')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'H' })

    // grid_retry conserva el FFmpeg: no está en las razones que matan.
    await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'grid_retry', viewId: 'v1',
      registry: reg, pending: cola, close: be.close,
    })

    expect(be.llamadas).toEqual([
      { cameraId: 'c1', streamType: 'main_h264', reason: 'grid_retry', expected: 'H' },
    ])
    // La sesión se cerró (último lease) pero el proceso sobrevive: grid_retry lo
    // reutiliza al re-arrancar.
    expect(vivas()).toEqual([])
    expect(Array.from(be.procesos)).toEqual(['/c1_main_h264'])
  })

  it.each([
    ['grid_retry', { emitted: true, status: 500 } as CloseAck],
    ['grid_retry', { emitted: false } as CloseAck],
    ['grid_retry', { emitted: true, status: 200, outcome: 'ignored', reason: 'reaffirmed_by_newer_request' } as CloseAck],
    ['hls_fatal_error', { emitted: true, status: 500 } as CloseAck],
    ['hls_fatal_error', { emitted: false } as CloseAck],
    ['hls_fatal_error', { emitted: true, status: 200, outcome: 'ignored', reason: 'reaffirmed_by_newer_request' } as CloseAck],
  ])('%s con desenlace no confirmado preserva el registro y encola (%#)', async (razon, ack) => {
    be.abrir('c1', 'main_h264', 'H')
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'H' })

    const resuelto = await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: razon, viewId: 'v1',
      registry: reg, pending: cola, close: () => ack,
    })

    expect(resuelto).toBe(false)
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['H'])
    expect(cola.has('c1', 'main_h264', 'H')).toBe(true)
  })
})

// ─── 10 · confirmar A no puede llevarse una B co-registrada en la misma ranura ─
//
// La diferencia entre `removeAttempt` (por identidad) y `removeType` (amplio):
// si al confirmar A se usara `removeType`, una B viva sobre la misma cámara/tipo
// —cuyo propio cierre aún no se confirmó— desaparecería del registro y nadie la
// volvería a cerrar.

describe('(10) al confirmar un arrendamiento no se arrastra otro de la misma ranura', () => {
  // A se confirma (attempt_released); B falla (500) y debe seguir anotada.
  const closeAConfirmaBfalla = (
    _id: string, _t: StreamKind, _r: string, _v: string, expected?: string,
  ): CloseAck => expected === 'A'
    ? { emitted: true, status: 200, outcome: 'attempt_released', attemptId: 'A', remainingAttempts: 1 }
    : { emitted: true, status: 500 }

  it('closeOneSession: confirma A, conserva B en registro y cola', async () => {
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })

    await closeOneSession({
      cameraId: 'c1', streamType: 'main_h264', reason: 'exit_focus', viewId: 'v1',
      registry: reg, pending: cola, close: closeAConfirmaBfalla,
    })

    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['B'])
    expect(cola.has('c1', 'main_h264', 'B')).toBe(true)
    expect(cola.has('c1', 'main_h264', 'A')).toBe(false)
  })

  it('closeTrackedSessions: confirma A, conserva B en registro y cola', async () => {
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A' })
    reg.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B' })

    const r = await closeTrackedSessions({
      cameraIds: ['c1'], registry: reg, reason: 'nvr_change', viewId: 'v1',
      pending: cola, close: closeAConfirmaBfalla,
    })

    expect(r[0].confirmadas).toEqual([{ streamType: 'main_h264', startAttemptId: 'A' }])
    expect(r[0].pendientes).toEqual([{ streamType: 'main_h264', startAttemptId: 'B' }])
    expect(reg.attemptsOf('c1', 'main_h264')).toEqual(['B'])
    expect(cola.has('c1', 'main_h264', 'B')).toBe(true)
  })
})
