// apps/api/src/playback-video/lib/netlog.ts
//
// Lectura del netlog del navegador (`--log-net-log`): lo escribe el servicio de red
// de Chromium/Chrome con TODOS sus sockets (páginas, DoH, servicios de fondo), cosa
// que ni los eventos de Playwright ni el centinela de Node (que sólo ve sockets del
// proceso de la suite) pueden ver. Sirve para afirmar el aislamiento del navegador.
//
// Formato: línea 1 = {"constants":{...}, línea 2 = "events": [, después UN evento
// por línea terminado en coma. Se lee línea por línea (tolera un archivo truncado).

import fs from 'node:fs'

export interface BrowserNet {
  /** Se pudo leer el netlog (constantes y eventos). */
  ok: boolean
  error?: string
  bytes: number
  events: number
  /** Destinos de sockets (TCP/UDP) en loopback, distintos. Debe ser > 0: prueba que el netlog vio tráfico. */
  loopbackSockets: number
  /** Destinos de sockets fuera de loopback ("TIPO ip:puerto"). Debe ser []. */
  nonLoopback: string[]
  /** Pedidos de URL fuera de loopback que el navegador INTENTÓ (origen; bloqueados por el resolvedor). */
  attemptedOrigins: string[]
}

const isLoopbackAddr = (a: string) => /^(127\.\d+\.\d+\.\d+(:\d+)?|\[::1\](:\d+)?|::1)$/.test(a)

function originOf(u: string): string | null {
  try {
    const x = new URL(u)
    if (!/^(https?|wss?):$/.test(x.protocol)) return null
    return /^(127\.\d+\.\d+\.\d+|\[::1\])$/.test(x.hostname) ? null : `${x.protocol}//${x.host}`
  } catch { return null }
}

/** Análisis PURO del texto de un netlog (se prueba en metrics.test.ts). */
export function analyzeNetlog(text: string): BrowserNet {
  const res: BrowserNet = { ok: false, bytes: text.length, events: 0, loopbackSockets: 0, nonLoopback: [], attemptedOrigins: [] }
  const lines = text.split('\n')
  let types: Record<string, number>
  try {
    types = JSON.parse(lines[0].replace(/,\s*$/, '') + '}').constants.logEventTypes
    if (!types || typeof types !== 'object') throw new Error('sin constants.logEventTypes')
  } catch (e) {
    res.error = `netlog ilegible: ${(e as Error).message}`
    return res
  }
  const names = new Map<number, string>(Object.entries(types).map(([k, v]) => [Number(v), k]))
  const loop = new Set<string>()
  const outside = new Set<string>()
  const origins = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    let ev: { type?: number; params?: Record<string, unknown> }
    try { ev = JSON.parse(line.replace(/,$/, '')) } catch { continue }
    if (typeof ev.type !== 'number') continue
    res.events++
    const name = names.get(ev.type) ?? ''
    const p = ev.params ?? {}
    if (/CONNECT/.test(name)) {
      const addrs = [p.address, ...(Array.isArray(p.address_list) ? p.address_list : []), p.remote_address]
      for (const a of addrs) {
        if (typeof a !== 'string' || !a) continue
        if (isLoopbackAddr(a)) loop.add(a)
        else outside.add(`${name} ${a}`)
      }
    }
    if (typeof p.url === 'string') {
      const o = originOf(p.url)
      if (o) origins.add(o)
    }
  }
  res.ok = res.events > 0
  if (!res.ok) res.error = 'netlog sin eventos'
  res.loopbackSockets = loop.size
  res.nonLoopback = [...outside].sort()
  res.attemptedOrigins = [...origins].sort()
  return res
}

export function readNetlog(file: string): BrowserNet {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    return { ok: false, error: `no se pudo leer el netlog: ${(e as Error).message}`, bytes: 0, events: 0, loopbackSockets: 0, nonLoopback: [], attemptedOrigins: [] }
  }
  return analyzeNetlog(text)
}
