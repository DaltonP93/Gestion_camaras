// apps/api/src/playback-video/lib/procs.ts
//
// Procesos del NVR simulado de ESTA corrida, identificados por el directorio de
// trabajo (VC_SIM_WORK_ROOT, único por corrida):
//   - consumidor: el ffmpeg real que lanzó la API (entrada `-i unix:<root>/…`);
//   - productor: `node …/producer.mjs <root>/…`;
//   - entregador: el ffmpeg `-f concat` del productor.
// Sirve para medir la liberación (FFmpeg vivos) y afirmar "sin huérfanos".

import { execFileSync } from 'node:child_process'

export interface SimProcs { consumers: number[]; producers: number[]; feeders: number[] }

export function listSimProcs(workRoot: string): SimProcs {
  let out = ''
  try { out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) } catch { return { consumers: [], producers: [], feeders: [] } }
  const res: SimProcs = { consumers: [], producers: [], feeders: [] }
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line.includes(workRoot)) continue
    const m = line.match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const args = m[2]
    if (/\bproducer\.mjs\b/.test(args)) res.producers.push(pid)
    else if (/ -i unix:/.test(args) && /ffmpeg/.test(args.split(' ')[0])) res.consumers.push(pid)
    else if (/ -f concat /.test(args)) res.feeders.push(pid)
  }
  return res
}

export function totalSimProcs(p: SimProcs): number {
  return p.consumers.length + p.producers.length + p.feeders.length
}

/** PIDs de procesos vivos cuya línea de comando menciona `text` (p. ej., un directorio de corrida). */
export function pidsMentioning(text: string): number[] {
  let out = ''
  try { out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) } catch { return [] }
  const pids: number[] = []
  for (const raw of out.split('\n')) {
    const m = raw.trim().match(/^(\d+)\s+(.*)$/)
    if (m && m[2].includes(text) && Number(m[1]) !== process.pid) pids.push(Number(m[1]))
  }
  return pids
}
