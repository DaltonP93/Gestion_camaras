import { describe, it, expect } from 'vitest'
import { canRunCameraDiagnostics } from './diagnosticsAccess'

// El botón "Diagnóstico" de LiveView se muestra según esta función; la API
// (GET /api/cameras/:id/diagnostics) responde 403 a cualquier otro rol. Que la
// página efectivamente la aplique lo prueba pages/liveViewDiagnosticButton.test.tsx.
describe('canRunCameraDiagnostics — mismo criterio que la API', () => {
  it('ADMIN y SUPERVISOR pueden disparar el diagnóstico (sondas RTSP activas)', () => {
    expect(canRunCameraDiagnostics('ADMIN')).toBe(true)
    expect(canRunCameraDiagnostics('SUPERVISOR')).toBe(true)
  })

  it('OPERATOR, AUDITOR y sin sesión NO ven el botón (la API les da 403)', () => {
    expect(canRunCameraDiagnostics('OPERATOR')).toBe(false)
    expect(canRunCameraDiagnostics('AUDITOR')).toBe(false)
    expect(canRunCameraDiagnostics(undefined)).toBe(false)
    expect(canRunCameraDiagnostics(null)).toBe(false)
  })
})
