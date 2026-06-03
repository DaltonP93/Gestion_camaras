// apps/api/src/routes/search.ts
import type { FastifyPluginAsync } from 'fastify'

export interface SearchResult {
  type: 'camera' | 'nvr' | 'view' | 'alert'
  id: string
  title: string
  subtitle: string
  nvrId?: string
  cameraId?: string
  url: string
  status?: string
  metadata?: Record<string, unknown>
}

export const searchRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/search/global?q=<query>
  // Returns normalized results across cameras, NVRs, views and alerts.
  server.get('/global', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { q } = request.query as { q?: string }
    const query = (q ?? '').trim()
    if (query.length < 2) return reply.send([])

    const user = request.user
    const isPrivileged = ['ADMIN', 'SUPERVISOR'].includes(user.role)

    const results: SearchResult[] = []

    // ── Cameras ──────────────────────────────────────────────────
    let cameras
    if (isPrivileged) {
      cameras = await server.prisma.camera.findMany({
        where: {
          OR: [
            { name:       { contains: query, mode: 'insensitive' } },
            { location:   { contains: query, mode: 'insensitive' } },
            { ipAddress:  { contains: query, mode: 'insensitive' } },
            { mainCodec:  { contains: query, mode: 'insensitive' } },
            { subCodec:   { contains: query, mode: 'insensitive' } },
          ],
        },
        include: { nvr: { select: { id: true, name: true } } },
        take: 20,
        orderBy: [{ online: 'desc' }, { name: 'asc' }],
      })
    } else {
      // Restrict to cameras the user has permission to view
      const perms = await server.prisma.userPermission.findMany({
        where: { userId: user.sub, cameraId: { not: null }, canView: true },
        select: { cameraId: true },
      })
      const allowedIds = perms.map((p: any) => p.cameraId!).filter(Boolean)
      cameras = await server.prisma.camera.findMany({
        where: {
          id: { in: allowedIds },
          OR: [
            { name:       { contains: query, mode: 'insensitive' } },
            { location:   { contains: query, mode: 'insensitive' } },
            { ipAddress:  { contains: query, mode: 'insensitive' } },
          ],
        },
        include: { nvr: { select: { id: true, name: true } } },
        take: 20,
        orderBy: [{ online: 'desc' }, { name: 'asc' }],
      })
    }

    for (const cam of cameras) {
      const channelCode = (cam as any).channelCode || `D${cam.channel}`
      results.push({
        type:     'camera',
        id:       cam.id,
        title:    cam.name,
        subtitle: `${channelCode} · ${(cam as any).nvr?.name ?? '—'}${cam.ipAddress ? ` · ${cam.ipAddress}` : ''}`,
        nvrId:    cam.nvrId,
        cameraId: cam.id,
        url:      `/live?nvr=${cam.nvrId}&camera=${cam.id}`,
        status:   cam.online ? 'online' : 'offline',
        metadata: {
          channel:    cam.channel,
          codec:      cam.subCodec || cam.mainCodec,
          resolution: cam.subResolution || cam.mainResolution,
          location:   cam.location,
        },
      })
    }

    // ── NVRs (privileged only) ────────────────────────────────────
    if (isPrivileged) {
      const nvrs = await server.prisma.nVR.findMany({
        where: {
          OR: [
            { name:      { contains: query, mode: 'insensitive' } },
            { ipAddress: { contains: query, mode: 'insensitive' } },
            { location:  { contains: query, mode: 'insensitive' } },
            { model:     { contains: query, mode: 'insensitive' } },
          ],
        },
        take: 10,
        orderBy: [{ online: 'desc' }, { name: 'asc' }],
      })
      for (const nvr of nvrs) {
        results.push({
          type:     'nvr',
          id:       nvr.id,
          title:    nvr.name,
          subtitle: `${nvr.ipAddress} · ${nvr.model}${nvr.location ? ` · ${nvr.location}` : ''}`,
          nvrId:    nvr.id,
          url:      `/nvrs/${nvr.id}`,
          status:   nvr.online ? 'online' : 'offline',
          metadata: { channels: nvr.channels, firmware: nvr.firmware },
        })
      }
    }

    // ── Views ─────────────────────────────────────────────────────
    const viewWhere: any = {
      OR: [
        { name:        { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
      ],
    }
    if (!isPrivileged) {
      // Non-admins can only see public views or views they have access to
      viewWhere.OR = [
        ...viewWhere.OR,
      ]
      viewWhere.isPublic = true
    }

    const views = await server.prisma.cameraView.findMany({
      where: viewWhere,
      take: 10,
      orderBy: { name: 'asc' },
    })
    for (const view of views) {
      results.push({
        type:     'view',
        id:       view.id,
        title:    view.name,
        subtitle: `Vista · ${view.layout}${view.description ? ` · ${view.description}` : ''}`,
        url:      `/views/${view.id}`,
        metadata: { layout: view.layout },
      })
    }

    // ── Alerts (last 10 matching, unresolved) ─────────────────────
    if (isPrivileged) {
      const alerts = await server.prisma.alert.findMany({
        where: {
          resolved: false,
          message: { contains: query, mode: 'insensitive' },
        },
        take: 10,
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      })
      for (const alert of alerts) {
        results.push({
          type:     'alert',
          id:       alert.id,
          title:    alert.message,
          subtitle: `${alert.severity} · ${alert.type}`,
          nvrId:    alert.nvrId ?? undefined,
          cameraId: alert.cameraId ?? undefined,
          url:      '/alerts',
          status:   alert.severity,
          metadata: { type: alert.type, createdAt: alert.createdAt },
        })
      }
    }

    return reply.send(results)
  })
}
