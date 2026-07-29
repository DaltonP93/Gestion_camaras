// Registro de procesos FFmpeg por sesión de preview.
//
// P1 confirmado en producción: una MISMA sessionId podía tener DOS FFmpeg vivos.
// Dos `GET /preview/:sessionId/stream` concurrentes arrancaban cada uno su FFmpeg
// y la sesión sólo recordaba `vodProcess` (un único slot): el primer proceso
// quedaba huérfano e inalcanzable (ni DELETE, ni cierre de socket, ni el sweep de
// TTL podían matarlo) y seguía vivo hasta un SIGKILL manual (elapsedMs≈1.046.819).
//
// Endurecimiento (follow-up): la SALIDA REAL de un proceso se confirma EXCLUSIVAMENTE
// por su evento exit/close (markExited) — NUNCA por signalCode tras enviar kill (que
// en Node no prueba que el proceso haya terminado). El takeover sólo puede arrancar
// otro FFmpeg cuando aliveCount()===0 tras observar esa salida real; si no, el route
// aplica un hard gate (PREVIOUS_FFMPEG_NOT_REAPED) y NO spawnea.
//
// Este módulo es PURO y testeable (sin depender de child_process real): modela el
// conjunto de intentos (attempts) de una sesión con un id único por intento, para
//   (9)  asociar cada ejecución a attemptId + pid;
//   (10) tomar el control (terminar el intento anterior) antes de aceptar otro GET;
//   (11) mantener el registro de TODOS los hijos, no sólo el actual;
//   (12) confirmar en el cierre que no quedan procesos vivos, o marcar pendiente;
//   (13) que el cierre tardío de un intento viejo no toque el intento nuevo;
//   (15) reapear huérfanos (vivos pero superados) como red de seguridad.

// Superficie mínima de un ChildProcess que necesita el registro. Un ChildProcess
// real de Node la cumple estructuralmente; en tests se usa un doble. Deliberadamente
// NO expone exitCode/signalCode: la vida/muerte se rastrea con el flag `exited`,
// puesto SÓLO por markExited desde el evento exit/close real (req 4).
export interface ManagedProc {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface AttemptRecord {
  attemptId: string
  proc: ManagedProc
  pid: number | undefined
  spawnedAt: number
  // ── Estado de terminación idempotente por intento (req 3) ──
  terminating: boolean
  terminationReason: string | null
  sigtermSent: boolean
  sigkillTimer: ReturnType<typeof setTimeout> | null
  // exited = salida REAL observada (exit/close). reaped = dado de baja del registro.
  exited: boolean
  reaped: boolean
  // Resuelve cuando se observa la salida REAL (markExited). Permite esperar de
  // forma acotada la toma de control sin sondear señales artificiales.
  terminationPromise: Promise<void>
  resolveTermination: () => void
}

export interface TerminateHooks {
  onSigterm?: (rec: AttemptRecord) => void
  onSigkill?: (rec: AttemptRecord) => void
}

// Un registro por sesión de preview. attemptId monótono; el proceso se da de alta
// al hacer spawn, marca su salida en exit/close (markExited) y se da de baja en el
// `close` definitivo (unregister).
export class PreviewProcessRegistry {
  private children = new Map<string, AttemptRecord>()
  private seq = 0
  private readonly graceMs: number

  constructor(opts?: { graceMs?: number }) {
    this.graceMs = Math.max(1, opts?.graceMs ?? 2_000)
  }

  // (9) Alta de un intento: attemptId único + pid. Devuelve el registro.
  register(proc: ManagedProc, now: number): AttemptRecord {
    const attemptId = String(++this.seq)
    let resolveTermination!: () => void
    const terminationPromise = new Promise<void>((resolve) => { resolveTermination = resolve })
    const rec: AttemptRecord = {
      attemptId, proc, pid: proc.pid, spawnedAt: now,
      terminating: false, terminationReason: null, sigtermSent: false, sigkillTimer: null,
      exited: false, reaped: false, terminationPromise, resolveTermination,
    }
    this.children.set(attemptId, rec)
    return rec
  }

  // (4) Confirmación de SALIDA REAL — se llama desde el evento exit/close del proceso.
  // Idempotente: cancela el timer de SIGKILL pendiente y resuelve la promesa.
  markExited(attemptId: string): void {
    const rec = this.children.get(attemptId)
    if (!rec || rec.exited) return
    rec.exited = true
    if (rec.sigkillTimer) { clearTimeout(rec.sigkillTimer); rec.sigkillTimer = null }
    rec.resolveTermination()
  }

  // Baja del registro (en el `close` definitivo). Implica salida real si aún no se
  // había marcado. Idempotente.
  unregister(attemptId: string): void {
    const rec = this.children.get(attemptId)
    if (!rec) return
    if (!rec.exited) this.markExited(attemptId)
    rec.reaped = true
    this.children.delete(attemptId)
  }

  has(attemptId: string): boolean { return this.children.has(attemptId) }
  get size(): number { return this.children.size }
  list(): AttemptRecord[] { return [...this.children.values()] }

  // (2/11/12) ¿Cuántos hijos NO han confirmado su salida real todavía? Basado en el
  // flag `exited` (markExited), nunca en signalCode.
  aliveCount(): number {
    let n = 0
    for (const rec of this.children.values()) if (!rec.exited) n++
    return n
  }

  // (3) Terminación IDEMPOTENTE de un intento: una sola secuencia
  // SIGTERM → gracia → SIGKILL → (exit/close). Llamadas repetidas (takeover,
  // DELETE, close, error) reutilizan la misma secuencia y promesa; no reenvían
  // SIGTERM ni programan un segundo timer de SIGKILL. Resuelve con la salida real.
  terminate(attemptId: string, reason: string, hooks?: TerminateHooks): Promise<void> {
    const rec = this.children.get(attemptId)
    if (!rec) return Promise.resolve()
    if (rec.exited) return Promise.resolve()
    if (rec.terminating) return rec.terminationPromise
    rec.terminating = true
    rec.terminationReason = reason
    rec.sigtermSent = true
    hooks?.onSigterm?.(rec)
    try { rec.proc.kill('SIGTERM') } catch { /* ya muerto */ }
    rec.sigkillTimer = setTimeout(() => {
      rec.sigkillTimer = null
      if (rec.exited) return                       // salió durante la gracia
      hooks?.onSigkill?.(rec)
      try { rec.proc.kill('SIGKILL') } catch { /* ya muerto */ }
      // NO se marca exited aquí: sólo el evento exit/close real lo confirma (req 4).
    }, this.graceMs)
    if (typeof rec.sigkillTimer.unref === 'function') rec.sigkillTimer.unref()
    return rec.terminationPromise
  }

  // (10) Tomar el control: terminar TODOS los intentos vivos (idempotente). Devuelve
  // una promesa que resuelve cuando TODOS confirmaron su salida real.
  terminateAll(reason: string, hooks?: TerminateHooks): Promise<void> {
    const ps: Promise<void>[] = []
    for (const rec of this.children.values()) {
      if (!rec.exited) ps.push(this.terminate(rec.attemptId, reason, hooks))
    }
    return Promise.all(ps).then(() => undefined)
  }

  // (1/2) Espera ACOTADA a que todos los intentos vivos confirmen su salida real.
  // Devuelve true si quedaron 0 vivos; false si venció `timeoutMs` con vivos (→ el
  // route aplica el hard gate y NO spawnea otro FFmpeg).
  async waitAllExited(timeoutMs: number): Promise<boolean> {
    const alive = this.list().filter((r) => !r.exited)
    if (alive.length === 0) return true
    const all = Promise.all(alive.map((r) => r.terminationPromise)).then(() => undefined)
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(0, timeoutMs))
      if (typeof t.unref === 'function') t.unref()
    })
    await Promise.race([all, timeout])
    return this.aliveCount() === 0
  }

  // (15) Reaper de huérfanos: un intento vivo que ya NO es el proceso activo
  // (superado por un takeover) y lleva más de `ageMs` sin salir → terminar. Red de
  // seguridad independiente del JWT y del ciclo de la request.
  reapOrphans(
    activeProc: ManagedProc | undefined,
    now: number,
    ageMs: number,
    reason: string,
    hooks?: TerminateHooks,
  ): AttemptRecord[] {
    const reaped: AttemptRecord[] = []
    for (const rec of this.children.values()) {
      if (!rec.exited && rec.proc !== activeProc && now - rec.spawnedAt > ageMs) {
        reaped.push(rec)
        this.terminate(rec.attemptId, reason, hooks)
      }
    }
    return reaped
  }
}
