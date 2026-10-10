// apps/api/src/playback-video/lib/http-probe.ts
//
// Pedidos HTTP REALES (loopback) a URL de medios con token, como los haría
// cualquier cliente que tenga la URL: sin cookies ni cabeceras de sesión. Lee como
// máximo `readMs` y corta (el corte es una desconexión real del cliente).

import fs from 'node:fs'
import http from 'node:http'

export interface ProbeResult {
  status: number | null
  error?: string
  headers: Record<string, string | undefined>
  bytes: number
  firstByteMs: number | null
  body?: Buffer
}

export function httpProbe(url: string, opts: { range?: string; readMs?: number; keepBody?: boolean; toFile?: string; headers?: Record<string, string> } = {}): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const chunks: Buffer[] = []
    let bytes = 0
    let firstByteMs: number | null = null
    let done = false
    const out = opts.toFile ? fs.createWriteStream(opts.toFile) : null
    const finish = (r: Omit<ProbeResult, 'bytes' | 'firstByteMs'>) => {
      if (done) return
      done = true
      const result = { ...r, bytes, firstByteMs, ...(opts.keepBody ? { body: Buffer.concat(chunks) } : {}) }
      // Con archivo: resolver recién cuando el contenido quedó escrito en disco.
      if (out) out.end(() => resolve(result))
      else resolve(result)
    }
    const req = http.get(url, { headers: { ...(opts.range ? { range: opts.range } : {}), ...(opts.headers ?? {}) } }, (res) => {
      const headers = {
        'content-type': res.headers['content-type'], 'content-length': res.headers['content-length'] as string | undefined,
        'content-range': res.headers['content-range'] as string | undefined, 'accept-ranges': res.headers['accept-ranges'] as string | undefined,
      }
      const timer = opts.readMs !== undefined ? setTimeout(() => { req.destroy(); finish({ status: res.statusCode ?? null, headers }) }, opts.readMs) : null
      res.on('data', (c: Buffer) => {
        if (firstByteMs === null) firstByteMs = Date.now() - t0
        bytes += c.length
        if (opts.keepBody) chunks.push(c)
        out?.write(c)
      })
      res.on('end', () => { if (timer) clearTimeout(timer); finish({ status: res.statusCode ?? null, headers }) })
      res.on('error', () => { if (timer) clearTimeout(timer); finish({ status: res.statusCode ?? null, headers }) })
    })
    req.on('error', (e) => finish({ status: null, error: e.message, headers: {} }))
  })
}
