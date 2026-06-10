// apps/api/src/jobs/syncWorker.ts
// Periodic background worker: syncs camera metadata for all online NVRs.
// Interval configurable via NVR_SYNC_INTERVAL_MINUTES (default: 5 minutes).
import cron from 'node-cron'
import type { FastifyInstance } from 'fastify'
import { syncNvrCameraMetadata } from '../services/nvrSync'

const SYNC_INTERVAL_MINUTES = Number(process.env.NVR_SYNC_INTERVAL_MINUTES || 5)

export function startSyncWorker(server: FastifyInstance): void {
  // Build cron expression: every N minutes
  const cronExpr = SYNC_INTERVAL_MINUTES <= 1
    ? '* * * * *'
    : `*/${SYNC_INTERVAL_MINUTES} * * * *`

  server.log.info(`[syncWorker] starting — interval=${SYNC_INTERVAL_MINUTES}min cron="${cronExpr}"`)

  cron.schedule(cronExpr, async () => {
    let nvrs: { id: string; name: string }[]
    try {
      nvrs = await server.prisma.nVR.findMany({
        where:  { active: true, online: true } as any,
        select: { id: true, name: true },
      })
    } catch (e: any) {
      server.log.warn(`[syncWorker] DB query failed: ${e.message}`)
      return
    }

    for (const nvr of nvrs) {
      try {
        const result = await syncNvrCameraMetadata(nvr.id, server.prisma, server.log)
        if (!result.skipped && result.total > 0) {
          server.log.debug(
            `[syncWorker] ${nvr.name} synced=${result.synced}/${result.total} source=${result.sourceUsed}`
          )
        }
      } catch (e: any) {
        server.log.warn(`[syncWorker] ${nvr.name} error: ${e.message}`)
      }
    }
  })
}
