// apps/api/src/routes/mediaGrants.ts
//
// Rutas del plano de medios (C22, endurecido C22.1/C22.2). Registradas SÓLO si
// NATIVE_PLAYBACK_ENABLED (server.ts): con la flag apagada no existen (404).
//
// El scope (streamPath/effectiveType/codec/mediaInstanceId/epoch) es
// SERVER-DERIVADO. Readiness y RBAC son los MISMOS que usa la negociación
// (native-readiness). `issue` se niega si no hay una fuente real vigente.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { getStreamPath } from '../services/stream'
import { getMediaGrantManager, getNativeReadiness, getSessionPolicy } from '../services/media/grant-service'
import { decideGrantIssuance, timingSafeEqualHex, sha256Hex } from '../services/media/media-grants'
import { hasMediaAccess, deriveEffectiveType } from '../services/media/native-readiness'
import type { GrantScopeQuery, MediaTransport } from '../services/media/contracts'

const NATIVE_PLAYBACK_ENABLED = process.env.NATIVE_PLAYBACK_ENABLED === 'true'
const NATIVE_MEDIA_RELAY_ENABLED = process.env.NATIVE_MEDIA_RELAY_ENABLED === 'true'
const MEDIA_RELAY_SECRET = process.env.MEDIA_RELAY_SECRET || ''
const GRANT_TTL_MS = Math.min(300_000, Math.max(5_000, Number(process.env.MEDIA_GRANT_TTL_MS) || 30_000))

const issueSchema = z.object({
  viewId:    z.string().min(1).max(128),
  cameraId:  z.string().min(1),
  transport: z.enum(['rtsps', 'whep']),
  device:    z.string().min(1).max(120),
  sessionId: z.string().min(1).max(128).optional(),
})
const validateSchema = z.object({
  grantId:    z.string().min(1).max(128),
  secret:     z.string().min(1).max(256),
  streamPath: z.string().min(1).max(200),
  transport:  z.enum(['rtsps', 'whep']),
  // B4: cameraId ESPERADO por el relay. Cuando se presenta se compara contra el
  // grant (SCOPE_MISMATCH real). Opcional por compatibilidad; si falta, no puede
  // verificarse en esta frontera (ver comentario en scope).
  cameraId:   z.string().min(1).max(200).optional(),
})
function codecOf(raw: string | null | undefined): 'h264' | 'hevc' {
  return /hevc|h\.?265|hvc1/i.test(raw ?? '') ? 'hevc' : 'h264'
}

export const mediaGrantsRoutes: FastifyPluginAsync = async (server) => {
  const manager = getMediaGrantManager(server)
  const readiness = getNativeReadiness(server)

  server.post('/media-grant', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    const body = issueSchema.parse(request.body)

    const camera = await server.prisma.camera.findUnique({ where: { id: body.cameraId }, include: { nvr: true } })
    if (!camera || !camera.nvr) return reply.status(404).send({ code: 'CAMERA_NOT_FOUND' })

    const effectiveType = deriveEffectiveType(camera.mainCodec)
    const codec = effectiveType === 'main' ? 'hevc' : codecOf(camera.subCodec)
    const streamPath = getStreamPath(camera.nvr, camera, effectiveType)

    // RBAC compartido con la negociación.
    const perm = (user.role === 'ADMIN' || user.role === 'SUPERVISOR') ? null : await server.prisma.userPermission.findFirst({
      where: { userId: user.sub, cameraId: body.cameraId }, select: { canView: true, canHighQuality: true },
    })
    const hasCameraAccess = hasMediaAccess({ role: user.role, effectiveType, perm })

    // Readiness UNIFICADA (comprueba store atómico + Redis vivo + secreto + transporte).
    const ready = await readiness.evaluate(true)

    const decision = decideGrantIssuance({
      playbackEnabled: NATIVE_PLAYBACK_ENABLED,
      relayReady: ready.ready,
      transport: body.transport,
      hasCameraAccess,
    })
    if (!decision.allow) return reply.status(decision.httpStatus).send({ code: decision.code, reasons: ready.reasons })

    const result = await manager.issue({
      userId: user.sub, viewId: body.viewId, cameraId: body.cameraId,
      streamPath, effectiveType, codec, transport: body.transport,
      device: body.device, sessionId: body.sessionId, ttlMs: GRANT_TTL_MS,
    })
    if (!result.ok) {
      const status = result.code === 'NO_MEDIA_INSTANCE' ? 409 : 503
      return reply.status(status).send({ code: result.code })
    }
    // N2d — sesión única por usuario (multi-dispositivo): con la flag apagada es
    // no-op; activa, revoca los grants de la sesión previa del usuario.
    if (body.sessionId) {
      const { revokedPrior } = await getSessionPolicy(server).register(user.sub, body.sessionId)
      if (revokedPrior > 0) server.log.info(`media_grant single_session revokedPrior=${revokedPrior} user=${user.sub.slice(0, 8)}`)
    }
    return reply.send(result.issued)
  })

  server.delete('/media-grant/:grantId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { grantId } = request.params as { grantId: string }
    const revoked = await manager.revoke(grantId, request.user.sub)
    return reply.send({ revoked })
  })

  server.delete('/media-grant/view/:viewId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { viewId } = request.params as { viewId: string }
    const revoked = await manager.revokeByView(viewId, request.user.sub)
    return reply.send({ revoked })
  })

  // POST /internal/media-grant/validate — lo llama el relay.
  server.post('/internal/media-grant/validate', async (request, reply) => {
    if (!NATIVE_MEDIA_RELAY_ENABLED) return reply.status(404).send({ code: 'NATIVE_MEDIA_RELAY_DISABLED' })
    if (!MEDIA_RELAY_SECRET) return reply.status(503).send({ code: 'MEDIA_RELAY_SECRET_UNSET' })
    const provided = request.headers['x-media-relay-secret']
    if (typeof provided !== 'string' || !timingSafeEqualHex(sha256Hex(provided), sha256Hex(MEDIA_RELAY_SECRET))) {
      return reply.status(401).send({ code: 'RELAY_SECRET_INVALID' })
    }
    const body = validateSchema.parse(request.body)
    const stored = await manager.peek(body.grantId)
    if (!stored) return reply.status(403).send({ ok: false, reason: 'NOT_FOUND' })

    // B4: el scope se compara contra los valores PRESENTADOS por el relay, no
    // contra el propio grant (antes userId/cameraId se copiaban del grant peekeado
    // ⇒ SCOPE_MISMATCH tautológico, nunca disparaba). streamPath/transport siempre
    // los presenta el relay; cameraId cuando lo envía (SCOPE_MISMATCH real). userId
    // NO es presentable aquí: el relay se autentica por secreto compartido, no como
    // usuario, así que ese campo sólo puede tomarse del grant.
    const scope: GrantScopeQuery = {
      userId: stored.userId,
      cameraId: body.cameraId ?? stored.cameraId,
      streamPath: body.streamPath, transport: body.transport as MediaTransport, action: 'read',
    }
    const result = await manager.consume({ grantId: body.grantId, secret: body.secret }, scope)
    if (!result.ok) return reply.status(403).send({ ok: false, reason: result.reason })
    return reply.send({
      ok: true, cameraId: result.grant!.cameraId, streamPath: result.grant!.streamPath,
      transport: result.grant!.transport, codec: result.grant!.codec, expiresAt: result.grant!.expiresAt,
    })
  })
}
