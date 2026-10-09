// src/lib/diagnosticsAccess.ts
// Quién puede abrir el diagnóstico de cámara. Espejo del preHandler de
// GET /api/cameras/:id/diagnostics (authorize ADMIN/SUPERVISOR): el diagnóstico
// dispara sondas RTSP ACTIVAS contra el NVR y escribe en DB. Mostrarle el botón a
// otro rol sólo produciría un 403.
import type { Role } from '@/types'

export const CAMERA_DIAGNOSTICS_ROLES: readonly Role[] = ['ADMIN', 'SUPERVISOR']

export function canRunCameraDiagnostics(role: Role | null | undefined): boolean {
  return !!role && CAMERA_DIAGNOSTICS_ROLES.includes(role)
}
