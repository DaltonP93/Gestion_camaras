// A1 (post #160) · registro de identidades del heartbeat, separado del override.
import { describe, it, expect } from 'vitest'
import { registerHeartbeatIdentities } from './heartbeatIdentities'

describe('registerHeartbeatIdentities', () => {
  it('registra TODOS los leases de cada cámara por su tipo efectivo', () => {
    const reg: string[] = []
    registerHeartbeatIdentities({
      c1: { streamPath: '/c1_main_h264', transcoded: true, startAttemptIds: ['srv-A', 'sa-B'] },
      c2: { streamPath: '/c2_sub', startAttemptId: 'srv-C' },
    }, (cid, tipo, aid) => reg.push(`${cid}:${tipo}:${aid}`))
    expect(reg.sort()).toEqual(['c1:main_h264:sa-B', 'c1:main_h264:srv-A', 'c2:sub:srv-C'].sort())
  })

  it('prefiere `startAttemptIds` sobre el singular', () => {
    const reg: string[] = []
    registerHeartbeatIdentities(
      { c1: { streamPath: '/c1_sub', startAttemptId: 'x', startAttemptIds: ['a', 'b'] } },
      (_c, _t, aid) => reg.push(aid),
    )
    expect(reg.sort()).toEqual(['a', 'b'])
  })

  it('una cámara sin identidad no anota NADA (jamás fabrica ids)', () => {
    const reg: string[] = []
    registerHeartbeatIdentities({ c1: { streamPath: '/c1_sub' } }, (_c, _t, aid) => reg.push(aid))
    expect(reg).toEqual([])
  })

  it('el registro NO depende de ningún override: recibe sólo streams', () => {
    // Una cámara en fallback (que la página no pisaría visualmente) igual anota su
    // identidad: el helper no conoce el override, por construcción no lo salta.
    const reg: string[] = []
    registerHeartbeatIdentities(
      { enFallback: { transcoded: true, streamPath: '/enFallback_main_h264', startAttemptIds: ['srv-A', 'sa-B'] } },
      (cid, tipo, aid) => reg.push(`${cid}:${tipo}:${aid}`),
    )
    expect(reg.sort()).toEqual(['enFallback:main_h264:sa-B', 'enFallback:main_h264:srv-A'].sort())
  })
})
