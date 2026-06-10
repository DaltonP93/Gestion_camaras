// apps/api/src/routes/admin.ts
// Admin-only debug endpoints (role: ADMIN required for all routes).
import type { FastifyPluginAsync } from 'fastify'
import {
  getActiveSessions,
  getAdminSessionsSummary,
  getTranscodesDiagnostic,
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
}
