import { describe, it, expect } from 'vitest'
import { PreviewProcessRegistry, isProcAlive, type ManagedProc } from './preview-process-registry'

// Doble de ChildProcess: SIGTERM NO mata por sí solo (el proceso puede ignorarlo);
// SIGKILL sí. simulateExit() modela el `close` real (salida confirmada).
function fakeProc(pid = Math.floor(Math.random() * 1e6)): ManagedProc & {
  kills: string[]; simulateExit: (code?: number | null, sig?: NodeJS.Signals | null) => void
} {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kills: [] as string[],
    kill(signal?: NodeJS.Signals | number) {
      this.kills.push(String(signal ?? 'SIGTERM'))
      if (signal === 'SIGKILL') { this.signalCode = 'SIGKILL' }  // SIGKILL termina
      return true
    },
    simulateExit(code: number | null = 0, sig: NodeJS.Signals | null = null) {
      this.exitCode = code; this.signalCode = sig
    },
  }
}

describe('isProcAlive', () => {
  it('vivo mientras no haya exitCode ni signalCode', () => {
    const p = fakeProc()
    expect(isProcAlive(p)).toBe(true)
    p.simulateExit(0)
    expect(isProcAlive(p)).toBe(false)
  })
  it('killed-por-señal cuenta como muerto', () => {
    const p = fakeProc()
    p.kill('SIGKILL')
    expect(isProcAlive(p)).toBe(false)
  })
})

describe('register / unregister (req 9, 11)', () => {
  it('cada intento recibe attemptId único + pid, y se registran TODOS', () => {
    const reg = new PreviewProcessRegistry()
    const a = reg.register(fakeProc(111), 0)
    const b = reg.register(fakeProc(222), 5)
    expect(a.attemptId).not.toBe(b.attemptId)
    expect(a.pid).toBe(111)
    expect(b.pid).toBe(222)
    expect(reg.size).toBe(2)          // registro de TODOS los hijos, no sólo el actual
  })
  it('unregister en el close saca el intento', () => {
    const reg = new PreviewProcessRegistry()
    const a = reg.register(fakeProc(), 0)
    reg.unregister(a.attemptId)
    expect(reg.size).toBe(0)
    reg.unregister(a.attemptId)        // idempotente
    expect(reg.size).toBe(0)
  })
})

// REQUISITO 16: dos GET /stream para la misma sessionId no pueden dejar dos FFmpeg
// vivos. El segundo GET TOMA EL CONTROL: termina el intento anterior antes de
// registrar el suyo.
describe('takeover — dos GET no dejan dos FFmpeg vivos (req 10, 16)', () => {
  it('el segundo stream termina el primero; sólo uno queda vivo', () => {
    const reg = new PreviewProcessRegistry()
    const first = fakeProc(1001)
    reg.register(first, 0)

    // Segundo GET: toma el control → SIGTERM al anterior (opción "terminar y
    // esperar la toma de control"), y NUNCA arranca un FFmpeg paralelo sin matar.
    const pending = reg.terminateAll()
    expect(pending).toHaveLength(1)
    expect(first.kills).toContain('SIGTERM')

    // El primero confirma su salida (close) y se da de baja.
    first.simulateExit(0, 'SIGTERM')
    // baja en el close real: aquí lo hacemos por su attemptId (el único registrado)
    reg.unregister(reg.list()[0].attemptId)

    // Recién ahora el segundo GET registra su proceso.
    const second = fakeProc(1002)
    reg.register(second, 10)

    expect(reg.aliveCount()).toBe(1)      // exactamente uno vivo
    expect(isProcAlive(first)).toBe(false)
    expect(isProcAlive(second)).toBe(true)
  })

  it('si el anterior IGNORA SIGTERM, el SIGKILL de gracia lo mata (no queda huérfano)', () => {
    const reg = new PreviewProcessRegistry()
    const stubborn = fakeProc(2001)
    const rec = reg.register(stubborn, 0)
    reg.terminateAll()
    expect(stubborn.kills).toContain('SIGTERM')
    expect(isProcAlive(stubborn)).toBe(true)   // ignoró SIGTERM

    reg.sigkillIfAlive(rec.attemptId)           // gracia agotada → SIGKILL
    expect(stubborn.kills).toContain('SIGKILL')
    expect(isProcAlive(stubborn)).toBe(false)
  })
})

// REQUISITO 17 (a nivel de registro): el teardown termina TODOS los hijos SIN
// depender de ningún token — el cierre de socket que dispara terminateAll mata
// FFmpeg aunque un DELETE previo haya fallado por token expirado.
describe('teardown independiente del token (req 12, 15, 17)', () => {
  it('terminateAll mata a todos los hijos vivos sin condición de auth', () => {
    const reg = new PreviewProcessRegistry()
    const a = fakeProc(3001); const b = fakeProc(3002)
    reg.register(a, 0); reg.register(b, 0)

    // No hay ningún parámetro de token: el cierre de socket termina server-side.
    const pending = reg.terminateAll()
    expect(pending).toHaveLength(2)
    a.simulateExit(0, 'SIGTERM'); b.simulateExit(0, 'SIGTERM')
    expect(reg.aliveCount()).toBe(0)
  })

  it('confirma "sin procesos vivos" tras dar de baja los cerrados (req 12)', () => {
    const reg = new PreviewProcessRegistry()
    const a = fakeProc(); const b = fakeProc()
    const ra = reg.register(a, 0); const rb = reg.register(b, 0)
    reg.terminateAll()
    a.simulateExit(); reg.unregister(ra.attemptId)
    expect(reg.aliveCount()).toBe(1)       // b aún no confirmó → cleanup_pending
    b.simulateExit(); reg.unregister(rb.attemptId)
    expect(reg.aliveCount()).toBe(0)       // ahora sí: session_deleted confirmable
    expect(reg.size).toBe(0)
  })
})

// REQUISITO 13: el cierre tardío de un intento anterior no debe tocar el nuevo.
// Al comparar por attemptId, dar de baja el viejo no afecta al registro del nuevo.
describe('cierre tardío del intento viejo no toca el nuevo (req 13)', () => {
  it('unregister del attempt viejo deja intacto el nuevo', () => {
    const reg = new PreviewProcessRegistry()
    const oldP = fakeProc(4001); const ro = reg.register(oldP, 0)
    const newP = fakeProc(4002); const rn = reg.register(newP, 10)

    // El viejo cierra TARDE (tras el takeover): sólo se da de baja a sí mismo.
    oldP.simulateExit(255, null)
    reg.unregister(ro.attemptId)

    expect(reg.has(rn.attemptId)).toBe(true)
    expect(reg.size).toBe(1)
    expect(isProcAlive(newP)).toBe(true)
  })
})

// REQUISITO 15: reaper de huérfanos — un hijo vivo, distinto del proceso activo y
// suficientemente viejo, se mata como red de seguridad (sweep periódico).
describe('reapOrphans — red de seguridad (req 15)', () => {
  it('mata al proceso superado y viejo, no al activo', () => {
    const reg = new PreviewProcessRegistry()
    const orphan = fakeProc(5001); reg.register(orphan, 0)
    const active = fakeProc(5002); reg.register(active, 0)

    const killed: number[] = []
    // now=100_000, edad del huérfano = 100_000 > 30_000
    const reaped = reg.reapOrphans(active, 100_000, 30_000, (r) => killed.push(r.pid!))
    expect(reaped).toHaveLength(1)
    expect(killed).toEqual([5001])
    expect(isProcAlive(orphan)).toBe(false)
    expect(isProcAlive(active)).toBe(true)      // el activo nunca se toca
  })
  it('no mata a un huérfano reciente (dentro de la ventana de gracia)', () => {
    const reg = new PreviewProcessRegistry()
    const recent = fakeProc(6001); reg.register(recent, 95_000)
    const active = fakeProc(6002); reg.register(active, 0)
    const reaped = reg.reapOrphans(active, 100_000, 30_000, () => {})
    expect(reaped).toHaveLength(0)              // edad 5_000 < 30_000
    expect(isProcAlive(recent)).toBe(true)
  })
})
