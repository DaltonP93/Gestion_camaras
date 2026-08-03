import { describe, it, expect } from 'vitest'
import {
  NvrPlaybackAdmissionController,
  isNvrCapacityCategory,
  stderrIndicates453,
} from './nvr-playback-admission'

// Reloj inyectable para tests deterministas.
function makeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms }, set: (v: number) => { t = v } }
}

function ctl(opts: Partial<{ globalDefault: number | null; cooldownMs: number }> = {}) {
  const clock = makeClock()
  const c = new NvrPlaybackAdmissionController({ now: clock.now, cooldownMs: opts.cooldownMs ?? 60_000 })
  if (opts.globalDefault !== undefined) c.setGlobalDefaultLimit(opts.globalDefault)
  return { c, clock }
}

const req = (over: Partial<Parameters<NvrPlaybackAdmissionController['acquire']>[0]> = {}) => ({
  nvrId: 'nvr-A', sessionId: 's1', userId: 'u1', cameraId: 'cam1', slotIndex: 0, ...over,
})

describe('límite por NVR y precedencia', () => {
  it('precedencia: NVR > global > valor seguro (1)', () => {
    const { c } = ctl()
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)          // valor seguro
    c.setGlobalDefaultLimit(2)
    expect(c.effectiveLimitFor('nvr-A')).toBe(2)          // global
    c.configureNvr('nvr-A', 3)
    expect(c.effectiveLimitFor('nvr-A')).toBe(3)          // por NVR gana
    c.configureNvr('nvr-A', null)
    expect(c.effectiveLimitFor('nvr-A')).toBe(2)          // auto ⇒ vuelve al global
  })
  it('no asume la misma capacidad para todos los NVR', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.configureNvr('nvr-A', 1)
    c.configureNvr('nvr-B', 4)
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)
    expect(c.effectiveLimitFor('nvr-B')).toBe(4)
  })
})

describe('TEST 1/2 — dos cámaras del mismo NVR con limit=1', () => {
  it('la primera obtiene lease, la segunda queda en cola con posición 1', () => {
    const { c } = ctl({ globalDefault: 1 })
    const a = c.acquire(req({ sessionId: 'sA', cameraId: 'camA' }))
    const b = c.acquire(req({ sessionId: 'sB', cameraId: 'camB', slotIndex: 1 }))
    expect(a.granted).toBe(true)
    expect(b.granted).toBe(false)
    expect(b.queued).toBe(true)
    expect(b.position).toBe(1)
    expect(b.activeCount).toBe(1)
    expect(b.effectiveLimit).toBe(1)
    expect(b.estimatedRetryAfterSec).toBeGreaterThan(0)
  })

  it('una cámara de OTRO NVR arranca de inmediato (aislamiento)', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    const other = c.acquire(req({ nvrId: 'nvr-B', sessionId: 'sZ', cameraId: 'camZ' }))
    expect(other.granted).toBe(true)
    expect(c.activeCount('nvr-A')).toBe(1)
    expect(c.activeCount('nvr-B')).toBe(1)
  })
})

describe('TEST 3 — promoción al liberar', () => {
  it('al cerrar la primera, la segunda se promueve UNA sola vez', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))
    const r = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'close' })
    expect(r.released).toBe(true)
    expect(r.promoted.map(p => p.sessionId)).toEqual(['sB'])
    expect(c.hasLease('nvr-A', 'sB')).toBe(true)
    expect(c.queuedCount('nvr-A')).toBe(0)
  })

  it('TEST 14 — varios close/exit liberan y promueven una sola vez (idempotente)', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))
    const r1 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'exit' })
    const r2 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'close' })
    const r3 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'error' })
    expect(r1.promoted).toHaveLength(1)
    expect(r2.promoted).toHaveLength(0)
    expect(r3.promoted).toHaveLength(0)
    expect(r2.released).toBe(false)
    expect(c.activeCount('nvr-A')).toBe(1)   // sólo sB
  })

  it('TEST 15 — nunca se supera el límite ante solicitudes concurrentes', () => {
    const { c } = ctl({ globalDefault: 2 })
    for (let i = 0; i < 20; i++) c.acquire(req({ sessionId: `s${i}`, slotIndex: i }))
    expect(c.activeCount('nvr-A')).toBe(2)
    expect(c.queuedCount('nvr-A')).toBe(18)
    // Liberar todos los activos no debe exceder el límite tampoco.
    c.release({ nvrId: 'nvr-A', sessionId: 's0', reason: 'close' })
    expect(c.activeCount('nvr-A')).toBe(2)
  })

  it('TEST 16 — FIFO determinista', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    for (const s of ['s1', 's2', 's3']) c.acquire(req({ sessionId: s }))
    expect(c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'close' }).promoted[0].sessionId).toBe('s1')
    expect(c.release({ nvrId: 'nvr-A', sessionId: 's1', reason: 'close' }).promoted[0].sessionId).toBe('s2')
    expect(c.release({ nvrId: 'nvr-A', sessionId: 's2', reason: 'close' }).promoted[0].sessionId).toBe('s3')
  })
})

describe('TEST 4/5 — cancelación y reemplazo', () => {
  it('4. cancelar la segunda evita que se inicie al liberarse la primera', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))
    expect(c.cancelQueued({ nvrId: 'nvr-A', sessionId: 'sB', reason: 'user_cancel' })).toBe(true)
    const r = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'close' })
    expect(r.promoted).toHaveLength(0)
    expect(c.hasLease('nvr-A', 'sB')).toBe(false)
  })

  it('cancelar algo que no está en cola es inocuo', () => {
    const { c } = ctl({ globalDefault: 1 })
    expect(c.cancelQueued({ nvrId: 'nvr-A', sessionId: 'nope', reason: 'x' })).toBe(false)
  })

  it('5. cambio de playhead: se cancela la solicitud previa y entra la nueva', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB-old', slotIndex: 1 }))
    // El slot cambia de playhead ⇒ cancela la anterior y pide de nuevo.
    c.cancelQueued({ nvrId: 'nvr-A', sessionId: 'sB-old', reason: 'playhead_changed' })
    const nueva = c.acquire(req({ sessionId: 'sB-new', slotIndex: 1 }))
    expect(nueva.position).toBe(1)
    expect(c.queuedCount('nvr-A')).toBe(1)
    const r = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'close' })
    expect(r.promoted.map(p => p.sessionId)).toEqual(['sB-new'])
  })

  it('acquire es idempotente por sessionId (no duplica cola ni lease)', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB' }))
    c.acquire(req({ sessionId: 'sB' }))
    expect(c.activeCount('nvr-A')).toBe(1)
    expect(c.queuedCount('nvr-A')).toBe(1)
  })
})

describe('TEST 10/11 — modo auto: reducción temporal y cooldown', () => {
  it('10. una sesión con first_byte + 453 en la segunda ⇒ effectiveLimit temporal = 1', () => {
    const { c } = ctl({ globalDefault: 3, cooldownMs: 60_000 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))     // hay cupo (limit 3)
    const r = c.report453({ nvrId: 'nvr-A', sessionId: 'sB' })
    expect(r.effectiveLimit).toBe(1)     // sólo sA estaba reproduciendo bien
    expect(r.reduced).toBe(true)
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)
  })

  it('un 453 sin ninguna sesión sana deja el mínimo en 1 (no 0)', () => {
    const { c } = ctl({ globalDefault: 3 })
    c.acquire(req({ sessionId: 'sA' }))
    const r = c.report453({ nvrId: 'nvr-A', sessionId: 'sA' })
    expect(r.effectiveLimit).toBe(1)
  })

  it('no aprende permanentemente: tras el cooldown la capacidad se restaura', () => {
    const { c, clock } = ctl({ globalDefault: 3, cooldownMs: 60_000 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.report453({ nvrId: 'nvr-A', sessionId: 'sB' })
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)
    clock.advance(59_000)
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)   // aún en cooldown
    clock.advance(2_000)
    expect(c.effectiveLimitFor('nvr-A')).toBe(3)   // 11. recuperación controlada
  })

  it('la reducción nunca sube por encima del límite configurado', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.configureNvr('nvr-A', 1)
    c.report453({ nvrId: 'nvr-A' })
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)
  })

  it('453 repetidos sólo ESTRECHAN, nunca ensanchan, durante el cooldown', () => {
    const { c } = ctl({ globalDefault: 4, cooldownMs: 60_000 })
    // Dos sesiones reproduciendo bien; una tercera intenta y recibe 453.
    for (const s of ['s1', 's2']) { c.acquire(req({ sessionId: s })); c.markFirstByte({ nvrId: 'nvr-A', sessionId: s }) }
    c.acquire(req({ sessionId: 's3' }))                       // sin primer byte
    c.report453({ nvrId: 'nvr-A', sessionId: 's3' })
    expect(c.effectiveLimitFor('nvr-A')).toBe(2)              // sanas: s1, s2

    // Cae s2 y otra intenta: ahora sólo s1 reproduce bien ⇒ estrecha a 1.
    c.release({ nvrId: 'nvr-A', sessionId: 's2', reason: 'close' })
    c.acquire(req({ sessionId: 's4' }))
    c.report453({ nvrId: 'nvr-A', sessionId: 's4' })
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)

    // Aunque vuelva a haber dos sanas, dentro del cooldown NO se ensancha.
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 's4' })
    c.report453({ nvrId: 'nvr-A', sessionId: 's5' })
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)
  })
})

describe('TEST 12/13 — el lease sobrevive fallback de audio y continuidad', () => {
  it('12. el fallback A/V → video-only NO libera el lease (misma sesión)', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    // El relanzamiento video-only reutiliza la MISMA sessionId ⇒ acquire idempotente.
    const again = c.acquire(req({ sessionId: 'sA' }))
    expect(again.granted).toBe(true)
    expect(c.activeCount('nvr-A')).toBe(1)
    // Y nadie más pudo robar el cupo entretanto.
    expect(c.acquire(req({ sessionId: 'sOtro' })).queued).toBe(true)
  })

  it('13. continuidad entre bloques: la misma sesión conserva su lease', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.acquire(req({ sessionId: 'sA' }))   // siguiente bloque, misma sesión
    expect(c.activeCount('nvr-A')).toBe(1)
    expect(c.hasLease('nvr-A', 'sA')).toBe(true)
  })
})

describe('TEST 17/18 — aislamiento entre NVR y limpieza total', () => {
  it('17. liberar un NVR no altera la cola de otro', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ nvrId: 'nvr-A', sessionId: 'a1' }))
    c.acquire(req({ nvrId: 'nvr-A', sessionId: 'a2' }))
    c.acquire(req({ nvrId: 'nvr-B', sessionId: 'b1' }))
    c.acquire(req({ nvrId: 'nvr-B', sessionId: 'b2' }))
    c.release({ nvrId: 'nvr-A', sessionId: 'a1', reason: 'close' })
    expect(c.hasLease('nvr-A', 'a2')).toBe(true)
    expect(c.queuedCount('nvr-B')).toBe(1)      // intacta
    expect(c.hasLease('nvr-B', 'b1')).toBe(true)
  })

  it('18. resetAll limpia colas y leases sin dejar estado falso', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB' }))
    c.resetAll()
    expect(c.activeCount('nvr-A')).toBe(0)
    expect(c.queuedCount('nvr-A')).toBe(0)
    expect(c.snapshot()).toHaveLength(0)
    // Tras el reinicio, la primera solicitud vuelve a obtener cupo.
    expect(c.acquire(req({ sessionId: 'sNuevo' })).granted).toBe(true)
  })
})

describe('detección de 453 y clasificación', () => {
  it('6/7/8/9 — la categoría de capacidad se reconoce y no es de codec', () => {
    expect(isNvrCapacityCategory('NVR_BANDWIDTH_OR_SESSION_LIMIT')).toBe(true)
    expect(isNvrCapacityCategory('CODEC_UNSUPPORTED')).toBe(false)
    expect(isNvrCapacityCategory('AUDIO_STREAM_INVALID')).toBe(false)
    expect(isNvrCapacityCategory(null)).toBe(false)
  })
  it('stderrIndicates453 reconoce el 453 real del NVR', () => {
    expect(stderrIndicates453('RTSP/1.0 453 Not Enough Bandwidth')).toBe(true)
    expect(stderrIndicates453('method DESCRIBE failed: 453')).toBe(true)
    expect(stderrIndicates453('Not enough bandwidth')).toBe(true)
    expect(stderrIndicates453('Server returned 4XX Client Error')).toBe(false)
    expect(stderrIndicates453(null)).toBe(false)
  })
})

describe('snapshot de diagnóstico', () => {
  it('expone leases activos y cola sin datos sensibles', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA', cameraId: 'camA', cameraName: 'Box 4', userId: 'u1' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.attachProcess({ nvrId: 'nvr-A', sessionId: 'sA', pid: 4242, alive: true })
    c.acquire(req({ sessionId: 'sB', cameraId: 'camB', cameraName: 'Pasillo', slotIndex: 1 }))

    const snap = c.snapshot()
    expect(snap).toHaveLength(1)
    const n = snap[0]
    expect(n.nvrId).toBe('nvr-A')
    expect(n.activeCount).toBe(1)
    expect(n.queuedCount).toBe(1)
    expect(n.active[0]).toMatchObject({ sessionId: 'sA', cameraName: 'Box 4', pid: 4242, processAlive: true })
    expect(n.active[0].firstByteAt).not.toBeNull()
    expect(n.queue[0]).toMatchObject({ sessionId: 'sB', position: 1 })
    // Nunca expone credenciales ni URI.
    const json = JSON.stringify(snap)
    expect(json).not.toMatch(/rtsp:|password|token/i)
  })

  it('omite NVR sin actividad', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.effectiveLimitFor('nvr-vacio')
    expect(c.snapshot()).toHaveLength(0)
  })
})

// ─── Codex #143: reservas no consumidas, FIFO tras cooldown, readiness ───────

describe('Codex #143 P1 — expiración de reservas concedidas y nunca consumidas', () => {
  it('libera el lease que nunca abrió stream y promueve la cola', () => {
    const { c, clock } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sFantasma' }))       // /preview/start OK…
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 })) // …pero nunca pide /stream
    expect(c.queuedCount('nvr-A')).toBe(1)

    clock.advance(10_000)
    expect(c.expireUnconsumedLeases(45_000)).toHaveLength(0)   // aún dentro del plazo

    clock.advance(40_000)
    const expired = c.expireUnconsumedLeases(45_000)
    expect(expired).toHaveLength(1)
    expect(expired[0].sessionId).toBe('sFantasma')
    expect(expired[0].promoted.map(p => p.sessionId)).toEqual(['sB'])
    expect(c.hasLease('nvr-A', 'sB')).toBe(true)
    expect(c.hasLease('nvr-A', 'sFantasma')).toBe(false)
  })

  it('NO expira una reserva ya consumida (el stream se abrió)', () => {
    const { c, clock } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markConsumed({ nvrId: 'nvr-A', sessionId: 'sA' })
    clock.advance(10 * 60_000)
    expect(c.expireUnconsumedLeases(45_000)).toHaveLength(0)
    expect(c.hasLease('nvr-A', 'sA')).toBe(true)
  })

  it('NO expira una sesión que ya emitió primer byte aunque no se marcara consumida', () => {
    const { c, clock } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    clock.advance(10 * 60_000)
    expect(c.expireUnconsumedLeases(45_000)).toHaveLength(0)
  })
})

describe('Codex #143 P2 — la recuperación de capacidad promueve la cola (FIFO)', () => {
  it('tras el cooldown se promueve la cola existente, sin que una nueva se cuele', () => {
    const { c, clock } = ctl({ globalDefault: 2, cooldownMs: 60_000 })
    // sA reproduce bien; sB recibe 453 ⇒ límite temporal 1.
    c.acquire(req({ sessionId: 'sA' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))
    c.report453({ nvrId: 'nvr-A', sessionId: 'sB' })
    expect(c.effectiveLimitFor('nvr-A')).toBe(1)

    // Liberar el lease fallido deja a sC esperando detrás del sano.
    c.release({ nvrId: 'nvr-A', sessionId: 'sB', reason: 'close' })
    c.acquire(req({ sessionId: 'sC', slotIndex: 2 }))
    expect(c.queuedCount('nvr-A')).toBe(1)

    // Vencido el cooldown, la reconciliación promueve a sC de inmediato.
    clock.advance(61_000)
    const promoted = c.reconcile('nvr-A')
    expect(promoted.map(p => p.sessionId)).toEqual(['sC'])
    expect(c.hasLease('nvr-A', 'sC')).toBe(true)
    expect(c.queuedCount('nvr-A')).toBe(0)
  })

  it('una solicitud NUEVA no se salta el FIFO cuando el cooldown ya venció', () => {
    const { c, clock } = ctl({ globalDefault: 2, cooldownMs: 60_000 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))
    c.report453({ nvrId: 'nvr-A', sessionId: 'sB' })
    c.release({ nvrId: 'nvr-A', sessionId: 'sB', reason: 'close' })
    c.acquire(req({ sessionId: 'sViejo', slotIndex: 2 }))   // espera desde antes
    expect(c.queuedCount('nvr-A')).toBe(1)

    clock.advance(61_000)
    // La recién llegada NO debe quedarse con el cupo recuperado.
    const nueva = c.acquire(req({ sessionId: 'sNueva', slotIndex: 3 }))
    expect(c.hasLease('nvr-A', 'sViejo')).toBe(true)   // el que esperaba, primero
    expect(nueva.granted).toBe(false)
    expect(nueva.queued).toBe(true)
  })

  it('reconcileAll cubre todos los NVR conocidos', () => {
    const { c, clock } = ctl({ globalDefault: 2, cooldownMs: 60_000 })
    for (const nvrId of ['nvr-A', 'nvr-B']) {
      c.acquire(req({ nvrId, sessionId: `${nvrId}-1` }))
      c.markFirstByte({ nvrId, sessionId: `${nvrId}-1` })
      c.report453({ nvrId })
      c.acquire(req({ nvrId, sessionId: `${nvrId}-2` }))
    }
    clock.advance(61_000)
    const all = c.reconcileAll()
    expect(all).toHaveLength(2)
    expect(c.hasLease('nvr-A', 'nvr-A-2')).toBe(true)
    expect(c.hasLease('nvr-B', 'nvr-B-2')).toBe(true)
  })
})

// ─── Codex sobre 50f2bd3: ciclo de vida del lease ────────────────────────────

describe('P1 — TERMINATING sigue ocupando capacidad', () => {
  it('un lease en cierre NO libera el cupo ni promueve la cola', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markConsumed({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))

    // Empieza el cierre de A: el proceso sigue vivo (SIGTERM / kill grace).
    expect(c.markTerminating({ nvrId: 'nvr-A', sessionId: 'sA' })).toBe(true)
    expect(c.leaseState('nvr-A', 'sA')).toBe('terminating')
    expect(c.terminatingCount('nvr-A')).toBe(1)
    // B DEBE seguir en cola mientras A esté vivo.
    expect(c.activeCount('nvr-A')).toBe(1)
    expect(c.hasLease('nvr-A', 'sB')).toBe(false)
    expect(c.queuedCount('nvr-A')).toBe(1)
    // Reconciliar no puede colar a B mientras A ocupa el cupo.
    expect(c.reconcile('nvr-A')).toHaveLength(0)
    expect(c.hasLease('nvr-A', 'sB')).toBe(false)

    // Recién tras la salida REAL se libera y se promueve.
    const r = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'exit_confirmed' })
    expect(r.released).toBe(true)
    expect(r.promoted.map(p => p.sessionId)).toEqual(['sB'])
  })

  it('un lease TERMINATING nunca es expirado por el barrido de reservas', () => {
    const { c, clock } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markTerminating({ nvrId: 'nvr-A', sessionId: 'sA' })
    clock.advance(10 * 60_000)
    expect(c.expireUnconsumedLeases(45_000)).toHaveLength(0)
    expect(c.hasLease('nvr-A', 'sA')).toBe(true)
  })

  it('TERMINATING_STUCK conserva el cupo hasta la liberación posterior', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))
    c.markTerminating({ nvrId: 'nvr-A', sessionId: 'sA', stuck: true })
    expect(c.leaseState('nvr-A', 'sA')).toBe('terminating_stuck')
    expect(c.reconcile('nvr-A')).toHaveLength(0)
    expect(c.queuedCount('nvr-A')).toBe(1)
    // El barrido detecta la salida y libera UNA sola vez.
    const r1 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'after_stuck' })
    const r2 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'after_stuck' })
    expect(r1.promoted).toHaveLength(1)
    expect(r2.released).toBe(false)
    expect(r2.promoted).toHaveLength(0)
  })

  it('el fallback A/V → video-only no abre ventana para robar el cupo', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markConsumed({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.acquire(req({ sessionId: 'sOtro', slotIndex: 1 }))
    // El relanzamiento video-only reutiliza la MISMA sesión: sigue con su lease.
    expect(c.acquire(req({ sessionId: 'sA' })).granted).toBe(true)
    expect(c.hasLease('nvr-A', 'sOtro')).toBe(false)
    expect(c.activeCount('nvr-A')).toBe(1)
  })
})

describe('P2 — leases de diagnóstico', () => {
  it('el diagnóstico se marca consumido y NO expira a los 45 s', () => {
    const { c, clock } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'diag_1', slotIndex: -1, leaseType: 'diagnostic' }))
    c.markConsumed({ nvrId: 'nvr-A', sessionId: 'diag_1', leaseType: 'diagnostic' })
    expect(c.leaseTypeOf('nvr-A', 'diag_1')).toBe('diagnostic')

    clock.advance(120_000)                       // dura más de 45 s
    expect(c.expireUnconsumedLeases(45_000)).toHaveLength(0)
    expect(c.hasLease('nvr-A', 'diag_1')).toBe(true)
  })

  it('una preview del mismo NVR permanece en cola mientras corre el diagnóstico', () => {
    const { c, clock } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'diag_1', slotIndex: -1, leaseType: 'diagnostic' }))
    c.markConsumed({ nvrId: 'nvr-A', sessionId: 'diag_1', leaseType: 'diagnostic' })
    const prev = c.acquire(req({ sessionId: 'sPrev' }))
    expect(prev.queued).toBe(true)

    clock.advance(120_000)
    c.expireUnconsumedLeases(45_000)
    expect(c.hasLease('nvr-A', 'sPrev')).toBe(false)   // sigue esperando

    // Al terminar el diagnóstico se libera y promueve.
    const r = c.release({ nvrId: 'nvr-A', sessionId: 'diag_1', reason: 'diagnostics_done' })
    expect(r.promoted.map(p => p.sessionId)).toEqual(['sPrev'])
  })

  it('un diagnóstico aún EN COLA puede cancelarse normalmente', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    const d = c.acquire(req({ sessionId: 'diag_2', slotIndex: -1, leaseType: 'diagnostic' }))
    expect(d.queued).toBe(true)
    expect(c.cancelQueued({ nvrId: 'nvr-A', sessionId: 'diag_2', reason: 'diagnostics_no_capacity' })).toBe(true)
    expect(c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'close' }).promoted).toHaveLength(0)
  })

  it('el snapshot expone leaseType, consumed, state y terminating', () => {
    const { c } = ctl({ globalDefault: 2 })
    c.acquire(req({ sessionId: 'sA' }))
    c.markFirstByte({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.acquire(req({ sessionId: 'diag_1', slotIndex: -1, leaseType: 'diagnostic' }))
    c.markConsumed({ nvrId: 'nvr-A', sessionId: 'diag_1', leaseType: 'diagnostic' })
    c.markTerminating({ nvrId: 'nvr-A', sessionId: 'diag_1' })

    const active = c.snapshot()[0].active
    const a = active.find(x => x.sessionId === 'sA')!
    const d = active.find(x => x.sessionId === 'diag_1')!
    expect(a).toMatchObject({ leaseType: 'preview', consumed: true, state: 'active', terminating: false })
    expect(d).toMatchObject({ leaseType: 'diagnostic', consumed: true, state: 'terminating', terminating: true })
  })
})

describe('aislamiento con leases en cierre', () => {
  it('un TERMINATING en un NVR no bloquea a otro NVR', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ nvrId: 'nvr-A', sessionId: 'a1' }))
    c.markTerminating({ nvrId: 'nvr-A', sessionId: 'a1' })
    expect(c.acquire(req({ nvrId: 'nvr-B', sessionId: 'b1' })).granted).toBe(true)
  })
  it('nunca se supera el límite efectivo contando los TERMINATING', () => {
    const { c } = ctl({ globalDefault: 2 })
    c.acquire(req({ sessionId: 's1' }))
    c.acquire(req({ sessionId: 's2' }))
    c.markTerminating({ nvrId: 'nvr-A', sessionId: 's1' })
    expect(c.acquire(req({ sessionId: 's3' })).queued).toBe(true)
    expect(c.activeCount('nvr-A')).toBe(2)
  })
})

// ─── Codex #144 (2ª ronda): TODA ruta de cierre espera la salida ─────────────

describe('P1 — el cupo no se suelta mientras el proceso siga vivo, venga de donde venga', () => {
  // Simula el helper releasePlaybackLeaseAfterExit del route: marca TERMINATING
  // y sólo libera cuando el registry confirma la salida. Se ejercita el
  // invariante para las rutas que ANTES liberaban de inmediato:
  // desconexión del cliente y presupuesto de arranque agotado.
  const teardownWithLiveProcess = (
    c: NvrPlaybackAdmissionController, sessionId: string, reason: string,
  ) => {
    c.markTerminating({ nvrId: 'nvr-A', sessionId })
    return {
      confirmExit: () => c.release({ nvrId: 'nvr-A', sessionId, reason }),
    }
  }

  for (const reason of ['client_disconnect', 'request_error', 'startup_budget_exhausted', 'watchdog']) {
    it(`cierre por ${reason}: la cola NO se promueve hasta la salida real`, () => {
      const { c } = ctl({ globalDefault: 1 })
      c.acquire(req({ sessionId: 'sA' }))
      c.markConsumed({ nvrId: 'nvr-A', sessionId: 'sA' })
      c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))

      const t = teardownWithLiveProcess(c, 'sA', reason)
      // Mientras el FFmpeg vive, el cupo sigue tomado y B espera.
      expect(c.leaseState('nvr-A', 'sA')).toBe('terminating')
      expect(c.activeCount('nvr-A')).toBe(1)
      expect(c.hasLease('nvr-A', 'sB')).toBe(false)
      expect(c.reconcile('nvr-A')).toHaveLength(0)

      // Confirmada la salida, se libera y se promueve exactamente una vez.
      const r = t.confirmExit()
      expect(r.released).toBe(true)
      expect(r.promoted.map(p => p.sessionId)).toEqual(['sB'])
      expect(c.hasLease('nvr-A', 'sB')).toBe(true)
    })
  }

  it('cierres concurrentes por varias rutas liberan y promueven una sola vez', () => {
    const { c } = ctl({ globalDefault: 1 })
    c.acquire(req({ sessionId: 'sA' }))
    c.acquire(req({ sessionId: 'sB', slotIndex: 1 }))
    // DELETE + client_disconnect + watchdog compiten por cerrar la misma sesión.
    c.markTerminating({ nvrId: 'nvr-A', sessionId: 'sA' })
    c.markTerminating({ nvrId: 'nvr-A', sessionId: 'sA' })
    const r1 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'delete_endpoint' })
    const r2 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'client_disconnect' })
    const r3 = c.release({ nvrId: 'nvr-A', sessionId: 'sA', reason: 'watchdog' })
    expect([r1, r2, r3].filter(r => r.released)).toHaveLength(1)
    expect([r1, r2, r3].flatMap(r => r.promoted)).toHaveLength(1)
    expect(c.activeCount('nvr-A')).toBe(1)   // sólo sB
  })
})
