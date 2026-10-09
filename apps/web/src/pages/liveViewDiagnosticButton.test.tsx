// LiveView · el botón "Diagnóstico" sólo se muestra a ADMIN y SUPERVISOR.
//
// Defecto que blinda: LiveViewPage le pasaba `onDiagnostic` a TODOS los roles, y
// GET /api/cameras/:id/diagnostics (que dispara sondas RTSP activas) ahora sólo
// admite ADMIN/SUPERVISOR. OPERATOR/AUDITOR veían un botón que devuelve 403.
//
// Se renderiza la página REAL con react-dom/server (el entorno de test es node, sin
// DOM): sin efectos ni red, alcanza para ver qué botones salen en el primer render.
// VideoPlayer dibuja el botón del overlay (title "Diagnóstico de stream") siempre que
// recibe `onDiagnostic`, así que su presencia en el HTML es exactamente "lo ve o no".
//
// Los stores se reemplazan por su estado fijo: en el servidor zustand lee el estado
// INICIAL (sin usuario ni cámaras) vía getServerSnapshot, y no hay forma pública de
// sembrarlo. La página, VideoPlayer y la regla de rol son los reales.
// Datos 100% ficticios: IPs TEST-NET (RFC 5737), sin credenciales.
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Camera, Role, User } from '@/types'
import { LiveViewPage } from './LiveViewPage'

const fixture = vi.hoisted(() => ({
  auth: { user: null as unknown, isAuthenticated: true },
  cams: { nvrs: [] as unknown[], cameras: [] as unknown[], loadNVRs: async () => {}, loadCameras: async () => {} },
}))

vi.mock('@/stores/authStore', () => {
  const read = (sel?: (s: typeof fixture.auth) => unknown) => (sel ? sel(fixture.auth) : fixture.auth)
  return { useAuthStore: Object.assign(read, { getState: () => fixture.auth, subscribe: () => () => {} }) }
})
vi.mock('@/stores/cameraStore', () => {
  const read = (sel?: (s: typeof fixture.cams) => unknown) => (sel ? sel(fixture.cams) : fixture.cams)
  return { useCameraStore: Object.assign(read, { getState: () => fixture.cams, subscribe: () => () => {} }) }
})

const liveViewSource = (import.meta.glob('./LiveViewPage.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>)['./LiveViewPage.tsx']

const DIAG_BUTTON = 'title="Diagnóstico de stream"'
const count = (html: string, needle: string) => html.split(needle).length - 1

function fixtureCamera(id: string, channel: number): Camera {
  return {
    id, nvrId: 'nvr-1', channel, name: `Cam ${channel}`, ptzEnabled: false, active: true, online: true,
    streamHealthStatus: 'HEALTHY', nvr: { id: 'nvr-1', name: 'NVR Fixture', ipAddress: '192.0.2.10' },
  }
}

function renderLiveViewAs(role: Role): string {
  fixture.auth.user = { id: `u-${role}`, username: `fixture-${role.toLowerCase()}`, fullName: 'Fixture', email: 'f@example.test', role } as User
  fixture.cams.cameras = [fixtureCamera('cam-1', 1), fixtureCamera('cam-2', 2)]
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LiveViewPage)))
}

describe('LiveView · botón Diagnóstico según rol (la API da 403 a OPERATOR/AUDITOR)', () => {
  it.each(['OPERATOR', 'AUDITOR'] as Role[])('%s: ninguna celda muestra el botón Diagnóstico', (role) => {
    const html = renderLiveViewAs(role)
    // La grilla sí se renderizó: las dos celdas, con su overlay de controles.
    expect(count(html, 'NVR Fixture · Cam ')).toBe(2)
    expect(count(html, 'title="Pantalla completa"')).toBe(2)
    expect(count(html, DIAG_BUTTON)).toBe(0)
    expect(count(html, 'Diagnóstico')).toBe(0)
  })

  it.each(['ADMIN', 'SUPERVISOR'] as Role[])('%s: cada celda muestra el botón Diagnóstico', (role) => {
    const html = renderLiveViewAs(role)
    expect(count(html, 'NVR Fixture · Cam ')).toBe(2)
    expect(count(html, DIAG_BUTTON)).toBe(2)
  })

  // La vista en foco (1×1) se abre desde efectos/handlers, que el render de servidor
  // no ejecuta. Guarda estructural: TODA prop onDiagnostic de la página pasa por la
  // regla de rol; una celda nueva o la de foco no pueden volver a pasarlo a cualquiera.
  it('toda prop onDiagnostic de LiveViewPage (grilla y foco) pasa por la regla de rol', () => {
    const props = liveViewSource.match(/onDiagnostic=\{[^}]*\}/g) ?? []
    expect(props.length).toBeGreaterThanOrEqual(2)
    for (const p of props) expect(p).toBe('onDiagnostic={canDiagnose ? handleDiagnostic : undefined}')
    expect(liveViewSource).toContain('const canDiagnose = canRunCameraDiagnostics(user?.role)')
  })
})
