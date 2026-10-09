// Persistencia del store de auth en localStorage ('visioncore-auth').
//
// Defecto que blinda: el store persistía el objeto ENTERO de /auth/me, que traía
// permissions[].nvr con usuario, clave cifrada, IP y puertos del NVR (y la IP/rtspUrl
// de la cámara). Aunque la API ya no los mande, los navegadores existentes los tienen
// guardados: la migración (version + migrate) debe borrarlos al hidratar, y partialize
// debe persistir sólo la allowlist que la UI necesita para el primer render.
//
// Se usa el store REAL con un localStorage en memoria (el entorno de test es node).
// Datos 100% ficticios: IPs TEST-NET (RFC 5737), credenciales inventadas.
import { describe, it, expect, afterEach, vi } from 'vitest'

const KEY = 'visioncore-auth'
const NVR_USER = 'nvr-fixture-svc'
const NVR_PASS_ENC = 'ENCv1-fixture-ciphertext-0000'
const NVR_IP = '192.0.2.10'
const CAM_IP = '198.51.100.20'
const SECRETS = [NVR_USER, NVR_PASS_ENC, NVR_IP, CAM_IP, 'FixturePass0', 'twoFactorSecret']

class MemoryStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
}

// Usuario tal como lo devolvía /auth/me ANTES del recorte en la API.
function legacyMeUser() {
  return {
    id: 'u-op', username: 'fixture-operator', fullName: 'Fixture Operator', email: 'op@example.test',
    role: 'OPERATOR', active: true, avatarUrl: null, phone: '+000 000', createdAt: '2026-01-01T00:00:00.000Z',
    twoFactorEnabled: true, forcePasswordChange: false, twoFactorSecret: 'FIXTURE',
    featurePermissions: { canViewLive: true, canViewRecordings: false, id: 'fp-1', userId: 'u-op' },
    permissions: [
      {
        id: 'p1', userId: 'u-op', nvrId: 'nvr-1', cameraId: null, canView: true,
        nvr: {
          id: 'nvr-1', name: 'NVR Fixture', ipAddress: NVR_IP, port: 80, rtspPort: 554, sdkPort: 8000,
          username: NVR_USER, password: NVR_PASS_ENC,
        },
        camera: null,
      },
      {
        id: 'p2', userId: 'u-op', nvrId: 'nvr-1', cameraId: 'cam-1', canView: true,
        nvr: { id: 'nvr-1', ipAddress: NVR_IP, username: NVR_USER, password: NVR_PASS_ENC },
        camera: {
          id: 'cam-1', name: 'Cam Fixture', channel: 1, ipAddress: CAM_IP, managementPort: 8000,
          rtspUrl: `rtsp://${NVR_USER}:FixturePass0@${NVR_IP}:554/Streaming/Channels/101`,
        },
      },
    ],
  }
}

async function loadStore(stored?: unknown) {
  vi.resetModules()
  const storage = new MemoryStorage()
  if (stored !== undefined) storage.setItem(KEY, JSON.stringify(stored))
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', new MemoryStorage())
  const { useAuthStore } = await import('./authStore')
  return { storage, useAuthStore }
}

function expectNoSecrets(raw: string | null) {
  expect(raw).not.toBeNull()
  for (const s of SECRETS) expect(raw).not.toContain(s)
  expect(raw).not.toContain('"permissions"')
  expect(raw).not.toContain('"password"')
  expect(raw).not.toContain('"ipAddress"')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('authStore · persistencia sin credenciales del NVR', () => {
  it('estado viejo (v0) con permissions→nvr.password ⇒ al hidratar se reescribe sin credenciales y conserva la sesión', async () => {
    const { storage, useAuthStore } = await loadStore({
      state: { user: legacyMeUser(), isAuthenticated: true },
      version: 0,
    })

    const raw = storage.getItem(KEY)
    expectNoSecrets(raw)
    const persisted = JSON.parse(raw!)
    expect(persisted.version).toBe(1)
    expect(persisted.state.isAuthenticated).toBe(true)
    expect(persisted.state.user).toEqual({
      id: 'u-op', username: 'fixture-operator', fullName: 'Fixture Operator', email: 'op@example.test',
      role: 'OPERATOR', avatarUrl: null, phone: '+000 000', twoFactorEnabled: true,
      featurePermissions: { canViewLive: true, canViewRecordings: false },
    })

    // En memoria tampoco queda nada de lo viejo.
    const st = useAuthStore.getState()
    expect(st.isAuthenticated).toBe(true)
    expect(st.user).not.toHaveProperty('permissions')
    expect(JSON.stringify(st.user)).not.toContain(NVR_PASS_ENC)
    // La UI sigue funcionando con lo persistido.
    expect(st.hasRole('OPERATOR')).toBe(true)
    expect(st.canFeature('canViewLive')).toBe(true)
  })

  it('aunque /auth/me (API vieja) devuelva campos de más, sólo se persiste la allowlist', async () => {
    const { storage, useAuthStore } = await loadStore()
    useAuthStore.setState({ user: legacyMeUser() as any, isAuthenticated: true })

    const raw = storage.getItem(KEY)
    expectNoSecrets(raw)
    expect(Object.keys(JSON.parse(raw!).state.user).sort()).toEqual([
      'avatarUrl', 'email', 'featurePermissions', 'fullName', 'id', 'phone', 'role', 'twoFactorEnabled', 'username',
    ])
  })

  it('estado persistido corrupto ⇒ sin usuario ni sesión (loadUser revalida contra la cookie)', async () => {
    const { storage, useAuthStore } = await loadStore({ state: { user: 'basura', isAuthenticated: true }, version: 0 })
    expect(useAuthStore.getState().user).toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(JSON.parse(storage.getItem(KEY)!).state).toEqual({ user: null, isAuthenticated: false })
  })
})
