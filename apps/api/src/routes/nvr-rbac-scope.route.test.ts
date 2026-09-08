// RBAC por recurso en rutas de NVR — política centralizada (services/access-policy.ts).
//
// Cubre la semántica NVR-scoped vs camera-scoped aplicada vía fastify.inject con un
// prisma falso que RESPETA el filtro real (canView, cameraId=null para NVR-scoped,
// camera:{nvrId,channel} para camera-scoped). Casos:
//   - sin permiso / canView=false / otra cámara / otro NVR ⇒ 403
//   - permiso camera-scoped ⇒ SOLO datos de esa cámara (no las demás del NVR)
//   - permiso NVR-scoped ⇒ alcance completo del NVR
//   - ADMIN/SUPERVISOR ⇒ acceso total (contrato vigente, sin ampliar privilegios)
//
// MUTACIÓN: si se borra el chequeo de acceso en /video-audio o se relaja el
// predicate (p.ej. quitar canView, o ignorar el scope de cámara), los casos
// negativos y el de "solo esa cámara" fallan. El prisma falso modela el filtro,
// de modo que debilitarlo deja pasar filas que hoy no matchean.
//
// IPs/ids/credenciales 100% ficticios. No se toca red: hikvision y credentials
// están mockeados para aislar el comportamiento de autorización.

import { describe, it, expect, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../services/credentials', () => ({
  encryptNvrPassword: (p: string) => p,
  decryptNvrPassword: () => 'plain',
  decryptNvrPasswordOrNull: () => 'plain',
  isMaskedPassword: () => false,
}))

vi.mock('../services/hikvision', async (orig) => {
  const actual = (await orig()) as any
  return {
    ...actual,
    // Devuelve un config marcador por canal para poder afirmar qué canales se leyeron.
    fetchChannelVideoConfig: vi.fn(async (_nvr: any, ch: number) => ({ channel: ch, main: null, sub: null, fetchedAt: 't' })),
    // Enumeración ISAPI del dispositivo completo: nvr-1 → 3 canales, nvr-2 → 1.
    // Permite verificar que un camera-scoped NO enumera todas las cámaras del NVR.
    getIpCameraList: vi.fn(async (nvr: any) => {
      const chans = nvr?.id === 'nvr-1' ? [1, 2, 3] : nvr?.id === 'nvr-2' ? [1] : []
      return chans.map((ch) => ({ channel: ch, channelCode: `D${ch}`, name: `ch${ch}`, ipAddress: '', protocol: '', managementPort: 80, securityStatus: '', status: 'online' }))
    }),
  }
})

import { nvrRoutes } from './nvr'

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'
interface Perm { userId: string; nvrId: string | null; cameraId: string | null; canView: boolean }

// Cámaras del set: nvr-1 tiene 3 canales; nvr-2 tiene 1.
const cameras: Record<string, { id: string; nvrId: string; channel: number; name: string; channelCode: string }> = {
  'cam-a': { id: 'cam-a', nvrId: 'nvr-1', channel: 1, name: 'A', channelCode: 'D1' },
  'cam-b': { id: 'cam-b', nvrId: 'nvr-1', channel: 2, name: 'B', channelCode: 'D2' },
  'cam-c': { id: 'cam-c', nvrId: 'nvr-1', channel: 3, name: 'C', channelCode: 'D3' },
  'cam-x': { id: 'cam-x', nvrId: 'nvr-2', channel: 1, name: 'X', channelCode: 'D1' },
}
// Campos NVR-wide sensibles (IP/usuario/puerto/serial/firmware/errores) presentes
// a propósito, para verificar campo por campo que NO se filtran a un camera-scoped.
const nvrsById: Record<string, any> = {
  'nvr-1': { id: 'nvr-1', name: 'NVR Uno', ipAddress: '10.0.0.9', port: 80, username: 'svc', password: 'enc', serialNumber: 'SN-111', firmware: 'V5.7', recordingProvider: 'ISAPI', lastError: 'x' },
  'nvr-2': { id: 'nvr-2', name: 'NVR Dos', ipAddress: '10.0.0.10', port: 80, username: 'svc', password: 'enc', serialNumber: 'SN-222', firmware: 'V5.7', recordingProvider: 'ISAPI', lastError: 'y' },
}
const hddsOf = (_nvrId: string) => [{ id: 'hdd1', diskNumber: 1, capacity: '4TB' }]
const camsOf = (nvrId: string) => Object.values(cameras).filter((c) => c.nvrId === nvrId)

function makePrisma(perms: Perm[]) {
  return {
    nVR: {
      findUnique: async ({ where, include }: any) => {
        const base = nvrsById[where.id]
        if (!base) return null
        // Honrar `include` como Prisma: /:id pide { cameras, hdds }.
        return include
          ? { ...base, ...(include.cameras ? { cameras: camsOf(where.id) } : {}), ...(include.hdds ? { hdds: [] } : {}) }
          : base
      },
      findMany: async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? Object.keys(nvrsById)
        return ids.filter((id) => nvrsById[id]).map((id) => ({ ...nvrsById[id], cameras: camsOf(id), hdds: hddsOf(id) }))
      },
      update: async ({ where, data }: any) => ({ ...(nvrsById[where.id] ?? {}), ...data }),
    },
    camera: {
      findMany: async ({ where }: any) => camsOf(where.nvrId),
    },
    userPermission: {
      findFirst: async ({ where }: any) => {
        const wantView = where.canView === true
        const rows = perms.filter((p) => p.userId === where.userId && (!wantView || p.canView === true))
        // 1) userCanAccessNvr: OR:[{nvrId},{camera:{nvrId}}]
        if (where.OR) {
          const nvrId = where.OR.find((c: any) => c.nvrId)?.nvrId
          const ok = rows.some((p) => p.nvrId === nvrId || (p.cameraId && cameras[p.cameraId]?.nvrId === nvrId))
          return ok ? { id: 'perm' } : null
        }
        // 2) NVR-scoped: nvrId + cameraId=null
        if (where.cameraId === null && where.nvrId) {
          const ok = rows.some((p) => p.nvrId === where.nvrId && p.cameraId === null)
          return ok ? { id: 'perm' } : null
        }
        // 3) camera-scoped a un canal: camera:{nvrId,channel}
        if (where.camera) {
          const { nvrId, channel } = where.camera
          const ok = rows.some((p) => p.cameraId && cameras[p.cameraId]?.nvrId === nvrId && cameras[p.cameraId]?.channel === channel)
          return ok ? { id: 'perm' } : null
        }
        return null
      },
      findMany: async ({ where }: any) => {
        // getVisibleNvrMap: { userId, canView:true } → nvrId, cameraId, camera:{id,nvrId}
        const rows = perms.filter((p) => p.userId === where.userId && (where.canView !== true || p.canView === true))
        return rows.map((p) => ({
          nvrId: p.nvrId,
          cameraId: p.cameraId,
          camera: p.cameraId ? { id: p.cameraId, nvrId: cameras[p.cameraId]?.nvrId } : null,
        }))
      },
    },
    auditLog: { create: async () => ({}) },
  } as any
}

async function build(user: { sub: string; role: Role }, perms: Perm[]): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (_roles: Role[]) => async (req: any) => { req.user = user })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', makePrisma(perms))
  await app.register(nvrRoutes, { prefix: '/api/nvrs' })
  await app.ready()
  return app
}

const nvrScoped = (userId: string, nvrId: string, canView = true): Perm => ({ userId, nvrId, cameraId: null, canView })
const camScoped = (userId: string, cameraId: string, canView = true): Perm => ({ userId, nvrId: null, cameraId, canView })

// ── GET /api/nvrs (list): canView + filtrado de cámaras visibles ──────────────
describe('GET /api/nvrs — filtra por lo visible (canView + scope de cámara)', () => {
  it('no-priv con canView=false ⇒ no aparece el NVR', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1', false)])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(0)
    await app.close()
  })

  it('permiso NVR-scoped ⇒ ve el NVR con TODAS sus cámaras', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs' })
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe('nvr-1')
    expect(body[0].cameras.map((c: any) => c.id).sort()).toEqual(['cam-a', 'cam-b', 'cam-c'])
    await app.close()
  })

  it('permiso camera-scoped ⇒ ve el NVR pero SOLO esa cámara (no las demás)', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs' })
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe('nvr-1')
    expect(body[0].cameras.map((c: any) => c.id)).toEqual(['cam-b'])
    await app.close()
  })

  it('ADMIN ⇒ ve todos los NVRs con todas sus cámaras', async () => {
    const app = await build({ sub: 'adm1', role: 'ADMIN' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs' })
    const body = res.json()
    expect(body.map((n: any) => n.id).sort()).toEqual(['nvr-1', 'nvr-2'])
    await app.close()
  })

  // PROYECCIÓN MÍNIMA — campo por campo: un camera-scoped NO debe recibir NINGÚN
  // dato NVR-wide en el listado (antes se devolvía el objeto NVR completo).
  it('camera-scoped ⇒ proyección MÍNIMA (id+name+sus cámaras), sin datos NVR-wide', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs' })
    const body = res.json()
    expect(body).toHaveLength(1)
    const nvr = body[0]
    // Lo permitido: identidad + sólo su cámara.
    expect(Object.keys(nvr).sort()).toEqual(['cameras', 'id', 'name'])
    expect(nvr.id).toBe('nvr-1')
    expect(nvr.name).toBe('NVR Uno')
    expect(nvr.cameras.map((c: any) => c.id)).toEqual(['cam-b'])
    // Campo por campo: NINGÚN dato NVR-wide ni credencial.
    for (const f of ['ipAddress', 'username', 'password', 'port', 'serialNumber', 'firmware', 'recordingProvider', 'lastError', 'hdds']) {
      expect(nvr[f], `no debe exponerse '${f}' a un camera-scoped`).toBeUndefined()
    }
    await app.close()
  })

  it('NVR-scoped ⇒ contrato completo (incluye ipAddress y hdds; nunca password)', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs' })
    const nvr = res.json()[0]
    expect(nvr.ipAddress).toBe('10.0.0.9')
    expect(nvr.hdds).toHaveLength(1)
    expect(nvr.serialNumber).toBe('SN-111')
    expect(nvr.password).toBeUndefined() // password nunca se envía
    await app.close()
  })
})

// ── GET /api/nvrs/:id/video-audio (list de configs) ───────────────────────────
describe('GET /api/nvrs/:id/video-audio — scope por recurso (antes: bypass)', () => {
  it('sin permiso ⇒ 403', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('canView=false ⇒ 403', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1', false)])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('permiso sobre otro NVR ⇒ 403 en el NVR ajeno', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-2')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('camera-scoped ⇒ 200 con SOLO la config de esa cámara', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].cameraId).toBe('cam-b')
    await app.close()
  })

  it('NVR-scoped ⇒ 200 con las configs de TODAS las cámaras del NVR', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio' })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((r: any) => r.cameraId).sort()).toEqual(['cam-a', 'cam-b', 'cam-c'])
    await app.close()
  })
})

// ── GET /api/nvrs/:id/video-audio/:channel (config por canal) ─────────────────
describe('GET /api/nvrs/:id/video-audio/:channel — scope a nivel de canal', () => {
  it('camera-scoped a cam-b (canal 2): 200 en su canal', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio/2' })
    expect(res.statusCode).toBe(200)
    expect(res.json().channel).toBe(2)
    await app.close()
  })

  it('camera-scoped a cam-b NO puede leer el canal 3 (otra cámara) ⇒ 403', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio/3' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('NVR-scoped ⇒ 200 en cualquier canal del NVR', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio/3' })
    expect(res.statusCode).toBe(200)
    expect(res.json().channel).toBe(3)
    await app.close()
  })

  it('sin permiso ⇒ 403', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio/1' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('ADMIN ⇒ 200 (acceso total, contrato vigente)', async () => {
    const app = await build({ sub: 'adm1', role: 'ADMIN' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/video-audio/2' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

// ── FAIL-CLOSED: endpoints NVR-WIDE exigen NVR-scoped, NUNCA camera-scoped ──────
// Escenario del set: cam-a/cam-b/cam-c en nvr-1 (mismo NVR), cam-x en nvr-2 (otro).
// Un permiso camera-scoped (una sola cámara de nvr-1) NO puede leer recursos de
// todo el dispositivo: antes `userCanAccessNvr` los dejaba pasar (leak).
describe('GET /api/nvrs/:id — recurso NVR-wide (todas las cámaras + HDDs)', () => {
  it('camera-scoped a cam-b ⇒ 403 (no puede leer el NVR completo)', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
  it('NVR-scoped ⇒ 200 con todas las cámaras del NVR', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(200)
    expect(res.json().cameras.map((c: any) => c.id).sort()).toEqual(['cam-a', 'cam-b', 'cam-c'])
    await app.close()
  })
  it('ADMIN ⇒ 200', async () => {
    const app = await build({ sub: 'adm1', role: 'ADMIN' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('endpoints NVR-wide de dispositivo ⇒ fail-closed para camera-scoped', () => {
  // Sólo negativos: la guarda responde 403 ANTES de tocar red (getNVRStatus,
  // getDeviceInfo, HDDs, recording-capabilities), por eso no requieren mock de red.
  const wideEndpoints = ['/status', '/device-info', '/storage', '/recording-capabilities']
  for (const ep of wideEndpoints) {
    it(`GET /api/nvrs/nvr-1${ep} · camera-scoped (cam-b) ⇒ 403`, async () => {
      const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
      const res = await app.inject({ method: 'GET', url: `/api/nvrs/nvr-1${ep}` })
      expect(res.statusCode).toBe(403)
      await app.close()
    })
    it(`GET /api/nvrs/nvr-1${ep} · NVR-scoped de OTRO NVR (nvr-2) ⇒ 403`, async () => {
      const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-2')])
      const res = await app.inject({ method: 'GET', url: `/api/nvrs/nvr-1${ep}` })
      expect(res.statusCode).toBe(403)
      await app.close()
    })
  }
})

// ── GET /api/nvrs/:id/cameras — enumeración filtrada al scope del usuario ───────
describe('GET /api/nvrs/:id/cameras — un camera-scoped NO enumera todo el NVR', () => {
  it('camera-scoped a cam-b ⇒ SOLO cam-b en fromDb y SOLO su canal en fromNvr', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-b')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/cameras' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // dos cámaras del MISMO NVR (cam-a, cam-c) NO deben aparecer.
    expect(body.fromDb.map((c: any) => c.id)).toEqual(['cam-b'])
    expect(body.fromNvr.map((c: any) => c.channel)).toEqual([2]) // canal de cam-b
    await app.close()
  })
  it('camera-scoped sobre nvr-2 (otro NVR) ⇒ 403 en nvr-1', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [camScoped('op1', 'cam-x')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/cameras' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
  it('NVR-scoped ⇒ enumera TODAS las cámaras del NVR (fromDb y fromNvr)', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [nvrScoped('op1', 'nvr-1')])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/cameras' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.fromDb.map((c: any) => c.id).sort()).toEqual(['cam-a', 'cam-b', 'cam-c'])
    expect(body.fromNvr.map((c: any) => c.channel).sort()).toEqual([1, 2, 3])
    await app.close()
  })
  it('ADMIN ⇒ enumera todo', async () => {
    const app = await build({ sub: 'adm1', role: 'ADMIN' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1/cameras' })
    expect(res.statusCode).toBe(200)
    expect(res.json().fromNvr.map((c: any) => c.channel).sort()).toEqual([1, 2, 3])
    await app.close()
  })
})
