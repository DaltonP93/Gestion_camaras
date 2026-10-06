// API/control plane simulated; the <video> and VP9/fMP4 decoding are real.
// No camera, credentials, NVR or production network is contacted.
import type { Page, Route } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export const RECORDING_START = '2026-01-01T12:00:00.000Z'
const media = fileURLToPath(new URL('./recording-synthetic.mp4', import.meta.url))

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

export async function installRecordingsMock(page: Page, options: {
  holdSuccessor?: boolean
  holdFirstMedia?: boolean
  rejectSuccessor?: boolean
  gapSeconds?: number
} = {}) {
  const starts: Array<{ id: string; predecessor: string | null; predecessorActive: boolean; body: Record<string, unknown> }> = []
  const events: string[] = []
  const unexpected: string[] = []
  const active = new Set<string>()
  const queued = new Set<string>()
  const successor = gate()
  const firstMedia = gate()
  if (!options.holdSuccessor) successor.release()
  if (!options.holdFirstMedia) firstMedia.release()

  const camera = { id: 'camA', name: 'Cámara sintética', nvrId: 'nvrA', channel: 1, active: true, online: true, nvr: { id: 'nvrA', name: 'NVR simulado' } }
  const t = Date.parse(RECORDING_START)
  const gap = (options.gapSeconds ?? 0) * 1000
  const records = [0, 1, 2].map(i => ({
    id: `rec${i}`, cameraId: 'camA', trackId: 101,
    startTime: new Date(t + i * (4000 + gap)).toISOString(),
    endTime: new Date(t + i * (4000 + gap) + 4000).toISOString(),
    // Deliberately no RTSP URL: the mocked API never connects to a device.
  }))
  const streamUrl = (id: string) => `/api/recordings/preview/${id}/stream`
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    const method = request.method()
    if (method === 'GET' && path === '/nvrs') return json(route, [{ id: 'nvrA', name: 'NVR simulado', online: true }])
    if (method === 'GET' && path === '/cameras') return json(route, [camera])
    if (method === 'GET' && path === '/recordings/search') return json(route, { recordings: records })

    if (method === 'POST' && path === '/recordings/preview/start') {
      const body = request.postDataJSON()
      const id = (starts.length + 1).toString(16).padStart(16, '0')
      const predecessor = body.continuityOfSessionId ?? null
      const predecessorActive = active.has(predecessor)
      starts.push({ id, predecessor, predecessorActive, body })
      events.push(`start:${id}`)
      if (starts.length > 1) {
        await successor.promise
        if (options.rejectSuccessor) {
          events.push(`rejected:${id}`)
          return json(route, { message: 'Sin permiso de reproducción (prueba)' }, 403)
        }
      }
      active.add(id)
      events.push(`accepted:${id}`)
      // Model the existing admission contract: only an active predecessor can
      // confer continuity priority. This mock does NOT model FFmpeg exit/leases.
      if (predecessorActive) {
        queued.add(id)
        return json(route, { sessionId: id, status: 'queued', queueClass: 'continuity', queuePosition: 1 })
      }
      return json(route, { sessionId: id, status: 'ready', streamUrl: streamUrl(id) })
    }

    const session = path.match(/^\/recordings\/preview\/([a-f0-9]{16})(?:\/(status|stream))?$/)
    if (session) {
      const [, id, action] = session
      if (method === 'DELETE' && !action) {
        events.push(`delete:${id}`)
        active.delete(id)
        queued.delete(id)
        return json(route, { ok: true })
      }
      if (method === 'GET' && action === 'status') {
        if (!active.has(id)) return json(route, { message: 'Gone' }, 410)
        const predecessor = starts.find(s => s.id === id)?.predecessor
        if (queued.has(id) && predecessor && active.has(predecessor)) {
          return json(route, { status: 'queued', queueClass: 'continuity', queuePosition: 1 })
        }
        queued.delete(id)
        return json(route, { status: 'ready', streamUrl: streamUrl(id), videoOnly: true })
      }
      if (method === 'GET' && action === 'stream') {
        events.push(`media:${id}`)
        if (id === '0000000000000001') await firstMedia.promise
        if (!active.has(id)) return json(route, { message: 'Gone' }, 410)
        return route.fulfill({ status: 200, contentType: 'video/mp4', path: media })
      }
    }
    unexpected.push(`${method} ${path}`)
    return json(route, { message: 'Unexpected request in test' }, 500)
  })

  return {
    starts, events, unexpected, active,
    releaseSuccessor: successor.release,
    releaseFirstMedia: firstMedia.release,
  }
}
