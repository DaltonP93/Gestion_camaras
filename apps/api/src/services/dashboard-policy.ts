// apps/api/src/services/dashboard-policy.ts
//
// Helper PURO de política del Dashboard (sin Fastify ni Prisma), testeable como
// unidad — misma convención que `appearance-policy.ts`.
//
// #171 (follow-up autorizado): el resumen `/api/dashboard/overview` agrega conteos
// NVR/cámara/alerta (recurso NVR-wide). Antes estaba abierto a CUALQUIER usuario
// autenticado; el flag de feature `canViewDashboard` era UI_ONLY (evadible). Aquí
// se convierte en ENFORCED_BACKEND.

import { resolveFeaturePermissions } from './totp'

/**
 * ¿Puede el usuario ver el resumen del Dashboard?
 * ADMIN siempre puede. El resto sólo si su `canViewDashboard` RESUELTO (defaults de
 * rol + overrides) es true. El default es `true` en todos los roles ⇒ este gate sólo
 * bloquea a quien un ADMIN le quitó el permiso explícitamente (no hay lockout nuevo).
 */
export function canViewDashboard(
  role: string,
  featurePermissions: Record<string, boolean> | null | undefined,
): boolean {
  if (role === 'ADMIN') return true
  const resolved = resolveFeaturePermissions(role, featurePermissions)
  return resolved.canViewDashboard === true
}
