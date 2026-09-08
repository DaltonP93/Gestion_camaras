// apps/api/src/services/media/grant-derivation.ts
//
// C23·H2·P3 — Derivación COMPARTIDA de la petición de medios. La negociación
// (/client-capabilities) y la emisión (/media-grant) DEBEN derivar EXACTAMENTE lo
// mismo — cámara, tipo efectivo, codec, streamPath, permiso/acceso y readiness por
// PATH (¿hay una mediaInstanceId vigente para el path exacto?) — para que la
// negociación no ofrezca `native_*` cuando la emisión respondería NO_MEDIA_INSTANCE.
// Antes cada ruta derivaba por su cuenta y podían divergir; esta función es la
// ÚNICA fuente.

import type { MediaCodec } from './contracts'
import { deriveEffectiveType, hasMediaAccess } from './native-readiness'
import { getStreamPath } from '../stream'

/** Codec efectivo desde el string crudo de la cámara (mismo criterio en ambas rutas). */
export function codecOf(raw: string | null | undefined): MediaCodec {
  return /hevc|h\.?265|hvc1/i.test(raw ?? '') ? 'hevc' : 'h264'
}

/** Normaliza el codec MAIN a 3 valores para la decisión (h264/hevc/unknown). */
export function normalizeMainCodec(raw: string | null | undefined): 'h264' | 'hevc' | 'unknown' {
  if (!raw) return 'unknown'
  if (/hevc|h\.?265|hvc1/i.test(raw)) return 'hevc'
  if (/h\.?264|avc/i.test(raw)) return 'h264'
  return 'unknown'
}

/** Fila mínima de cámara que necesita la derivación (con su NVR). */
export interface CameraForDerivation {
  id: string
  channel: number
  mainCodec: string | null
  subCodec: string | null
  nvr: { id: string } | null
}
export interface PermForDerivation { canView: boolean; canHighQuality: boolean }

export interface DerivedMediaRequest {
  cameraId: string
  effectiveType: 'sub' | 'main'
  codec: MediaCodec
  /** Codec MAIN normalizado (h264/hevc/unknown) para la decisión de reproducción. */
  mainCodec: 'h264' | 'hevc' | 'unknown'
  streamPath: string
  /** Acceso RBAC por tipo (mismo predicado que la emisión). */
  access: { live: boolean; hd: boolean }
  /** ¿Hay una mediaInstanceId vigente para el path EXACTO? (idéntico a lo que exige `issue`). */
  hasInstance: boolean
}

export type DeriveResult =
  | { ok: true; derived: DerivedMediaRequest }
  | { ok: false; reason: 'CAMERA_NOT_FOUND' }

export interface DeriveDeps {
  prisma: {
    camera: { findUnique(args: { where: { id: string }; include: { nvr: true } }): Promise<CameraForDerivation | null> }
    userPermission: { findFirst(args: { where: { userId: string; cameraId: string }; select: { canView: true; canHighQuality: true } }): Promise<PermForDerivation | null> }
  }
  role: string
  userId: string
  /** Instancia de fuente por path (la del store de grants — misma que usa `issue`). */
  currentInstance: (streamPath: string) => Promise<string | null>
}

/**
 * Deriva, de forma idéntica para negociación y emisión, todo lo necesario para
 * decidir/emitir un grant. `hasInstance` usa la MISMA `currentInstance` del store.
 */
export async function deriveMediaRequest(deps: DeriveDeps, cameraId: string): Promise<DeriveResult> {
  const camera = await deps.prisma.camera.findUnique({ where: { id: cameraId }, include: { nvr: true } })
  if (!camera || !camera.nvr) return { ok: false, reason: 'CAMERA_NOT_FOUND' }

  const effectiveType = deriveEffectiveType(camera.mainCodec)
  const codec = effectiveType === 'main' ? 'hevc' : codecOf(camera.subCodec)
  const streamPath = getStreamPath(camera.nvr as any, camera as any, effectiveType)

  // RBAC: ADMIN/SUPERVISOR sin fila; el resto por UserPermission (canView/canHighQuality).
  const perm = (deps.role === 'ADMIN' || deps.role === 'SUPERVISOR')
    ? null
    : await deps.prisma.userPermission.findFirst({ where: { userId: deps.userId, cameraId }, select: { canView: true, canHighQuality: true } })
  const access = {
    live: hasMediaAccess({ role: deps.role, effectiveType: 'sub', perm }),
    hd: hasMediaAccess({ role: deps.role, effectiveType: 'main', perm }),
  }

  // Readiness por PATH: si no podemos leer la instancia (backend caído), se trata
  // como NO vigente (fail hacia fallback; nunca abre nativo por un error de lectura).
  let hasInstance = false
  try { hasInstance = (await deps.currentInstance(streamPath)) !== null } catch { hasInstance = false }
  return { ok: true, derived: { cameraId, effectiveType, codec, mainCodec: normalizeMainCodec(camera.mainCodec), streamPath, access, hasInstance } }
}
