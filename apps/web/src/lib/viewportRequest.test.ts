// A1 · una solicitud que resuelve DESPUÉS del cambio de viewport.
//
// Requisito 8 de la revisión de #159: cualquier respuesta de una generación
// anterior no puede aplicar estado, ni tocar carga/errores, ni sumar a
// `activeSessions`, ni reencolar expiraciones — y si creó una sesión en el
// backend, tiene que cerrarla en el acto.
//
// Acá se ejecuta la secuencia completa con el coordinador de transición REAL y
// el ciclo de vida REAL (`runViewportRequest`, el mismo que usan el arranque de
// grid, la entrada en foco, la readquisición de HD y el cambio de calidad).
// El "backend" mantiene un conjunto de sesiones vivas: si una respuesta vieja
// se olvidara de cerrarse, el conjunto quedaría con una sesión sin espectador y
// el test lo ve — no es una comprobación de cadenas.
import { describe, it, expect, beforeEach } from 'vitest'
import { runViewportRequest } from './viewportRequest'
import { createViewportTransition, type ViewportTransition } from './viewportTransition'

interface Info { id: string; hls: string }

function diferida<T = void>() {
  let resolver!: (v: T) => void
  let rechazar!: (e: unknown) => void
  const promise = new Promise<T>((r, j) => { resolver = r; rechazar = j })
  // La promesa se rechaza a mano en los casos de error; sin este `catch` de
  // cortesía Node avisaría de un rechazo no manejado antes de que el ciclo la
  // consuma.
  promise.catch(() => {})
  return { promise, resolver: (v?: any) => resolver(v), rechazar: (e?: any) => rechazar(e) }
}

function makeBench() {
  /** Sesiones vivas en el "backend". Una vieja no cerrada queda acá. */
  const sesionesBackend = new Set<string>()
  /** Contabilidad del cliente: lo que la vista cree tener abierto. */
  const activeSessions = new Set<string>()
  const pendingStarts = new Set<string>()
  const loading: Record<string, boolean> = {}
  const errores: Record<string, string> = {}
  const streams: Record<string, Info> = {}
  const eventos: string[] = []

  const enVuelo: Array<{ id: string; d: ReturnType<typeof diferida<Info>> }> = []

  const transition: ViewportTransition<null> = createViewportTransition<null>({
    suspendScheduler: () => {},
    armScheduler: () => {},
    runHeartbeatNow: async () => null,
    invalidateWork: () => {},
    closeSessions: async (reason) => {
      // El cierre del viewport anterior: sólo lo que la vista sabe que abrió.
      activeSessions.forEach(id => { sesionesBackend.delete(id) })
      activeSessions.clear()
      eventos.push(`close_all:${reason}`)
    },
    publishViewport: () => {},
    awaitPublished: async () => {},
    isHidden: () => false,
  })

  /** Mismo cableado que `loadStream` en la página. */
  function loadStream(id: string) {
    pendingStarts.add(id)
    loading[id] = true
    const token = transition.current()
    const d = diferida<Info>()
    enVuelo.push({ id, d })

    return runViewportRequest<Info>({
      isCurrent: () => transition.isCurrent(token),
      request: () => d.promise,
      discard: () => {
        eventos.push(`start_discarded:${id}`)
        sesionesBackend.delete(id)      // cierre inmediato de lo que el backend creó
      },
      apply: (info) => {
        activeSessions.add(id)
        streams[id] = info
        delete errores[id]
      },
      onError: (e: any) => { errores[id] = String(e?.message ?? e) },
      always: () => { pendingStarts.delete(id) },
      settleIfCurrent: () => { loading[id] = false },
    })
  }

  /** El backend crea la sesión y responde. */
  function responder(indice: number) {
    const { id, d } = enVuelo[indice]
    sesionesBackend.add(id)
    d.resolver({ id, hls: `/hls/${id}.m3u8` })
  }
  function fallar(indice: number, msg = 'boom') {
    enVuelo[indice].d.rechazar(new Error(msg))
  }

  return {
    transition, sesionesBackend, activeSessions, pendingStarts,
    loading, errores, streams, eventos, responder, fallar, loadStream,
  }
}

let b: ReturnType<typeof makeBench>
beforeEach(() => { b = makeBench() })

describe('respuesta exitosa que llega después del cambio de viewport', () => {
  it('no aplica estado y CIERRA la sesión que el backend creó', async () => {
    const arranque = b.loadStream('a1')

    // El viewport cambia mientras la solicitud viaja.
    await b.transition.run('nvr_change', null)

    b.responder(0)
    expect(await arranque).toBe('discarded')

    expect(b.activeSessions.size).toBe(0)
    expect(b.streams).toEqual({})
    expect(b.errores).toEqual({})
    // Y sobre todo: nada quedó vivo del otro lado. Si no se cerrara, sería un
    // FFmpeg sin espectador hasta el TTL (90 s) más la poda (hasta 120 s más).
    expect(Array.from(b.sesionesBackend)).toEqual([])
    expect(b.eventos).toContain('start_discarded:a1')
  })

  it('no toca el indicador de carga del viewport nuevo, pero sí limpia su contabilidad', async () => {
    b.loadStream('a1')
    await b.transition.run('nvr_change', null)
    // El viewport nuevo pone SU propio spinner para la misma cámara.
    b.loading['a1'] = true

    b.responder(0)
    await Promise.resolve(); await Promise.resolve()

    expect(b.loading['a1']).toBe(true)          // el spinner del viewport nuevo sigue
    expect(b.pendingStarts.has('a1')).toBe(false) // pero el arranque viejo se descontó
  })

  it('la respuesta vigente sí aplica, cierra el spinner y registra la sesión', async () => {
    const arranque = b.loadStream('a1')
    b.responder(0)

    expect(await arranque).toBe('applied')
    expect(b.activeSessions.has('a1')).toBe(true)
    expect(b.loading['a1']).toBe(false)
    expect(b.streams['a1']).toEqual({ id: 'a1', hls: '/hls/a1.m3u8' })
    expect(b.sesionesBackend.has('a1')).toBe(true)
  })
})

describe('error que llega después del cambio de viewport', () => {
  it('no muestra nada al usuario nuevo', async () => {
    const arranque = b.loadStream('a1')
    await b.transition.run('page_change', null)

    b.fallar(0, 'CAMERA_OFFLINE')
    expect(await arranque).toBe('error_discarded')

    expect(b.errores).toEqual({})
    expect(b.loading['a1']).toBe(true)          // no se tocó el estado visible
    expect(b.pendingStarts.has('a1')).toBe(false)
  })

  it('un error vigente sí se muestra', async () => {
    const arranque = b.loadStream('a1')
    b.fallar(0, 'CAMERA_OFFLINE')

    expect(await arranque).toBe('error')
    expect(b.errores['a1']).toContain('CAMERA_OFFLINE')
    expect(b.loading['a1']).toBe(false)
  })
})

describe('el cierre del viewport anterior no puede dejar huérfanas las que viajaban', () => {
  it('A abre, se cambia a B, y la respuesta de A no sobrevive al cierre', async () => {
    // Dos cámaras del viewport A: una ya respondió, otra sigue viajando.
    const p1 = b.loadStream('a1')
    const p2 = b.loadStream('a2')
    b.responder(0)
    await p1
    expect(b.sesionesBackend.has('a1')).toBe(true)

    // Cambio de viewport: el cierre se lleva lo que la vista sabía que tenía.
    await b.transition.run('nvr_change', null)
    expect(b.sesionesBackend.has('a1')).toBe(false)

    // a2 responde tarde: el cierre no pudo llevársela porque todavía no
    // existía. Tiene que cerrarse sola.
    b.responder(1)
    expect(await p2).toBe('discarded')
    expect(Array.from(b.sesionesBackend)).toEqual([])
  })

  it('A→B→C: sólo lo de C queda vivo', async () => {
    const pA = b.loadStream('a1')
    await b.transition.run('nvr_change', null)   // → B
    const pB = b.loadStream('b1')
    await b.transition.run('nvr_change', null)   // → C
    const pC = b.loadStream('c1')

    b.responder(0)   // a1, dos generaciones tarde
    b.responder(1)   // b1, una generación tarde
    b.responder(2)   // c1, vigente

    expect(await pA).toBe('discarded')
    expect(await pB).toBe('discarded')
    expect(await pC).toBe('applied')

    expect(Array.from(b.sesionesBackend)).toEqual(['c1'])
    expect(Array.from(b.activeSessions)).toEqual(['c1'])
  })
})

describe('la comprobación es POSTERIOR al await, no anterior', () => {
  it('una solicitud iniciada y resuelta dentro de la misma generación aplica', async () => {
    // Si la guarda se evaluara antes de enviar, este caso también pasaría; el
    // que lo distingue es el de arriba, donde el cambio ocurre en pleno vuelo.
    const p = b.loadStream('a1')
    b.responder(0)
    expect(await p).toBe('applied')
  })

  it('el cambio ocurrido en pleno vuelo se detecta aunque el token fuera válido al salir', async () => {
    const token = b.transition.current()
    const d = diferida<Info>()
    let aplicado = false

    const p = runViewportRequest<Info>({
      isCurrent: () => b.transition.isCurrent(token),
      request: () => d.promise,
      apply: () => { aplicado = true },
      discard: () => {},
    })

    b.transition.begin('layout_change')
    d.resolver({ id: 'x', hls: '' })

    expect(await p).toBe('discarded')
    expect(aplicado).toBe(false)
  })
})
