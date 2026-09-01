// A1 (posterior a #160) · vigencia DOBLE del cambio de calidad.
//
// Una solicitud de calidad puede quedar obsoleta por dos motivos distintos:
// porque cambió el viewport (token) o porque el usuario eligió otra calidad
// dentro del mismo viewport (secuencia). La segunda se comprobaba DENTRO de
// `apply`, con un `return` silencioso: la respuesta superada no aplicaba estado
// —bien— pero la sesión que el backend acababa de crear para ella quedaba viva
// —mal—. Un FFmpeg de más por cada clic rápido, hasta que venciera el TTL.
//
// Acá se ejecutan los tres módulos de producción juntos: el controlador de
// calidad real, `runViewportRequest` real y el coordinador de transición real.
// El "backend" mantiene sus sesiones vivas, así que una fuga se ve.
import { describe, it, expect, beforeEach } from 'vitest'
import { runViewportRequest } from './viewportRequest'
import { resolveCreatedType, type StreamKind } from './streamTypes'
import { closeStaleStart } from './viewportSessionClose'
import { createSessionRegistry } from './sessionRegistry'
import { createPendingCloseQueue } from './pendingCloses'
import { STALE_RESPONSE } from './closeReasons'
import { newStartAttemptId } from './startAttempt'
import { createViewportTransition, type ViewportTransition } from './viewportTransition'
import { createQualitySwitchController } from '@/components/cameras/qualitySwitchController'

interface Info { streamPath?: string; transcoded?: boolean; streamType?: string }

function diferida<T = void>() {
  let resolver!: (v: T) => void
  const promise = new Promise<T>(r => { resolver = r })
  return { promise, resolver: (v?: any) => resolver(v) }
}

function makeBench() {
  /** Sesiones vivas del lado del backend, por `${cam}:${tipo}`. */
  const sesiones = new Set<string>()
  /** Estado visible del foco. */
  const aplicado: Array<{ seq: number; tipo: StreamKind }> = []
  const eventos: string[] = []

  const qualityCtl = createQualitySwitchController()
  const registry = createSessionRegistry()
  const pendingCloses = createPendingCloseQueue()
  /** seq → intento, para que el banco sepa quién creó cada sesión. */
  const intentos = new Map<number, string>()
  const transition: ViewportTransition<null> = createViewportTransition<null>({
    suspendScheduler: () => {},
    armScheduler: () => {},
    runHeartbeatNow: async () => null,
    invalidateWork: () => {},
    closeSessions: async () => {},
    publishViewport: () => {},
    awaitPublished: async () => {},
    isHidden: () => false,
  })

  const cam = 'c1'

  /** Dueño de cada sesión del backend, para aplicar la regla de identidad. */
  const duenos = new Map<string, string>()

  /** Mismo cableado que `handleQualitySwitch` en la página. */
  function switchQuality(quality: StreamKind, respuesta: Promise<Info>) {
    const token = transition.current()
    const decision = qualityCtl.request(cam, quality)
    if (decision.action === 'ignore') return Promise.resolve('ignored' as const)
    const seq = decision.seq
    // Intento de ESTA operación lógica, generado antes del POST.
    const startAttemptId = newStartAttemptId()
    intentos.set(seq, startAttemptId)

    return runViewportRequest<Info>({
      isCurrent: () => transition.isCurrent(token) && qualityCtl.isCurrent(cam, seq),
      request: () => respuesta,
      discard: (info) => {
        // Camino COMPARTIDO de cierre: resuelve el tipo real, usa la razón del
        // contrato y declara su intento. Es el mismo que ejecuta la página.
        void closeStaleStart({
          cameraId: cam, info, requested: quality, startAttemptId, viewId: 'v1',
          registry, pending: pendingCloses,
          close: (id, tipo, reason, _v, expected) => {
            eventos.push(`close:${tipo}:${reason}:${expected}`)
            // Regla del backend: un cierre tardío sólo suelta su arrendamiento,
            // y devuelve el desenlace explícito.
            if (!expected || duenos.get(`${id}:${tipo}`) !== expected) {
              return { emitted: true, status: 200, outcome: 'ignored' as const }
            }
            sesiones.delete(`${id}:${tipo}`)
            duenos.delete(`${id}:${tipo}`)
            return {
              emitted: true, status: 200,
              outcome: 'session_closed' as const, attemptId: expected,
            }
          },
          onClose: ({ created }) => { eventos.push(`discard:${seq}:${created}`) },
        })
      },
      apply: (info) => {
        const creado = resolveCreatedType(info, quality)
        eventos.push(`apply:${seq}:${creado}`)
        aplicado.push({ seq, tipo: creado })
        registry.add({ cameraId: cam, streamType: creado, startAttemptId })
      },
      always: () => { qualityCtl.settle(cam, seq) },
    })
  }

  /** El backend crea la sesión del tipo que realmente sirvió, con su dueño. */
  function responder(
    d: ReturnType<typeof diferida<Info>>, info: Info, creado: StreamKind, seq = 1,
  ) {
    sesiones.add(`${cam}:${creado}`)
    duenos.set(`${cam}:${creado}`, intentos.get(seq)!)
    d.resolver(info)
  }

  return {
    sesiones, aplicado, eventos, transition, switchQuality, responder, cam, registry,
    intentos, duenos,
  }
}

let b: ReturnType<typeof makeBench>
beforeEach(() => { b = makeBench() })

describe('(4) A→B dentro del mismo viewport, respuestas B→A', () => {
  it('sólo B aplica, y la sesión creada por A se cierra', async () => {
    const rA = diferida<Info>()
    const rB = diferida<Info>()

    const pA = b.switchQuality('main', rA.promise)     // clic 1
    const pB = b.switchQuality('main_h264', rB.promise) // clic 2, supera al 1

    // Contesta primero B —la vigente— y después A, fuera de orden.
    b.responder(rB, { streamPath: '/c1_main_h264' }, 'main_h264')
    expect(await pB).toBe('applied')
    b.responder(rA, { streamPath: '/c1_main' }, 'main')
    expect(await pA).toBe('discarded')

    expect(b.aplicado.map(a => a.tipo)).toEqual(['main_h264'])
    // La de A no puede seguir viva: nadie la mira.
    expect(Array.from(b.sesiones)).toEqual(['c1:main_h264'])
  })

  it('la superada entra por `discard`, no por un return dentro de `apply`', async () => {
    const rA = diferida<Info>()
    const rB = diferida<Info>()
    b.switchQuality('main', rA.promise)
    b.switchQuality('main_h264', rB.promise)

    b.responder(rB, { streamPath: '/c1_main_h264' }, 'main_h264')
    await Promise.resolve()
    b.responder(rA, { streamPath: '/c1_main' }, 'main')
    await Promise.resolve(); await Promise.resolve()

    expect(b.eventos).toContain('discard:1:main')
    expect(b.eventos.some(e => e.startsWith('apply:1:'))).toBe(false)
  })

  it('sin superación, la única selección aplica y su sesión queda viva', async () => {
    const r = diferida<Info>()
    const p = b.switchQuality('main', r.promise)
    b.responder(r, { streamPath: '/c1_main' }, 'main')

    expect(await p).toBe('applied')
    expect(Array.from(b.sesiones)).toEqual(['c1:main'])
  })
})

describe('(5) `main` redirigido a `main_h264` y luego superado', () => {
  it('se cierra main_h264, que es lo que el backend creó', async () => {
    const rA = diferida<Info>()
    const rB = diferida<Info>()

    const pA = b.switchQuality('main', rA.promise)   // pedido main…
    b.switchQuality('sub', rB.promise)               // …y superado enseguida

    // El backend redirigió: la sesión viva es main_h264, no main.
    b.responder(rA, { transcoded: true, streamPath: '/c1_main_h264' }, 'main_h264')

    expect(await pA).toBe('discarded')
    expect(b.eventos).toContain('discard:1:main_h264')
    // Cerrar `main` no habría cerrado nada y el FFmpeg seguiría corriendo.
    expect(b.sesiones.has('c1:main_h264')).toBe(false)
    // El DELETE declara el intento de la selección superada, que es lo que
    // permite al backend distinguirla de la vigente.
    expect(b.eventos).toContain(`close:main_h264:${STALE_RESPONSE}:${b.intentos.get(1)}`)
  })

  it('la redirección se detecta también por el sufijo del streamPath', async () => {
    const rA = diferida<Info>()
    const pA = b.switchQuality('main', rA.promise)
    b.switchQuality('sub', diferida<Info>().promise)

    b.responder(rA, { streamPath: '/live/c1_main_h264' }, 'main_h264')

    expect(await pA).toBe('discarded')
    expect(Array.from(b.sesiones)).toEqual([])
  })

  it('y el cambio de viewport cierra igual el tipo creado', async () => {
    const rA = diferida<Info>()
    const pA = b.switchQuality('main', rA.promise)

    await b.transition.run('nvr_change', null)
    b.responder(rA, { transcoded: true }, 'main_h264')

    expect(await pA).toBe('discarded')
    expect(b.eventos).toContain('discard:1:main_h264')
    expect(Array.from(b.sesiones)).toEqual([])
  })
})

describe('resolveCreatedType', () => {
  it('respeta el tipo pedido cuando no hubo redirección', () => {
    expect(resolveCreatedType({ streamPath: '/c1_main' }, 'main')).toBe('main')
    expect(resolveCreatedType({ streamPath: '/c1_sub' }, 'sub')).toBe('sub')
    expect(resolveCreatedType(null, 'main')).toBe('main')
  })

  it('detecta la redirección por bandera y por sufijo', () => {
    expect(resolveCreatedType({ transcoded: true }, 'main')).toBe('main_h264')
    expect(resolveCreatedType({ streamPath: '/x/c1_main_h264' }, 'main')).toBe('main_h264')
  })
})
