// A1 (post #160, 3ª vuelta) · el intento de arranque sobrevive al reintento
// por 401.
//
// El `startAttemptId` identifica una OPERACIÓN LÓGICA, no una petición HTTP. Si
// el interceptor renueva el JWT y reenvía, la sesión que el backend cree en ese
// segundo envío tiene que quedar a nombre del MISMO intento: si cambiara, el
// cierre por respuesta tardía declararía un identificador que ya no es el de la
// sesión y el backend lo rechazaría — la sesión huérfana viviría hasta el TTL.
//
// Acá se ejecuta el interceptor REAL de `lib/api.ts` con un adaptador que
// responde 401 la primera vez, y se observa el cuerpo que sale en cada envío.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { newStartAttemptId, isValidStartAttemptId } from './startAttempt'

vi.mock('react-hot-toast', () => ({ default: { error: () => {}, success: () => {} } }))

/** Almacenamiento y `window` mínimos: el entorno de pruebas es node. */
function makeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size },
  } as Storage
}
;(globalThis as any).localStorage = makeStorage()
;(globalThis as any).sessionStorage = makeStorage()
;(globalThis as any).window = {
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
}

const axios = (await import('axios')).default
const { api, apiPost } = await import('./api')

/** Cuerpos que SALIERON hacia el endpoint de arranque, en orden. */
let enviados: any[] = []
let primeraVez = true

beforeEach(() => {
  enviados = []
  primeraVez = true
  localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('accessToken', 'viejo')
  localStorage.setItem('refreshToken', 'r1')

  // Adaptador del cliente de la app: 401 la primera vez, 200 la segunda.
  api.defaults.adapter = async (config: any) => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
    enviados.push({ body, auth: config.headers?.Authorization })
    if (primeraVez) {
      primeraVez = false
      const err: any = new Error('401')
      err.config = config
      err.response = { status: 401, data: {}, headers: {}, config }
      err.isAxiosError = true
      throw err
    }
    return {
      status: 200, statusText: 'OK', headers: {}, config,
      data: { cameraId: 'c1', streamPath: '/c1_main_h264', streamType: 'main_h264',
              startAttemptId: body?.startAttemptId },
    }
  }

  // El refresh usa la instancia GLOBAL de axios, no la de la app.
  axios.defaults.adapter = async (config: any) => ({
    status: 200, statusText: 'OK', headers: {}, config,
    data: { accessToken: 'nuevo', refreshToken: 'r2' },
  })
})

describe('reintento por 401', () => {
  it('el segundo envío lleva el MISMO startAttemptId', async () => {
    const startAttemptId = newStartAttemptId()

    const res = await apiPost<any>('/cameras/c1/start-stream', {
      streamType: 'main', viewId: 'v1', startAttemptId,
    })

    expect(enviados).toHaveLength(2)                       // hubo reintento
    expect(enviados[0].body.startAttemptId).toBe(startAttemptId)
    expect(enviados[1].body.startAttemptId).toBe(startAttemptId)
    // Y la sesión quedó a nombre de ese intento.
    expect(res.startAttemptId).toBe(startAttemptId)
  })

  it('lo que SÍ cambia entre los dos envíos es el token', async () => {
    await apiPost('/cameras/c1/start-stream', {
      streamType: 'main', viewId: 'v1', startAttemptId: newStartAttemptId(),
    })

    expect(enviados[0].auth).toBe('Bearer viejo')
    expect(enviados[1].auth).toBe('Bearer nuevo')
  })

  it('sin 401 hay un solo envío, con su intento', async () => {
    primeraVez = false
    const startAttemptId = newStartAttemptId()

    await apiPost('/cameras/c1/start-stream', { viewId: 'v1', startAttemptId })

    expect(enviados).toHaveLength(1)
    expect(enviados[0].body.startAttemptId).toBe(startAttemptId)
  })
})

describe('forma del identificador', () => {
  it('cada llamada devuelve uno distinto', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newStartAttemptId()))
    expect(ids.size).toBe(200)
  })

  it('pasa la validación que aplica el API', () => {
    for (let i = 0; i < 20; i++) expect(isValidStartAttemptId(newStartAttemptId())).toBe(true)
  })

  it('rechaza lo que no puede viajar en una query o crecería sin límite', () => {
    expect(isValidStartAttemptId('con espacio')).toBe(false)
    expect(isValidStartAttemptId('con/barra')).toBe(false)
    expect(isValidStartAttemptId('')).toBe(false)
    expect(isValidStartAttemptId('x'.repeat(129))).toBe(false)
    expect(isValidStartAttemptId(42)).toBe(false)
    expect(isValidStartAttemptId(undefined)).toBe(false)
  })
})
