// A1 (post #160) · el cierre de una sesión transcodificada termina su FFmpeg.
//
// Dos condiciones tienen que darse a la vez, y las dos fallaban en producción
// por motivos distintos:
//
//   · la razón del cierre tiene que estar en `TRANSCODE_KILL_REASONS`. El
//     frontend enviaba `viewport_changed` y el conjunto tiene `viewport_change`:
//     la sesión se borraba y el proceso quedaba corriendo sin espectador.
//   · no puede quedar otro espectador sobre el mismo `streamPath`.
//
// `decideStopTermination` es la decisión REAL que ejecuta `stopStream`; acá se
// la ejercita con el conjunto REAL de razones del stream-manager.
import { describe, it, expect } from 'vitest'
import { decideStopTermination } from './session-lifecycle'
import { TRANSCODE_KILL_REASONS } from './stream-manager'

const sesion = (over: Partial<any> = {}) => ({
  key: 'k1', userId: 'u1', viewId: 'v1', cameraId: 'c1',
  streamType: 'main_h264' as const, streamPath: '/c1_main_h264',
  lastClientHeartbeatMs: 0, generation: 1,
  ...over,
})

const decidir = (reason: string | undefined, surviving: any[] = []) =>
  decideStopTermination({
    streamType: 'main_h264',
    reason,
    killReasons: TRANSCODE_KILL_REASONS,
    expired: [sesion()],
    surviving,
  })

describe('(3) respuesta tardía main → main_h264: se cierra y se termina FFmpeg', () => {
  it('`stale_response` autoriza matar y, sin otro dueño, mata', () => {
    const d = decidir('stale_response')

    expect(d.shouldKill).toBe(true)
    expect(d.terminate).toEqual(['/c1_main_h264'])
  })

  it('`viewport_changed` —la cadena que enviaba el frontend— NO autorizaba nada', () => {
    // Se conserva como prueba de regresión: es exactamente la fuga. Si alguien
    // vuelve a escribir esa cadena en el frontend, el contrato la rechaza y
    // esto documenta por qué.
    const d = decidir('viewport_changed')

    expect(d.shouldKill).toBe(false)
    expect(d.terminate).toEqual([])
  })
})

describe('(4) cierre por transición con main_h264', () => {
  it('`viewport_change` termina el proceso', () => {
    expect(decidir('viewport_change').terminate).toEqual(['/c1_main_h264'])
  })

  it.each(['nvr_change', 'page_change', 'layout_change', 'stop_all', 'exit_focus'])(
    '«%s» también', (razon) => {
      expect(decidir(razon).terminate).toEqual(['/c1_main_h264'])
    },
  )

  it('sin razón declarada se mata: es el cierre por defecto', () => {
    expect(decidir(undefined).terminate).toEqual(['/c1_main_h264'])
  })
})

describe('un fallo transitorio conserva el proceso a propósito', () => {
  it.each(['hls_fatal_error', 'grid_retry', 'quality_switch'])('«%s»', (razon) => {
    const d = decidir(razon)
    expect(d.shouldKill).toBe(false)
    expect(d.terminate).toEqual([])
    // El refcount igual se calcula: el path no tiene otros dueños. Lo que
    // impide matarlo es la razón, no la falta de información.
    expect(d.processes.terminate).toEqual(['/c1_main_h264'])
  })
})

describe('(5) el refcount manda por encima de la autorización', () => {
  it('con otro espectador del MISMO path, no se mata aunque la razón lo permita', () => {
    const otro = sesion({ key: 'k2', viewId: 'v2' })
    const d = decidir('stale_response', [otro])

    expect(d.shouldKill).toBe(true)
    expect(d.terminate).toEqual([])
    expect(d.processes.keepAlive).toEqual([
      { streamPath: '/c1_main_h264', remainingViewers: 1 },
    ])
  })

  it('un `sub` de la misma cámara NO cuenta como dueño del proceso', () => {
    // Sub y main_h264 pueden convivir: el sub lo sirve MediaMTX y no tiene
    // FFmpeg propio, así que no puede mantener vivo el del transcodificado.
    const sub = sesion({ key: 'k3', streamType: 'sub', streamPath: '/c1_sub' })
    const d = decidir('stale_response', [sub])

    expect(d.terminate).toEqual(['/c1_main_h264'])
  })

  it('un `main` de la misma cámara tampoco', () => {
    const main = sesion({ key: 'k4', streamType: 'main', streamPath: '/c1_main' })

    expect(decidir('viewport_change', [main]).terminate).toEqual(['/c1_main_h264'])
  })
})
