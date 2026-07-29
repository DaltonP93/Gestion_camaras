import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PreviewProcessRegistry, type ManagedProc } from './preview-process-registry'

// Doble de ChildProcess como EventEmitter mínimo. CLAVE (req 4): kill() NO cambia
// ningún estado de "salida" — sólo registra la señal. La salida REAL se comunica
// llamando a `reg.markExited(attemptId)` / `reg.unregister(attemptId)`, tal como el
// route lo hace desde los eventos exit/close reales. Un proceso puede ignorar
// SIGTERM y hasta SIGKILL sin emitir salida (el peor caso que rompía el takeover).
function fakeProc(pid = Math.floor(Math.random() * 1e6)): ManagedProc & { kills: string[] } {
  return {
    pid,
    kills: [] as string[],
    kill(signal?: NodeJS.Signals | number) {
      this.kills.push(String(signal ?? 'SIGTERM'))
      return true
    },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('register / markExited / aliveCount (req 2, 4, 9, 11)', () => {
  it('cada intento tiene attemptId único + pid; vive hasta exit/close REAL', () => {
    const reg = new PreviewProcessRegistry({ graceMs: 10 })
    const a = reg.register(fakeProc(111), 0)
    const b = reg.register(fakeProc(222), 5)
    expect(a.attemptId).not.toBe(b.attemptId)
    expect(a.pid).toBe(111); expect(b.pid).toBe(222)
    expect(reg.size).toBe(2)
    expect(reg.aliveCount()).toBe(2)

    reg.markExited(a.attemptId)              // salida real del primero
    expect(reg.aliveCount()).toBe(1)
    reg.markExited(a.attemptId)              // idempotente
    expect(reg.aliveCount()).toBe(1)
  })

  it('kill() NO cuenta como salida: aliveCount sólo baja con markExited (req 4)', () => {
    const reg = new PreviewProcessRegistry({ graceMs: 10 })
    const p = fakeProc()
    const rec = reg.register(p, 0)
    reg.terminate(rec.attemptId, 'x')
    expect(p.kills).toContain('SIGTERM')
    expect(reg.aliveCount()).toBe(1)         // señal enviada, pero sin exit real → vivo
    vi.advanceTimersByTime(50)
    expect(p.kills).toContain('SIGKILL')
    expect(reg.aliveCount()).toBe(1)         // SIGKILL enviado, aún sin exit → SIGUE vivo
    reg.markExited(rec.attemptId)            // recién el exit/close real lo mata
    expect(reg.aliveCount()).toBe(0)
  })
})

// REQUISITO 5: un ChildProcess que ignora SIGTERM, recibe SIGKILL, NO emite
// exit/close, mantiene aliveCount()>0 pasado el deadline → waitAllExited=false →
// el route NO debe spawnear (hard gate PREVIOUS_FFMPEG_NOT_REAPED).
describe('proceso que no confirma salida pasado el deadline (req 1, 2, 5)', () => {
  it('waitAllExited devuelve false y aliveCount sigue > 0', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 100 })
    const stubborn = fakeProc(9001)
    reg.register(stubborn, 0)
    reg.terminateAll('stream_takeover')

    const waitP = reg.waitAllExited(600)      // PREVIEW_KILL_GRACE_MS + 500 análogo
    await vi.advanceTimersByTimeAsync(120)     // pasa la gracia → SIGKILL
    expect(stubborn.kills).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(600)     // vence el deadline SIN exit/close
    const reaped = await waitP
    expect(reaped).toBe(false)                 // no se confirmó salida
    expect(reg.aliveCount()).toBe(1)           // sigue vivo → route NO spawnea
  })

  it('si el proceso confirma salida durante la espera, waitAllExited = true', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 100 })
    const p = fakeProc(9002)
    const rec = reg.register(p, 0)
    reg.terminateAll('stream_takeover')
    const waitP = reg.waitAllExited(600)
    await vi.advanceTimersByTimeAsync(50)
    reg.markExited(rec.attemptId)              // exit/close real antes del deadline
    const reaped = await waitP
    expect(reaped).toBe(true)
    expect(reg.aliveCount()).toBe(0)
  })
})

// REQUISITO 6 (a nivel de registro/decisión, sin Fastify): la lógica del takeover
// del segundo GET. Máximo un proceso vivo; el segundo espera la salida real; si no
// sale → no reaped (el route responde PREVIOUS_FFMPEG_NOT_REAPED y no spawnea).
describe('takeover del segundo GET (req 6, 10)', () => {
  // Modela la decisión del route: sólo se permite registrar (spawn) el nuevo
  // proceso si la espera confirmó 0 vivos.
  async function takeover(reg: PreviewProcessRegistry, deadlineMs: number) {
    if (reg.aliveCount() > 0) {
      reg.terminateAll('stream_takeover')
      const reaped = await reg.waitAllExited(deadlineMs)
      if (!reaped || reg.aliveCount() > 0) return { proceed: false, code: 'PREVIOUS_FFMPEG_NOT_REAPED' }
    }
    return { proceed: true as const }
  }

  it('el anterior SÍ sale → el segundo procede y queda un solo proceso vivo', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const first = fakeProc(1001)
    const r1 = reg.register(first, 0)

    const decision = takeover(reg, 600)
    await vi.advanceTimersByTimeAsync(10)
    reg.markExited(r1.attemptId); reg.unregister(r1.attemptId)  // salida real + baja
    const d = await decision
    expect(d.proceed).toBe(true)
    expect(reg.aliveCount()).toBe(0)

    const second = reg.register(fakeProc(1002), 20)             // recién ahora spawn
    expect(reg.aliveCount()).toBe(1)
    expect(second.attemptId).not.toBe(r1.attemptId)
  })

  it('el anterior NO sale → el segundo NO procede (PREVIOUS_FFMPEG_NOT_REAPED, sin spawn)', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    reg.register(fakeProc(2001), 0)                             // nunca emite exit

    const decision = takeover(reg, 300)
    await vi.advanceTimersByTimeAsync(400)
    const d = await decision
    expect(d.proceed).toBe(false)
    expect(d.code).toBe('PREVIOUS_FFMPEG_NOT_REAPED')
    expect(reg.aliveCount()).toBe(1)                            // nunca se superpuso un 2.º
    expect(reg.size).toBe(1)                                    // no se registró spawn nuevo
  })
})

// REQUISITO 7: múltiples eventos close/error/DELETE → una sola terminación y un
// solo timer de SIGKILL por attempt.
describe('terminación idempotente por attempt (req 3, 7)', () => {
  it('llamar terminate varias veces envía UN SIGTERM y UN SIGKILL', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const p = fakeProc(3001)
    const rec = reg.register(p, 0)

    const p1 = reg.terminate(rec.attemptId, 'delete')
    const p2 = reg.terminate(rec.attemptId, 'client_disconnect')  // DELETE + socket
    const p3 = reg.terminate(rec.attemptId, 'ffmpeg_error')        // + error
    expect(p1).toBe(p2)                          // misma promesa (misma secuencia)
    expect(p2).toBe(p3)
    expect(p.kills.filter((s) => s === 'SIGTERM')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60)
    expect(p.kills.filter((s) => s === 'SIGKILL')).toHaveLength(1)  // un solo SIGKILL
    expect(rec.terminationReason).toBe('delete')                    // la 1.ª razón gana
  })

  it('si sale durante la gracia, NO se envía SIGKILL', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const p = fakeProc(3002)
    const rec = reg.register(p, 0)
    reg.terminate(rec.attemptId, 'takeover')
    await vi.advanceTimersByTimeAsync(10)
    reg.markExited(rec.attemptId)                 // exit real durante la gracia
    await vi.advanceTimersByTimeAsync(60)
    expect(p.kills).toEqual(['SIGTERM'])          // el SIGKILL se canceló
  })

  it('terminate sobre un intento ya salido es no-op', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const p = fakeProc(3003)
    const rec = reg.register(p, 0)
    reg.markExited(rec.attemptId)
    await reg.terminate(rec.attemptId, 'late')
    expect(p.kills).toHaveLength(0)
  })
})

// REQUISITO 13: cierre tardío del intento viejo no toca el nuevo.
describe('cierre tardío del intento viejo no toca el nuevo (req 13)', () => {
  it('unregister del viejo deja intacto el nuevo', () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const oldP = reg.register(fakeProc(4001), 0)
    const newP = reg.register(fakeProc(4002), 10)
    oldP.proc.kill('SIGTERM')
    reg.markExited(oldP.attemptId); reg.unregister(oldP.attemptId)
    expect(reg.has(newP.attemptId)).toBe(true)
    expect(reg.size).toBe(1)
    expect(reg.aliveCount()).toBe(1)
  })
})

// REQUISITO 15: reaper de huérfanos (vivos, superados y viejos).
describe('reapOrphans — red de seguridad (req 15)', () => {
  it('termina al proceso superado y viejo, no al activo', () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const orphan = fakeProc(5001); reg.register(orphan, 0)
    const active = fakeProc(5002); reg.register(active, 0)
    const reaped = reg.reapOrphans(active, 100_000, 30_000, 'orphan_sweep')
    expect(reaped).toHaveLength(1)
    expect(reaped[0].pid).toBe(5001)
    expect(orphan.kills).toContain('SIGTERM')
    expect(active.kills).toHaveLength(0)         // el activo nunca se toca
  })
  it('no toca a un huérfano reciente', () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const recent = fakeProc(6001); reg.register(recent, 95_000)
    const active = fakeProc(6002); reg.register(active, 0)
    expect(reg.reapOrphans(active, 100_000, 30_000, 'orphan_sweep')).toHaveLength(0)
    expect(recent.kills).toHaveLength(0)
  })
})
