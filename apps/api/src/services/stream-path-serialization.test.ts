// A1.7 · auditoría de la ÚLTIMA carrera de MediaMTX (punto 6 del encargo).
//
// La prueba 23 de #153 cubre una republicación que ocurre ANTES de emitir el
// DELETE: la revalidación síncrona la detecta y no borra. Acá se audita la
// secuencia siguiente, que esa revalidación no puede cubrir:
//
//   la revalidación permite borrar
//   → se emite el DELETE y queda pendiente su respuesta
//   → un arranque nuevo publica el MISMO path
//   → termina el DELETE anterior
//
// La pregunta a responder con una prueba controlada —no con una suposición— es
// si el alta siempre repara la ruta o si el DELETE viejo puede retirar una
// publicación nueva.
//
// MediaMTX se modela con un `Set` de paths configurados: POST agrega, DELETE
// quita. Las dos operaciones tienen compuertas para ordenar la carrera sin
// tiempos reales.
import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.ENABLE_HEVC_TRANSCODING = 'true'

/** Estado del servidor de medios simulado. */
const mediamtxPaths = new Set<string>()
const calls: string[] = []
let deleteGate: Promise<void> | null = null
let postGate: Promise<void> | null = null
/**
 * Ganchos del POST, para las pruebas que miden el MOMENTO de la revalidación.
 * `onPostStarted` se dispara con el cerrojo ya tomado y antes de la compuerta;
 * `onPostCompleted`, una vez que el path quedó publicado.
 */
let onPostStarted: (() => void) | null = null
let onPostCompleted: (() => void) | null = null
/**
 * Lo mismo para la consulta de consumidores (`hasActiveConsumers`), que es el
 * `await` que separa la toma del cerrojo de la revalidación. Sin una compuerta
 * acá, una revalidación colocada DENTRO del cerrojo pero ANTES de esta consulta
 * produce exactamente los mismos eventos (revisión de #155).
 */
let refcountGate: Promise<void> | null = null
let onRefcountStarted: (() => void) | null = null
let onRefcountCompleted: (() => void) | null = null

const pathFromUrl = (url: string) => decodeURIComponent(url.split('/').pop() as string)

vi.mock('axios', () => {
  const instance = {
    post: async (url: string) => {
      if (url.startsWith('/v3/config/paths/add/')) {
        onPostStarted?.()
        if (postGate) await postGate
        const p = pathFromUrl(url)
        calls.push(`POST ${p}`)
        mediamtxPaths.add(p)
        onPostCompleted?.()
        return { status: 200, data: {} }
      }
      return { status: 200, data: {} }
    },
    delete: async (url: string) => {
      if (deleteGate) await deleteGate
      const p = pathFromUrl(url)
      calls.push(`DELETE ${p}`)
      mediamtxPaths.delete(p)
      return { status: 200, data: {} }
    },
    get: async () => ({ status: 200, data: { items: [] } }),
    patch: async () => ({ status: 200, data: {} }),
  }
  return { default: { create: () => instance }, create: () => instance }
})

vi.mock('./stream-consumer-registry', () => ({
  getStreamConsumerRegistry: () => ({
    count: async () => {
      onRefcountStarted?.()
      if (refcountGate) await refcountGate
      onRefcountCompleted?.()
      return 0
    },
    acquire: async () => {},
    release: async () => {},
  }),
}))

vi.mock('./hikvision', () => ({
  buildRtspUrl: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/Streaming/Channels/101',
}))

vi.mock('./transcode-profile', () => ({
  resolveGridProfile: () => ({ name: 'test', width: 1280, fps: 15, bitrate: '1500k' }),
  buildTranscodeArgs: () => ['-i', 'rtsp://x'],
}))

vi.mock('child_process', () => ({
  execSync: () => Buffer.from(''),
  spawn: () => ({ pid: 1, once: () => {}, on: () => {}, stderr: { on: () => {} }, kill: () => {} }),
}))

const {
  publishTranscodedStream, removeTranscodedPath, clearRegisteredPath, getTranscodedStreamPath,
  publishStream, removeStream, getStreamPath,
} = await import('./stream')

const nvr: any = {
  id: 'nvrX', name: 'NVR', username: 'u', password: 'x',
  ipAddress: '10.0.0.1', rtspPort: 554,
}
const camera: any = { id: 'camX', channel: 9, name: 'cam' }
const PATH = getTranscodedStreamPath(nvr, camera)
const SUB  = getStreamPath(nvr, camera, 'sub')

const tick = () => new Promise(r => setImmediate(r))

beforeEach(() => {
  mediamtxPaths.clear()
  calls.length = 0
  deleteGate = null
  postGate = null
  onPostStarted = null
  onPostCompleted = null
  refcountGate = null
  onRefcountStarted = null
  onRefcountCompleted = null
  // Ambas cachés de registro: sin limpiarlas, un alta posterior se saltaría el
  // POST por fingerprint y el test mediría otra cosa.
  clearRegisteredPath(PATH)
  clearRegisteredPath(SUB)
})

// ─── Auditoría de los callbacks constantes (A1.8, punto 7) ───────────────────
//
// Un `() => true` / `() => false` es legítimo cuando el caso comprueba una
// DECISIÓN, y engañoso cuando pretende comprobar un MOMENTO: con un veredicto
// fijo, la aserción sale igual se evalúe donde se evalúe. Clasificación de los
// tres que quedan en este archivo:
//
//   A · `() => true`  — guarda legítima. Neutraliza la revalidación A PROPÓSITO
//                       para que lo único que pueda salvar el path sea el
//                       cerrojo, que es lo que el caso mide.
//   B · `() => true`  — guarda legítima. Borrado normal, sin solapamiento.
//   C · `() => false` — guarda legítima. Mide la DECISIÓN (un path readoptado
//                       no se borra); no afirma nada sobre cuándo se consulta.
//
// Los casos F y G sí afirmaban un momento y por eso se reescribieron con estado
// mutable y registro de eventos.

describe('altas y bajas del mismo path no pueden solaparse', () => {
  it('(A) el DELETE en vuelo no retira una publicación posterior', async () => {
    // Estado inicial: el path está publicado.
    await publishTranscodedStream(nvr, camera)
    expect(mediamtxPaths.has(PATH)).toBe(true)

    // La revalidación autoriza el borrado y el DELETE queda pendiente.
    let abrirDelete!: () => void
    deleteGate = new Promise<void>(r => { abrirDelete = r })
    const borrando = removeTranscodedPath(PATH, () => true)
    for (let i = 0; i < 10; i++) await tick()

    // Un arranque nuevo publica el MISMO path mientras el DELETE está en vuelo.
    const publicando = publishTranscodedStream(nvr, camera)
    for (let i = 0; i < 10; i++) await tick()

    abrirDelete()
    await Promise.all([borrando, publicando])

    // La ruta del arranque nuevo tiene que sobrevivir.
    expect(mediamtxPaths.has(PATH)).toBe(true)
  })

  it('(B) sin solapamiento, el borrado sigue retirando la ruta', async () => {
    await publishTranscodedStream(nvr, camera)
    const retirado = await removeTranscodedPath(PATH, () => true)

    expect(retirado).toBe(true)
    expect(mediamtxPaths.has(PATH)).toBe(false)
  })

  it('(C) la revalidación sigue impidiendo el borrado de un path readoptado', async () => {
    await publishTranscodedStream(nvr, camera)
    const retirado = await removeTranscodedPath(PATH, () => false)

    expect(retirado).toBe(false)
    expect(mediamtxPaths.has(PATH)).toBe(true)
    expect(calls.filter(c => c.startsWith('DELETE')).length).toBe(0)
  })
})

// ─── Los paths `sub`/`main` corren el mismo riesgo (revisión de #154) ────────
//
// `publishStream` y `removeStream` no participaban del cerrojo, y `removeStream`
// espera a `hasActiveConsumers` antes de borrar: en esa ventana un arranque
// nuevo podía publicar el path y quedarse sin él. Además, la caché de registro
// permitía que el alta retornara sin emitir un POST propio, de modo que nadie
// reparaba la ruta.
describe('altas y bajas de paths sub/main tampoco se solapan', () => {
  it('(D) el DELETE de removeStream no retira una publicación posterior', async () => {
    await publishStream(nvr, camera, 'sub')
    expect(mediamtxPaths.has(SUB)).toBe(true)

    let abrirDelete!: () => void
    deleteGate = new Promise<void>(r => { abrirDelete = r })
    const borrando = removeStream(nvr, camera, 'sub')
    for (let i = 0; i < 10; i++) await tick()

    // Un viewer nuevo adopta el mismo path mientras el DELETE está en vuelo.
    const publicando = publishStream(nvr, camera, 'sub')
    for (let i = 0; i < 10; i++) await tick()

    abrirDelete()
    await Promise.all([borrando, publicando])

    expect(mediamtxPaths.has(SUB)).toBe(true)
  })

  it('(E) sin solapamiento, removeStream sigue retirando el path', async () => {
    await publishStream(nvr, camera, 'sub')
    await removeStream(nvr, camera, 'sub')

    expect(mediamtxPaths.has(SUB)).toBe(false)
  })
})

// ─── El DELETE que queda DETRÁS del alta ─────────────────────────────────────
//
// El cerrojo ORDENA, pero no DECIDE: si `publishStream` lo toma primero, el
// DELETE se ejecuta después del alta y `hasActiveConsumers` puede seguir
// devolviendo cero, porque sólo cuenta consumidores externos y no ve al viewer
// de live que acaba de adoptar el path. Por eso la baja necesita su propia
// revalidación bajo el cerrojo.
//
// Estos casos comprueban el MOMENTO en el que se consulta esa revalidación, no
// sólo su veredicto. Dos correcciones sucesivas los trajeron hasta acá:
//
//   · La primera versión pasaba un callback CONSTANTE (`() => false`), así que
//     daba verde se evaluara donde se evaluara (revisión de #154, r3775323456).
//   · La segunda demostraba "después del POST", pero no "después de
//     `hasActiveConsumers`": una revalidación colocada dentro del cerrojo y
//     antes de esa consulta producía los mismos eventos, y usaría un veredicto
//     obsoleto si el dueño aparece mientras la consulta está pendiente
//     (revisión de #155, r3777041102).
//
// Ahora el veredicto depende de un estado que cambia en un punto elegido por
// cada caso, y las dos esperas del camino —el POST y el refcount— tienen su
// propia compuerta y quedan registradas en `events`.
describe('la baja se revalida DESPUÉS del alta y DESPUÉS del refcount', () => {
  /**
   * Monta la carrera con barreras explícitas, sin depender de una cantidad
   * arbitraria de `tick()`:
   *
   *   publishStream toma el cerrojo → el POST se detiene en su compuerta
   *   → removeStream se encola (el registro en la cola es síncrono)
   *   → se fotografía que la revalidación todavía no corrió
   *   → se libera el POST → termina el alta
   *   → removeStream toma el cerrojo → consulta el refcount, que se detiene
   *   → se libera el refcount → recién ahí se revalida
   *
   * `momentoDelDueno` elige en qué instante aparece el propietario nuevo, que
   * es lo que distingue una revalidación bien ubicada de una prematura.
   */
  async function bajaDetrasDelAlta(opts: {
    momentoDelDueno: 'durante_el_post' | 'durante_el_refcount' | 'nunca'
  }) {
    const events: string[] = []
    let ownerRegistered = false

    let marcarPostIniciado!: () => void
    const postIniciado = new Promise<void>(r => { marcarPostIniciado = r })
    let marcarRefcountIniciado!: () => void
    const refcountIniciado = new Promise<void>(r => { marcarRefcountIniciado = r })

    let abrirPost!: () => void
    postGate = new Promise<void>(r => { abrirPost = r })
    let abrirRefcount!: () => void
    refcountGate = new Promise<void>(r => { abrirRefcount = r })

    onPostStarted = () => { events.push('post_started'); marcarPostIniciado() }
    onPostCompleted = () => {
      if (opts.momentoDelDueno === 'durante_el_post') ownerRegistered = true
      events.push('post_completed')
    }
    onRefcountStarted = () => { events.push('refcount_started'); marcarRefcountIniciado() }
    onRefcountCompleted = () => { events.push('refcount_completed') }

    const stillUnowned = () => {
      events.push(`revalidate:${ownerRegistered}`)
      return !ownerRegistered
    }

    const publicando = publishStream(nvr, camera, 'sub')
    await postIniciado                       // barrera: el alta tiene el cerrojo

    // El encolado en `withPathLock` ocurre de forma síncrona al llamar, así que
    // en cuanto esta línea retorna la baja YA está detrás del alta en la cola.
    const borrando = removeStream(nvr, camera, 'sub', stillUnowned)

    // Foto del instante anterior a liberar el POST. Se devuelve en vez de
    // afirmarse acá: si la aserción fallara con las promesas todavía en vuelo,
    // las compuertas no se abrirían y el fallo llegaría como un timeout.
    const eventosAntesDeAbrir = [...events]

    abrirPost()
    // Barrera: la baja ya tiene el cerrojo y está consultando el refcount. Se
    // compite contra el fin de la baja para que un camino que NUNCA llegue a
    // consultarlo —una revalidación mal ubicada que retorna antes— falle por
    // sus aserciones y no por un timeout.
    await Promise.race([refcountIniciado, borrando])

    // Foto del instante en que la consulta de consumidores está PENDIENTE.
    const eventosDuranteElRefcount = [...events]
    if (opts.momentoDelDueno === 'durante_el_refcount') ownerRegistered = true

    abrirRefcount()
    await Promise.all([publicando, borrando])

    return { events, eventosAntesDeAbrir, eventosDuranteElRefcount }
  }

  /** Orden fijo del camino, sin contar la consulta de la revalidación. */
  const CAMINO = ['post_started', 'post_completed', 'refcount_started', 'refcount_completed']

  it('(F) con un dueño registrado durante el alta, la revalidación posterior veta el DELETE', async () => {
    const { events, eventosAntesDeAbrir, eventosDuranteElRefcount } =
      await bajaDetrasDelAlta({ momentoDelDueno: 'durante_el_post' })

    // Nada de la baja corrió mientras el alta tenía el cerrojo…
    expect(eventosAntesDeAbrir).toEqual(['post_started'])
    // …ni mientras la consulta de consumidores seguía pendiente.
    expect(eventosDuranteElRefcount).toEqual(['post_started', 'post_completed', 'refcount_started'])

    expect(events).toEqual([...CAMINO, 'revalidate:true'])
    expect(events.indexOf('post_completed')).toBeLessThan(events.indexOf('revalidate:true'))
    expect(events.indexOf('refcount_completed')).toBeLessThan(events.indexOf('revalidate:true'))
    expect(events).not.toContain('revalidate:false')
    expect(events.filter(e => e.startsWith('revalidate:'))).toHaveLength(1)

    expect(calls.filter(c => c === `DELETE ${SUB}`)).toHaveLength(0)
    expect(mediamtxPaths.has(SUB)).toBe(true)
  })

  it('(H) un dueño que aparece MIENTRAS se consulta el refcount también veta el DELETE', async () => {
    // Éste es el caso que distingue una revalidación bien ubicada de una que
    // corre dentro del cerrojo pero antes de la consulta asíncrona: en ese
    // momento el dueño todavía no existía.
    const { events, eventosDuranteElRefcount } =
      await bajaDetrasDelAlta({ momentoDelDueno: 'durante_el_refcount' })

    expect(eventosDuranteElRefcount).toEqual(['post_started', 'post_completed', 'refcount_started'])
    expect(events).toEqual([...CAMINO, 'revalidate:true'])
    expect(events).not.toContain('revalidate:false')

    expect(calls.filter(c => c === `DELETE ${SUB}`)).toHaveLength(0)
    expect(mediamtxPaths.has(SUB)).toBe(true)
  })

  it('(G) sin dueño nuevo, esa misma revalidación posterior autoriza el DELETE', async () => {
    const { events, eventosAntesDeAbrir } =
      await bajaDetrasDelAlta({ momentoDelDueno: 'nunca' })

    expect(eventosAntesDeAbrir).toEqual(['post_started'])
    expect(events).toEqual([...CAMINO, 'revalidate:false'])
    expect(events.indexOf('refcount_completed')).toBeLessThan(events.indexOf('revalidate:false'))
    expect(events).not.toContain('revalidate:true')
    expect(events.filter(e => e.startsWith('revalidate:'))).toHaveLength(1)

    expect(calls.filter(c => c === `DELETE ${SUB}`)).toHaveLength(1)
    expect(mediamtxPaths.has(SUB)).toBe(false)
  })
})
