// apps/api/src/playback-video/nvr-sim/isapi-sim.ts
//
// ISAPI simulado (HTTP en loopback) para el cliente REAL `services/hikvision.ts`.
// Responde a partir del MISMO manifiesto que el shim de ffmpeg:
//   - POST /ISAPI/ContentMgmt/search  (paginado: OK / MORE / NO MATCHES)
//   - POST /ISAPI/ContentMgmt/record/tracks/{pista}/dailyDistribution
//   - GET  /ISAPI/System/time
// con autenticación Digest (credenciales ficticias). Registra cada consulta (sin
// credenciales). Cualquier otra ruta responde 404 ISAPI y queda registrada.

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SimManifest } from '../media/generate'

export interface IsapiCall {
  method: string
  path: string
  t: number
  search?: { track: string; from: string; to: string; pos: number; total: number; status: string }
}

export interface IsapiSim {
  port: number
  calls: IsapiCall[]
  /** Pistas que la búsqueda devolvió con al menos un resultado. */
  tracksReturned: Set<string>
  close(): Promise<void>
}

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')
const tag = (xml: string, t: string) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]
const hikCompact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '')

export function startIsapiSim(opts: {
  manifest: () => SimManifest
  user: string
  pass: string
  pageSize?: number
  /** Hora local del NVR que devuelve System/time (ISO con offset). */
  localTime?: string
  timeZone?: string
}): Promise<IsapiSim> {
  const calls: IsapiCall[] = []
  const tracksReturned = new Set<string>()
  const nonce = crypto.randomBytes(8).toString('hex')
  const realm = 'DS-SIMULADO'
  const pageSize = opts.pageSize ?? 2

  const authOk = (req: http.IncomingMessage): boolean => {
    const h = req.headers.authorization || ''
    if (!h.startsWith('Digest ')) return false
    const kv = Object.fromEntries([...h.slice(7).matchAll(/(\w+)=("([^"]*)"|[^,]*)/g)].map((m) => [m[1], m[3] ?? m[2]]))
    const ha1 = md5(`${opts.user}:${realm}:${opts.pass}`)
    const ha2 = md5(`${req.method}:${kv.uri}`)
    const expected = kv.qop
      ? md5(`${ha1}:${kv.nonce}:${kv.nc}:${kv.cnonce}:${kv.qop}:${ha2}`)
      : md5(`${ha1}:${kv.nonce}:${ha2}`)
    return kv.username === opts.user && kv.response === expected
  }

  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      if (!authOk(req)) {
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"` })
        res.end()
        return
      }
      const manifest = opts.manifest()
      const url = new URL(req.url ?? '/', 'http://nvr.invalid')
      const call: IsapiCall = { method: req.method ?? 'GET', path: url.pathname, t: Date.now() }
      calls.push(call)
      res.setHeader('Content-Type', 'application/xml')

      if (url.pathname === '/ISAPI/System/time') {
        res.end(`<?xml version="1.0"?><Time><timeMode>NTP</timeMode><localTime>${opts.localTime ?? new Date().toISOString().replace('Z', '+00:00')}</localTime><timeZone>${opts.timeZone ?? 'CST+0:00:00'}</timeZone></Time>`)
        return
      }
      if (url.pathname === '/ISAPI/ContentMgmt/search' && req.method === 'POST') {
        const track = tag(body, 'trackID') ?? ''
        const from = tag(body, 'startTime') ?? ''
        const to = tag(body, 'endTime') ?? ''
        const st = Date.parse(from)
        const et = Date.parse(to)
        const pos = Number(tag(body, 'searchResultPostion') ?? 0)
        const segs = (manifest.tracks[track] ?? []).filter((s) => Date.parse(s.end) > st && Date.parse(s.start) < et)
        const page = segs.slice(pos, pos + pageSize)
        const status = segs.length === 0 ? 'NO MATCHES' : (pos + page.length < segs.length ? 'MORE' : 'OK')
        call.search = { track, from, to, pos, total: segs.length, status }
        if (page.length > 0) tracksReturned.add(track)
        const items = page.map((s, i) => {
          const name = `000100000${track}${String(pos + i).padStart(2, '0')}`
          return `<searchMatchItem><sourceID>{sim}</sourceID><trackID>${track}</trackID>` +
            `<timeSpan><startTime>${s.start}</startTime><endTime>${s.end}</endTime></timeSpan>` +
            `<mediaSegmentDescriptor><contentType>video</contentType><codecType>H.264</codecType>` +
            `<playbackURI>rtsp://${manifest.nvrHost}/Streaming/tracks/${track}/?starttime=${hikCompact(s.start)}&amp;endtime=${hikCompact(s.end)}&amp;name=${name}&amp;size=1048576</playbackURI>` +
            `</mediaSegmentDescriptor><metadataMatches><metadataDescriptor>recordType.meta.hikvision.com/timing</metadataDescriptor></metadataMatches></searchMatchItem>`
        }).join('')
        res.end(`<?xml version="1.0" encoding="UTF-8"?><CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">` +
          `<searchID>{sim}</searchID><responseStatus>true</responseStatus><responseStatusStrg>${status}</responseStatusStrg>` +
          `<numOfMatches>${page.length}</numOfMatches><matchList>${items}</matchList></CMSearchResult>`)
        return
      }
      const dd = url.pathname.match(/^\/ISAPI\/ContentMgmt\/record\/tracks\/(\d+)\/dailyDistribution$/)
      if (dd) {
        const y = Number(tag(body, 'year'))
        const mo = Number(tag(body, 'monthOfYear'))
        const days = new Set((manifest.tracks[dd[1]] ?? []).map((s) => new Date(s.start))
          .filter((d) => d.getUTCFullYear() === y && d.getUTCMonth() + 1 === mo).map((d) => d.getUTCDate()))
        const n = new Date(Date.UTC(y, mo, 0)).getUTCDate()
        res.end(`<?xml version="1.0"?><trackDailyDistribution><dayList>${Array.from({ length: n }, (_, i) =>
          `<day><id>${i + 1}</id><dayOfMonth>${i + 1}</dayOfMonth><record>${days.has(i + 1)}</record><recordType>time</recordType></day>`).join('')}</dayList></trackDailyDistribution>`)
        return
      }
      res.writeHead(404)
      res.end('<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString></ResponseStatus>')
    })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: (srv.address() as AddressInfo).port,
    calls,
    tracksReturned,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()) }),
  })))
}
