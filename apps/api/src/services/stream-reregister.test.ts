// apps/api/src/services/stream-reregister.test.ts
//
// Robustez (#7): el re-registro de streams al arranque debe AISLAR el fallo por
// cámara — una cámara que falla no aborta el resto del lote.
import { describe, it, expect, vi } from 'vitest'
import { reRegisterStreams, type ReRegisterNvr } from './stream-reregister'

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function nvr(id: string, cams: string[], password = 'enc'): ReRegisterNvr {
  return { id, name: `nvr-${id}`, password, cameras: cams.map((c) => ({ id: c })) }
}

describe('reRegisterStreams — aislamiento por cámara (#7)', () => {
  it('una cámara que falla no aborta el resto del lote', async () => {
    const log = silentLog()
    const seen: string[] = []
    const publishStream = vi.fn(async (_nvr: unknown, camera: { id: string }) => {
      seen.push(camera.id)
      if (camera.id === 'c2') throw new Error('boom c2')
      return true
    })

    const res = await reRegisterStreams(
      [nvr('n1', ['c1', 'c2', 'c3'])],
      { decryptPass: () => 'plain', publishStream, log },
    )

    // Todas las cámaras se intentaron pese al fallo de c2.
    expect(seen).toEqual(['c1', 'c2', 'c3'])
    expect(res).toEqual({ count: 2, skipped: 0, publishFailed: 1 })
    expect(log.warn).toHaveBeenCalledTimes(1)
    // El log del fallo puntual NO incluye credenciales ni IP en claro.
    const warnMsg = String(log.warn.mock.calls[0][0])
    expect(warnMsg).toContain('c2')
    expect(warnMsg).not.toContain('plain')
  })

  it('un fallo puntual no impide re-registrar cámaras de otros NVR', async () => {
    const log = silentLog()
    const publishStream = vi.fn(async (_nvr: unknown, camera: { id: string }) => {
      if (camera.id === 'a1') throw new Error('fail a1')
      return true
    })
    const res = await reRegisterStreams(
      [nvr('nA', ['a1']), nvr('nB', ['b1', 'b2'])],
      { decryptPass: () => 'plain', publishStream, log },
    )
    expect(res).toEqual({ count: 2, skipped: 0, publishFailed: 1 })
  })

  it('NVR con decrypt null → skipped y el resto continúa', async () => {
    const log = silentLog()
    const publishStream = vi.fn(async () => true)
    const nvrs: ReRegisterNvr[] = [nvr('bad', ['x1'], 'nope'), nvr('ok', ['y1', 'y2'], 'enc')]
    const res = await reRegisterStreams(nvrs, {
      decryptPass: (enc) => (enc === 'nope' ? null : 'plain'),
      publishStream,
      log,
    })
    expect(res).toEqual({ count: 2, skipped: 1, publishFailed: 0 })
    expect(log.error).toHaveBeenCalledTimes(1)   // DECRYPT_ERROR del NVR malo
    expect(publishStream).toHaveBeenCalledTimes(2) // sólo las de 'ok'
  })
})
