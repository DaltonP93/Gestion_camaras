// apps/api/src/routes/recordings.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { searchRecordings } from '../services/hikvision'
import { AuditAction } from '../services/audit'
import { waitForHlsReady } from '../services/stream'
import CryptoJS from 'crypto-js'
import axios from 'axios'
import crypto from 'crypto'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// ─── MediaMTX client (same pattern as stream.ts) ─────────────────
const mediamtxApi = axios.create({
  baseURL: process.env.MEDIAMTX_URL || 'http://mediamtx:9997',
  timeout: 8000,
})

// ─── In-memory recording playback sessions ────────────────────────
// key: sessionId — auto-cleanup after RECORDING_SESSION_TTL_MS of inactivity
const RECORDING_SESSION_TTL_MS = 30 * 60 * 1000  // 30 minutes
interface RecordingSession {
  streamPath: string
  expiresAt:  number
  userId:     string
}
const recordingSessions = new Map<string, RecordingSession>()

// Periodic cleanup of expired recording paths
setInterval(async () => {
  const now = Date.now()
  for (const [sid, session] of recordingSessions.entries()) {
    if (now > session.expiresAt) {
      recordingSessions.delete(sid)
      mediamtxApi.delete(`/v3/config/paths/delete/${session.streamPath}`).catch(() => {})
    }
  }
}, 5 * 60 * 1000)

async function createRecordingHlsPath(
  rtspUrl: string,
  sessionId: string,
): Promise<string> {
  const streamPath = `rec_${sessionId}`
  const config = {
    source:          rtspUrl,
    sourceOnDemand:  false,    // pull immediately — recording is finite, not on-demand
    rtspTransport:   'tcp',
    record:          false,
    overridePublisher: true,
  }
  try {
    await mediamtxApi.post(`/v3/config/paths/add/${streamPath}`, config)
  } catch (err: any) {
    if (err.response?.status === 400) {
      // Path already exists — patch it
      await mediamtxApi.patch(`/v3/config/paths/patch/${streamPath}`, config)
    } else {
      throw err
    }
  }
  return streamPath
}

// In-memory capability cache: nvrId → 'isapi' | 'unsupported' | 'auth_error'
const nvrCapabilityCache = new Map<string, { result: string; expiresAt: number }>()
const CAPABILITY_TTL_MS = 15 * 60 * 1000  // 15 minutes

function getCachedCapability(nvrId: string): string | null {
  const entry = nvrCapabilityCache.get(nvrId)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.result
}
function setCachedCapability(nvrId: string, result: string) {
  nvrCapabilityCache.set(nvrId, { result, expiresAt: Date.now() + CAPABILITY_TTL_MS })
}

const searchSchema = z.object({
  cameraId:  z.string().min(1),
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
})

const batchSearchSchema = z.object({
  nvrId:     z.string().min(1),
  cameraIds: z.array(z.string().min(1)).min(1).max(128),
  from:      z.string().datetime(),
  to:        z.string().datetime(),
})

const playbackSchema = z.object({
  cameraId:  z.string().min(1),
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
})

export const recordingRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/recordings/search — Buscar grabaciones (single camera, legacy)
  server.get('/search', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user  = request.user
    const query = searchSchema.parse(request.query)

    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const camera = await server.prisma.camera.findUnique({
      where: { id: query.cameraId }, include: { nvr: true },
    })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    if (user.role === 'AUDITOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: query.cameraId, canPlayback: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso para grabaciones de esta cámara' })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }

    let recordings
    try {
      recordings = await searchRecordings(nvr as any, camera.channel, new Date(query.startTime), new Date(query.endTime))
    } catch (err: any) {
      if (err?.unsupported) return reply.status(422).send({ code: 'ISAPI_UNSUPPORTED', message: 'Este NVR no soporta búsqueda de grabaciones vía ISAPI', nvrModel: camera.nvr.model })
      if (err?.authError)   return reply.status(502).send({ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR' })
      return reply.status(502).send({ code: 'NVR_ERROR', message: 'No se pudo contactar el NVR' })
    }

    await AuditAction(server.prisma, user.sub, 'SEARCH_RECORDINGS', query.cameraId, request, {
      startTime: query.startTime, endTime: query.endTime, resultsCount: recordings.length,
    })

    return reply.send({ recordings, source: 'nvr_isapi', camera: { id: camera.id, name: camera.name, channel: camera.channel }, nvrModel: camera.nvr.model })
  })

  // POST /api/recordings/batch-search — Buscar grabaciones para múltiples cámaras de un NVR
  // Evita N requests al frontend y comparte el check de capacidad del NVR
  server.post('/batch-search', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const body = batchSearchSchema.parse(request.body)
    const from  = new Date(body.from)
    const to    = new Date(body.to)

    if (from >= to) return reply.status(400).send({ message: 'La fecha "from" debe ser anterior a "to"' })

    // Load NVR
    const nvr = await server.prisma.nVR.findUnique({ where: { id: body.nvrId } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    // Load cameras filtering to those in the requested list
    const cameras = await server.prisma.camera.findMany({
      where: { id: { in: body.cameraIds }, nvrId: body.nvrId },
    })
    if (cameras.length === 0) return reply.status(404).send({ message: 'No se encontraron cámaras para este NVR' })

    // AUDITOR: filter to cameras they have canPlayback permission on
    let allowedIds = cameras.map(c => c.id)
    if (user.role === 'AUDITOR') {
      const perms = await server.prisma.userPermission.findMany({
        where: { userId: user.sub, cameraId: { in: allowedIds }, canPlayback: true },
      })
      const permSet = new Set(perms.map(p => p.cameraId).filter(Boolean) as string[])
      allowedIds = allowedIds.filter(id => permSet.has(id))
      if (allowedIds.length === 0) return reply.send({ results: [], unsupportedNvr: false, errors: [] })
    }

    const nvrWithPass = { ...nvr, password: decryptPass(nvr.password) }

    // Check capability cache before making any ISAPI calls
    const cachedCap = getCachedCapability(nvr.id)
    if (cachedCap === 'unsupported') {
      return reply.send({
        results: [],
        unsupportedNvr: true,
        nvrModel: nvr.model,
        nvrName: nvr.name,
        playbackWebUrl: (nvr as any).playbackWebUrl ?? null,
        errors: [],
        cameraCount: allowedIds.length,
      })
    }
    if (cachedCap === 'auth_error') {
      return reply.send({
        results: [],
        unsupportedNvr: false,
        authError: true,
        nvrModel: nvr.model,
        nvrName: nvr.name,
        errors: [{ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR' }],
        cameraCount: allowedIds.length,
      })
    }

    const allowedCameras = cameras.filter(c => allowedIds.includes(c.id))
    const results: Array<{ cameraId: string; cameraName: string; channel: number; recordings: any[] }> = []
    let unsupportedNvr = false

    // Search camera by camera — first failure for unsupported/auth short-circuits the rest
    for (const camera of allowedCameras) {
      if (unsupportedNvr) break
      try {
        const recs = await searchRecordings(nvrWithPass as any, camera.channel, from, to)
        results.push({ cameraId: camera.id, cameraName: camera.name, channel: camera.channel, recordings: recs })
        setCachedCapability(nvr.id, 'isapi')  // at least one success
      } catch (err: any) {
        if (err?.unsupported) {
          setCachedCapability(nvr.id, 'unsupported')
          unsupportedNvr = true
          // persist supportsIsapiRecording=false to DB (fire and forget)
          break
        }
        if (err?.authError) {
          setCachedCapability(nvr.id, 'auth_error')
          return reply.send({
            results,
            unsupportedNvr: false,
            authError: true,
            nvrModel: nvr.model,
            nvrName: nvr.name,
            errors: [{ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR', cameraId: camera.id }],
            cameraCount: allowedIds.length,
          })
        }
        results.push({ cameraId: camera.id, cameraName: camera.name, channel: camera.channel, recordings: [] })
      }
    }

    if (results.length > 0) {
      await AuditAction(server.prisma, user.sub, 'SEARCH_RECORDINGS', body.nvrId, request, {
        from: body.from, to: body.to, cameras: allowedIds.length,
        total: results.reduce((s, r) => s + r.recordings.length, 0),
      })
    }

    return reply.send({
      results,
      unsupportedNvr,
      nvrModel: nvr.model,
      nvrName:  nvr.name,
      playbackWebUrl: unsupportedNvr ? ((nvr as any).playbackWebUrl ?? null) : undefined,
      errors:   [],
      cameraCount: allowedIds.length,
    })
  })

  // POST /api/recordings/playback — Start recording playback via MediaMTX HLS proxy
  // Returns an HLS URL (/hls/rec_<sessionId>/index.m3u8) — no RTSP or credentials sent to browser.
  server.post('/playback', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    const body = playbackSchema.parse(request.body)

    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const camera = await server.prisma.camera.findUnique({
      where: { id: body.cameraId }, include: { nvr: true },
    })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    if (user.role === 'AUDITOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: body.cameraId, canPlayback: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso de reproducción' })
    }

    const plainPass = decryptPass(camera.nvr.password)
    if (!plainPass) {
      return reply.status(422).send({ message: 'No se pueden descifrar las credenciales del NVR' })
    }

    // Build Hikvision RTSP playback URL with time range — stays server-side
    const ch       = String(camera.channel).padStart(2, '0')
    const start    = new Date(body.startTime)
    const end      = new Date(body.endTime)
    const fmtTs    = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
    const rtspUrl  = `rtsp://${camera.nvr.username}:${plainPass}@${camera.nvr.ipAddress}:${camera.nvr.rtspPort}/Streaming/tracks/${ch}00?starttime=${fmtTs(start)}&endtime=${fmtTs(end)}`

    const sessionId = crypto.randomBytes(8).toString('hex')

    try {
      const streamPath = await createRecordingHlsPath(rtspUrl, sessionId)
      const hlsUrl     = `/hls/${streamPath}/index.m3u8`
      const expiresAt  = new Date(Date.now() + RECORDING_SESSION_TTL_MS).toISOString()

      recordingSessions.set(sessionId, {
        streamPath,
        expiresAt: Date.now() + RECORDING_SESSION_TTL_MS,
        userId:    user.sub,
      })

      // Wait for MediaMTX to connect to the NVR RTSP before returning the URL.
      // Without this the frontend immediately gets a 404 on the manifest.
      const ready = await waitForHlsReady(streamPath, 20_000, 800)
      if (!ready.ready) {
        recordingSessions.delete(sessionId)
        mediamtxApi.delete(`/v3/config/paths/delete/${streamPath}`).catch(() => {})
        server.log.warn(`[recordings] hls_not_ready sessionId=${sessionId} lastStatus=${ready.lastStatus} elapsed=${ready.elapsedMs}ms`)
        return reply.status(504).send({ message: 'El servidor de medios no pudo conectar con el NVR a tiempo' })
      }

      server.log.info(`[recordings] playback_started sessionId=${sessionId} path=${streamPath} cameraId=${body.cameraId} ch=${camera.channel} hlsReady=${ready.elapsedMs}ms`)

      await AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
        startTime: body.startTime, endTime: body.endTime, sessionId,
      })

      return reply.send({ url: hlsUrl, sessionId, expiresAt })
    } catch (err: any) {
      server.log.error(`[recordings] playback_failed sessionId=${sessionId} cameraId=${body.cameraId} err=${err.message}`)
      return reply.status(502).send({ message: 'No se pudo iniciar la reproducción en el servidor de medios' })
    }
  })

  // DELETE /api/recordings/playback/:sessionId — Stop recording playback and release MediaMTX path
  server.delete('/playback/:sessionId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)
    if (!session) return reply.status(404).send({ message: 'Sesión no encontrada' })
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }
    recordingSessions.delete(sessionId)
    await mediamtxApi.delete(`/v3/config/paths/delete/${session.streamPath}`).catch(() => {})
    server.log.info(`[recordings] playback_stopped sessionId=${sessionId} path=${session.streamPath}`)
    return reply.send({ ok: true })
  })

  // GET /api/recordings/audit — Log de accesos a grabaciones (solo ADMIN)
  server.get('/audit', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { page = '1', limit = '50' } = request.query as { page?: string; limit?: string }

    const logs = await server.prisma.auditLog.findMany({
      where: { action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] } },
      include: { user: { select: { username: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
    })
    const total = await server.prisma.auditLog.count({
      where: { action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] } },
    })

    return reply.send({ logs, total, page: parseInt(page), limit: parseInt(limit) })
  })
}
