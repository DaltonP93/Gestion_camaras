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

const pathFromUrl = (url: string) => decodeURIComponent(url.split('/').pop() as string)

vi.mock('axios', () => {
  const instance = {
    post: async (url: string) => {
      if (url.startsWith('/v3/config/paths/add/')) {
        if (postGate) await postGate
        const p = pathFromUrl(url)
        calls.push(`POST ${p}`)
        mediamtxPaths.add(p)
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
    count: async () => 0,
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
  // Ambas cachés de registro: sin limpiarlas, un alta posterior se saltaría el
  // POST por fingerprint y el test mediría otra cosa.
  clearRegisteredPath(PATH)
  clearRegisteredPath(SUB)
})

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

// ─── El DELETE que queda DETRÁS del alta (revisión de #154) ──────────────────
//
// El cerrojo ordena, pero no decide: si `publishStream` lo toma primero, el
// DELETE se ejecuta después del alta y `hasActiveConsumers` puede seguir
// devolviendo cero, porque sólo cuenta consumidores externos y no ve al viewer
// de live que acaba de adoptar el path. Por eso la baja necesita su propia
// revalidación bajo el cerrojo.
describe('la baja se revalida cuando el alta se le adelanta', () => {
  it('(F) un DELETE encolado detrás de un alta no retira el path readoptado', async () => {
    let abrirPost!: () => void
    postGate = new Promise<void>(r => { abrirPost = r })

    const publicando = publishStream(nvr, camera, 'sub')   // toma el cerrojo
    for (let i = 0; i < 10; i++) await tick()

    // La baja se encola DETRÁS del alta. Su revalidación dirá que el path ya
    // tiene dueño (el viewer que acaba de adoptarlo).
    const borrando = removeStream(nvr, camera, 'sub', () => false)
    for (let i = 0; i < 10; i++) await tick()

    abrirPost()
    await Promise.all([publicando, borrando])

    expect(mediamtxPaths.has(SUB)).toBe(true)
    expect(calls.filter(c => c === `DELETE ${SUB}`)).toHaveLength(0)
  })

  it('(G) sin dueño nuevo, ese mismo DELETE encolado sí retira el path', async () => {
    let abrirPost!: () => void
    postGate = new Promise<void>(r => { abrirPost = r })

    const publicando = publishStream(nvr, camera, 'sub')
    for (let i = 0; i < 10; i++) await tick()
    const borrando = removeStream(nvr, camera, 'sub', () => true)
    for (let i = 0; i < 10; i++) await tick()

    abrirPost()
    await Promise.all([publicando, borrando])

    expect(mediamtxPaths.has(SUB)).toBe(false)
  })
})
