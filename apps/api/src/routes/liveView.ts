// apps/api/src/routes/liveView.ts
// Endpoint de viewport heartbeat: reconcilia cámaras visibles sin N llamadas individuales
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { reconcileView, MAX_TRANSCODE_SESSIONS, getAdminSessionsSummary, getTranscodesDiagnostic, getStreamCounts, getSessionsDiagnostic, getStreamIdleTimeoutMs, getStreamHdIdleTimeoutMs, getTranscodeSlots } from '../services/stream-manager'
import { getFfmpegCapabilities, isTranscodingEnabled } from '../services/stream'
import { negotiateLivePlaybackCapabilities } from '../services/live-playback-capabilities'
import { decideLivePlayback } from '../services/live-playback-decision'
import { getNativeReadiness, getMediaGrantManager } from '../services/media/grant-service'
import { deriveMediaRequest } from '../services/media/grant-derivation'

// C22 · flags apagadas por defecto ⇒ la respuesta es idéntica a C21.
const NATIVE_PLAYBACK_ENABLED = process.env.NATIVE_PLAYBACK_ENABLED === 'true'

const heartbeatSchema = z.object({
  viewId:           z.string().min(1).max(128),
  visibleCameraIds: z.array(z.string()).max(25),
  // Cámaras que deben permanecer visibles pero NO iniciarse (backoff de límite
  // en el frontend). El backend las omite del arranque sin detener sesiones vivas.
  suppressStartCameraIds: z.array(z.string()).max(25).optional(),
  layout:           z.number().int().positive().optional(),
  page:             z.number().int().min(0).optional(),
})

const clientCapabilitiesSchema = z.object({
  runtime: z.enum(['web', 'windows', 'android', 'ios']),
  codecs: z.array(z.enum(['h264', 'hevc'])).max(4),
  hardwareDecodedCodecs: z.array(z.enum(['h264', 'hevc'])).max(4),
  transports: z.array(z.enum(['hls', 'whep', 'rtsps'])).max(6),
  maxHardwareDecoders: z.number().int().positive().max(1024).optional(),
  // C22 (opcional): si se envían, y NATIVE_PLAYBACK_ENABLED está activo, la
  // respuesta incluye una decisión explícita por-cámara (con eco de scope).
  cameraId: z.string().min(1).max(128).optional(),
  viewId: z.string().min(1).max(128).optional(),
})

export const liveViewRoutes: FastifyPluginAsync = async (server) => {
  // POST /api/live-view/heartbeat
  // Reconcilia el estado de las cámaras visibles para un view dado.
  // - Inicia streams para cámaras visibles sin sesión activa
  // - Detiene streams para cámaras que este view ya no necesita
  // - Toca sesiones existentes (keepalive)
  // - Devuelve URLs completas para todas las cámaras visibles
  server.post('/heartbeat', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    const body = heartbeatSchema.parse(request.body)

    const result = await reconcileView(
      server,
      user.sub,
      body.viewId,
      body.visibleCameraIds,
      body.suppressStartCameraIds ?? [],
      // Ticket estampado por el hook `onRequest`, antes de la autenticación:
      // tomarlo dentro de reconcileView sería posterior a `jwtVerify` y a la
      // validación del cuerpo, con lo que una petición vieja reanudada tras un
      // cierre parecería nueva (revisión de #148).
      request.requestTicket,
    )

    // Log estructurado para diagnosticar producción
    const errCount  = Object.keys(result.errors).length
    const logParts = [
      `[live-view] heartbeat`,
      `userId=${user.sub.slice(0, 8)}`,
      `viewId=${body.viewId.slice(0, 8)}`,
      `visible=${body.visibleCameraIds.length}`,
      `layout=${body.layout ?? '?'}`,
      `page=${body.page ?? '?'}`,
      `started=${result.startedIds.length}`,
      `stopped=${result.stoppedIds.length}`,
      `streams=${Object.keys(result.streams).length}`,
      `errors=${errCount}`,
    ]
    if (result.startedIds.length > 0) logParts.push(`startedIds=[${result.startedIds.join(',')}]`)
    if (result.stoppedIds.length > 0) logParts.push(`stoppedIds=[${result.stoppedIds.join(',')}]`)
    if (errCount > 0) {
      const errSummary = Object.entries(result.errors)
        .map(([id, e]) => `${id.slice(0,8)}:${e.code}`)
        .join(', ')
      logParts.push(`errDetail=[${errSummary}]`)
    }
    server.log.info(logParts.join(' '))

    // Conteos actuales de streams — el frontend los usa para mostrar "X/Y" en el
    // banner de límite alcanzado y decidir el backoff antes de reintentar.
    return reply.send({ ...result, streamCounts: getStreamCounts(user.sub) })
  })

  // GET /api/live-view/sessions
  // Diagnóstico de sesiones de streaming activas (sin credenciales). Devuelve
  // datos de TODOS los usuarios (cameraId/userId/viewId), por eso es solo ADMIN
  // — igual que /api/cameras/stream-sessions. Purga las vencidas antes de listar.
  server.get('/sessions', { preHandler: [server.authorize(['ADMIN'])] }, async (_request, reply) => {
    return reply.send(getSessionsDiagnostic())
  })

  // GET /api/live-view/capabilities
  // Devuelve capacidades del servidor para que el frontend adapte la UI.
  server.get('/capabilities', { preHandler: [server.authenticate] }, async (_request, reply) => {
    const caps = getFfmpegCapabilities()
    return reply.send({
      ffmpegAvailable:     caps.available,
      transcodingEnabled:  isTranscodingEnabled(),
      encoders:            caps.encoders,
      maxTranscodeSessions: MAX_TRANSCODE_SESSIONS,
      // TTL EFECTIVO de sesiones, ya normalizado y acotado por getSessionTtl().
      // El frontend NO debe suponer 90 s: si el operador configura otro valor
      // (o configura uno inválido que se acota), la lógica de reanudación tras
      // una pestaña oculta tiene que usar el plazo que realmente rige.
      streamIdleTimeoutMs:   getStreamIdleTimeoutMs(),
      streamHdIdleTimeoutMs: getStreamHdIdleTimeoutMs(),
    })
  })

  // POST /api/live-view/client-capabilities
  // Negocia capacidades SIN abrir un stream ni devolver una URL. Es la base
  // del cliente nativo multiplataforma: hasta que exista relay autenticado con
  // credenciales efímeras, `nativeDirect.available` permanece explícitamente
  // false y el único fallback HEVC habilitado sigue siendo el del servidor.
  server.post('/client-capabilities', { preHandler: [server.authenticate] }, async (request, reply) => {
    const input = clientCapabilitiesSchema.parse(request.body)
    const ffmpeg = getFfmpegCapabilities()
    const serverCaps = {
      ffmpegAvailable: ffmpeg.available,
      transcodingEnabled: isTranscodingEnabled(),
      maxTranscodeSessions: MAX_TRANSCODE_SESSIONS,
    }
    // Respuesta base = contrato C21 (sin cambios).
    const base = negotiateLivePlaybackCapabilities(input, serverCaps)

    // C22 (aditivo): con la flag activa y un cameraId, se agrega una DECISIÓN
    // explícita por-cámara. Con la flag apagada la respuesta es idéntica a C21.
    if (NATIVE_PLAYBACK_ENABLED && input.cameraId) {
      const user = request.user
      const cameraId = input.cameraId
      // DERIVACIÓN COMPARTIDA con la emisión (/media-grant): misma cámara, tipo,
      // codec, streamPath, RBAC y readiness POR PATH (mediaInstanceId vigente).
      const manager = getMediaGrantManager(server)
      const derived = await deriveMediaRequest(
        { prisma: server.prisma as any, role: user.role, userId: user.sub, currentInstance: (p) => manager.currentInstance(p) },
        cameraId,
      )
      // Camera desconocida ⇒ no puede haber nativo: acceso por rol y sin instancia.
      const d = derived.ok ? derived.derived : {
        mainCodec: 'unknown' as const,
        access: { live: user.role === 'ADMIN' || user.role === 'SUPERVISOR', hd: user.role === 'ADMIN' || user.role === 'SUPERVISOR' },
        hasInstance: false,
      }
      const slots = getTranscodeSlots()
      const availableTranscodeSlots = Math.max(0, slots.maxTranscodes - slots.activeProcessCount)
      // Readiness UNIFICADA (mismo servicio que la emisión); ofrece transporte nativo.
      const offersNativeTransport = input.transports.includes('rtsps') || input.transports.includes('whep')
      const ready = await getNativeReadiness(server).evaluate(offersNativeTransport)
      const decision = decideLivePlayback({
        client: input,
        server: serverCaps,
        relayReady: ready.ready,
        nativePlaybackEnabled: NATIVE_PLAYBACK_ENABLED,
        camera: { mainCodec: d.mainCodec },
        capacity: { availableTranscodeSlots },
        access: d.access,
        // P3: sin instancia vigente para el path EXACTO, la emisión daría
        // NO_MEDIA_INSTANCE ⇒ la negociación no elige nativo y explica el motivo.
        mediaInstanceReady: d.hasInstance,
      })
      // P0-3 · COHERENCIA: nativeDirect.available refleja EXACTAMENTE la decisión.
      // Nunca se combina nativeDirect=false con una decisión nativa.
      const isNative = decision.decision === 'native_hevc' || decision.decision === 'native_h264'
      const coherent = {
        ...base,
        nativeDirect: {
          ...base.nativeDirect,
          available: isNative,
          blockingReason: isNative ? null : base.nativeDirect.blockingReason,
        },
      }
      // Eco de scope para que el cliente descarte respuestas tardías (viewport viejo).
      return reply.send({ ...coherent, decision: { ...decision, cameraId, viewId: input.viewId ?? null } })
    }

    return reply.send(base)
  })

  // GET /api/live-view/transcodes
  // Diagnóstico completo de procesos FFmpeg activos — incluye reinicios, stderr y estado MediaMTX.
  server.get('/transcodes', { preHandler: [server.authenticate] }, async (_request, reply) => {
    const procs    = await getTranscodesDiagnostic()
    const sessions = getAdminSessionsSummary().filter(s => s.streamPath.endsWith('_main_h264'))
    return reply.send({
      activeFFmpegProcesses: procs,
      activeTranscodeSessions: sessions,
      summary: {
        ffmpegCount:  procs.length,
        aliveCount:   procs.filter(p => p.alive).length,
        sessionCount: sessions.length,
      },
    })
  })
}
