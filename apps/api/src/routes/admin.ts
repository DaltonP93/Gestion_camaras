// apps/api/src/routes/admin.ts
// Admin-only debug endpoints (role: ADMIN required for all routes).
import type { FastifyPluginAsync } from 'fastify'
import {
  getActiveSessions,
  getAdminSessionsSummary,
  getTranscodesDiagnostic,
  getTranscodeSlots,
  MAX_TRANSCODE_SESSIONS,
} from '../services/stream-manager'
import { isTranscodeProcessAlive } from '../services/stream'

export const adminRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/admin/debug/transcodes
  // Full diagnostic of every active stream session with FFmpeg process state.
  // Fields: cameraId, streamPath, userId, streamType, state, pid, viewers,
  //         lastHeartbeat, ageSeconds, reserveReason.
  server.get('/debug/transcodes', { preHandler: [server.authorize(['ADMIN'])] }, async (_request, reply) => {
    const allSessions = getActiveSessions()
    const now = Date.now()

    const sessionRows = allSessions.map(s => {
      const ageSeconds = Math.round((now - s.startedAt.getTime()) / 1000)
      const lastHeartbeatSeconds = Math.round((now - s.lastHeartbeat.getTime()) / 1000)

      const viewers = allSessions.filter(
        other => other.cameraId === s.cameraId && other.streamType === s.streamType,
      ).length

      let state: string = 'active'
      let pid: number | undefined
      if (s.streamType === 'main_h264') {
        const alive = isTranscodeProcessAlive(s.streamPath)
        state = alive ? 'transcoding' : 'session_only'
      }

      return {
        cameraId:            s.cameraId,
        streamPath:          s.streamPath,
        userId:              s.userId,
        streamType:          s.streamType,
        state,
        pid,
        viewers,
        lastHeartbeatSecs:   lastHeartbeatSeconds,
        ageSeconds,
      }
    })

    const procs = await getTranscodesDiagnostic()
    const transcodeSessions = getAdminSessionsSummary().filter(s => s.streamPath.endsWith('_main_h264'))

    return reply.send({
      sessions: sessionRows,
      ffmpegProcesses: procs.map(p => ({
        streamPath:     p.streamPath,
        pid:            p.pid,
        alive:          p.alive,
        restartCount:   p.restartCount,
        lastExitCode:   p.lastExitCode,
        lastExitReason: p.lastExitReason,
        rtspMasked:     p.sourceRtspMasked,
        publisherActive: p.mediaMtxPublisherActive,
      })),
      summary: {
        totalSessions:         sessionRows.length,
        subSessions:           sessionRows.filter(s => s.streamType === 'sub').length,
        mainSessions:          sessionRows.filter(s => s.streamType === 'main').length,
        transcodeSessions:     transcodeSessions.length,
        ffmpegAlive:           procs.filter(p => p.alive).length,
        maxTranscodeSessions:  MAX_TRANSCODE_SESSIONS,
      },
    })
  })

  // GET /api/admin/diagnostics/transcodes
  // Diagnóstico de CUPOS de transcodificación: identifica exactamente qué ocupa cada
  // cupo contra maxTranscodes. Sin secretos (IDs, tiempos, perfil y motivo). Enriquece
  // cada slot con el nombre de la cámara desde la DB.
  server.get('/diagnostics/transcodes', { preHandler: [server.authorize(['ADMIN'])] }, async (_request, reply) => {
    const diag = getTranscodeSlots()
    const now  = Date.now()

    // Resolver nombres de cámara en un solo query.
    const cameraIds = [...new Set(diag.slots.map(s => s.cameraId))]
    const cameras = cameraIds.length
      ? await server.prisma.camera.findMany({
          where: { id: { in: cameraIds } },
          select: { id: true, name: true, nvr: { select: { name: true } } },
        })
      : []
    const nameById = new Map(cameras.map(c => [c.id, { cameraName: c.name, nvrName: c.nvr?.name ?? null }]))

    return reply.send({
      maxTranscodes:      diag.maxTranscodes,
      activeProcessCount: diag.activeProcessCount,
      startingCount:      diag.startingCount,
      slots: diag.slots.map(s => ({
        cameraId:      s.cameraId,
        cameraName:    nameById.get(s.cameraId)?.cameraName ?? null,
        nvrName:       nameById.get(s.cameraId)?.nvrName ?? null,
        userId:        s.userId,
        viewId:        s.viewId,
        streamPath:    s.streamPath,
        pid:           s.pid,
        processAlive:  s.processAlive,
        startedAt:     s.startedAt,
        lastHeartbeat: s.lastHeartbeat,
        ageSeconds:    Math.round((now - s.startedAt.getTime()) / 1000),
        idleSeconds:   Math.round((now - s.lastHeartbeat.getTime()) / 1000),
        profile:       s.profile,
        reason:        s.reason,
      })),
    })
  })
}
