// services/nvrSync.ts
// Shared NVR camera metadata sync logic usable from routes and background workers.
import type { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { getIpCameraList, probeInputProxy } from './hikvision'

// Per-NVR lock — prevents simultaneous sync runs for the same NVR
const syncLocks = new Map<string, boolean>()

export interface SyncResult {
  nvrId:        string
  total:        number
  synced:       number
  ipUpdated:    number
  nameUpdated:  number
  statusUpdated: number
  sourceUsed:   string
  isapIStatus:  string
  syncedAt:     string
  skipped:      boolean  // true when lock was held
}

const PLACEHOLDER_RE = /^(canal\s*\d+|c[aá]mara\s*\d+|camera\s*\d*|ipcamera\s*\d*|d\d+|channel\s+\d+|\d{3,4})$/i

function isPlaceholder(name?: string | null): boolean {
  if (!name || !name.trim()) return true
  return PLACEHOLDER_RE.test(name.trim())
}

const SOURCE_PRIORITY = [
  'inputproxy_channels_secure', 'inputproxy_channels',
  'inputproxy_status_secure',  'inputproxy_status',
  'videoinput', 'streaming', 'fallback',
] as const

/**
 * Sync camera metadata for a single NVR from ISAPI endpoints.
 * Uses a per-NVR lock so simultaneous calls are no-ops (returns skipped=true).
 * Does NOT require an HTTP request from the user — safe to call from workers.
 */
export async function syncNvrCameraMetadata(
  nvrId: string,
  prisma: PrismaClient,
  log: FastifyBaseLogger | Console,
  opts: { forceNames?: boolean } = {},
): Promise<SyncResult> {
  if (syncLocks.get(nvrId)) {
    log.info?.(`[nvrSync] ${nvrId} sync skipped — already running`)
    return { nvrId, total: 0, synced: 0, ipUpdated: 0, nameUpdated: 0, statusUpdated: 0, sourceUsed: 'none', isapIStatus: 'unknown', syncedAt: new Date().toISOString(), skipped: true }
  }

  syncLocks.set(nvrId, true)

  try {
    const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } })
    if (!nvr || !(nvr as any).active) {
      syncLocks.delete(nvrId)
      return { nvrId, total: 0, synced: 0, ipUpdated: 0, nameUpdated: 0, statusUpdated: 0, sourceUsed: 'none', isapIStatus: 'unknown', syncedAt: new Date().toISOString(), skipped: false }
    }

    let decPass: string
    try {
      const { decryptNvrPasswordOrNull } = await import('./credentials')
      const dec = decryptNvrPasswordOrNull(nvr.password)
      if (!dec) throw new Error('empty')
      decPass = dec
    } catch {
      syncLocks.delete(nvrId)
      return { nvrId, total: 0, synced: 0, ipUpdated: 0, nameUpdated: 0, statusUpdated: 0, sourceUsed: 'none', isapIStatus: 'unknown', syncedAt: new Date().toISOString(), skipped: false }
    }

    const nvrDec = { ...nvr, password: decPass }

    // 1. Probe ISAPI access level
    const isapIStatus = await probeInputProxy(nvrDec as any)
    await prisma.nVR.update({ where: { id: nvrId }, data: { isapIStatus } as any })

    if (isapIStatus === 'no_permission') {
      syncLocks.delete(nvrId)
      return { nvrId, total: 0, synced: 0, ipUpdated: 0, nameUpdated: 0, statusUpdated: 0, sourceUsed: 'none', isapIStatus, syncedAt: new Date().toISOString(), skipped: false }
    }

    // 2. Get camera list via fallback chain (InputProxy status → VideoInput → Streaming)
    const ipCams = await getIpCameraList(nvrDec as any)

    const usedSources = new Set(ipCams.map(c => c.metadataSource))
    const sourceUsed = SOURCE_PRIORITY.find(s => usedSources.has(s)) ?? 'none'

    let synced = 0, ipUpdated = 0, nameUpdated = 0, statusUpdated = 0

    for (const cam of ipCams) {
      const existing = await prisma.camera.findUnique({
        where:  { nvrId_channel: { nvrId, channel: cam.channel } },
        select: { id: true, name: true, ipAddress: true, managementPort: true },
      })
      if (!existing) continue

      const isFromInputProxy = (cam.metadataSource ?? '').startsWith('inputproxy')
      const hasRealName = isFromInputProxy
        ? (cam.metadataSource !== 'inputproxy_status' && cam.metadataSource !== 'inputproxy_status_secure')
        : (cam.metadataSource === 'videoinput' || cam.metadataSource === 'streaming')

      const changes: Record<string, any> = { lastSyncAt: new Date() }

      if (hasRealName && cam.name && !isPlaceholder(cam.name)) {
        if (isPlaceholder(existing.name) || opts.forceNames) {
          changes.name = cam.name
          nameUpdated++
        }
      }

      if (isFromInputProxy && cam.ipAddress && cam.ipAddress !== existing.ipAddress) {
        changes.ipAddress = cam.ipAddress
        ipUpdated++
      }

      if (isFromInputProxy && cam.managementPort > 0 && cam.ipAddress && cam.managementPort !== existing.managementPort) {
        changes.managementPort = cam.managementPort
      }

      if (isFromInputProxy && cam.protocol) changes.protocol = cam.protocol
      if (isFromInputProxy && cam.securityStatus) changes.securityStatus = cam.securityStatus

      const statusStr = (cam.status || '').toLowerCase()
      if (isFromInputProxy && (statusStr === 'online' || statusStr === 'offline')) {
        changes.onlineInNvr = statusStr === 'online'
        // Sellar la observación (frescura coherente con el booleano, review Codex #126).
        changes.onlineInNvrAt = new Date()
        if (changes.onlineInNvr === false) changes.online = false
        statusUpdated++
      }

      changes.channelCode = cam.channelCode || `D${cam.channel}`

      await prisma.camera.update({ where: { id: existing.id }, data: changes })
      synced++
    }

    // Update NVR lastSyncAt
    await prisma.nVR.update({ where: { id: nvrId }, data: { lastSyncAt: new Date() } as any })

    log.info?.(`[nvrSync] ${nvr.name} done: total=${ipCams.length} synced=${synced} ip=${ipUpdated} name=${nameUpdated} status=${statusUpdated} source=${sourceUsed}`)

    return {
      nvrId,
      total:         ipCams.length,
      synced,
      ipUpdated,
      nameUpdated,
      statusUpdated,
      sourceUsed,
      isapIStatus,
      syncedAt:      new Date().toISOString(),
      skipped:       false,
    }
  } finally {
    syncLocks.delete(nvrId)
  }
}
