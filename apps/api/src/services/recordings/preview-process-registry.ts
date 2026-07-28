// Registro de procesos FFmpeg por sesión de preview.
//
// P1 confirmado en producción: una MISMA sessionId podía tener DOS FFmpeg vivos.
// Dos `GET /preview/:sessionId/stream` concurrentes arrancaban cada uno su FFmpeg
// y la sesión sólo recordaba `vodProcess` (un único slot): el primer proceso
// quedaba huérfano e inalcanzable (ni DELETE, ni cierre de socket, ni el sweep de
// TTL podían matarlo) y seguía vivo hasta un SIGKILL manual (elapsedMs≈1.046.819).
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
// real de Node la cumple estructuralmente; en tests se usa un doble.
export interface ManagedProc {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals | number): boolean
}

// Vivo = aún no salió (ni por código ni por señal). En Node `killed` se vuelve true
// apenas se ENVÍA la señal (no cuando termina), así que NO sirve para "sigue vivo".
export const isProcAlive = (p: ManagedProc): boolean =>
  p.exitCode === null && p.signalCode === null

export interface AttemptRecord {
  attemptId: string
  proc: ManagedProc
  pid: number | undefined
  spawnedAt: number
}

// Un registro por sesión de preview. attemptId monótono; el proceso se da de alta
// al hacer spawn y de baja en su `close` definitivo (stdout drenado).
export class PreviewProcessRegistry {
  private children = new Map<string, AttemptRecord>()
  private seq = 0

  // (9) Alta de un intento: attemptId único + pid. Devuelve el attemptId.
  register(proc: ManagedProc, now: number): AttemptRecord {
    const attemptId = String(++this.seq)
    const rec: AttemptRecord = { attemptId, proc, pid: proc.pid, spawnedAt: now }
    this.children.set(attemptId, rec)
    return rec
  }

  // Baja de un intento (en su `close`). Idempotente.
  unregister(attemptId: string): void {
    this.children.delete(attemptId)
  }

  has(attemptId: string): boolean { return this.children.has(attemptId) }
  get size(): number { return this.children.size }
  list(): AttemptRecord[] { return [...this.children.values()] }

  // (11/12) ¿Cuántos hijos siguen vivos (sin confirmar salida)?
  aliveCount(): number {
    let n = 0
    for (const rec of this.children.values()) if (isProcAlive(rec.proc)) n++
    return n
  }

  // (10) Tomar el control: SIGTERM a TODOS los intentos vivos. El caller programa
  // el SIGKILL de gracia (temporizador Node) y espera la confirmación de salida.
  // Devuelve los intentos que seguían vivos (pendientes de confirmar su `close`).
  terminateAll(onSigterm?: (rec: AttemptRecord) => void): AttemptRecord[] {
    const pending: AttemptRecord[] = []
    for (const rec of this.children.values()) {
      if (!isProcAlive(rec.proc)) continue
      pending.push(rec)
      onSigterm?.(rec)
      try { rec.proc.kill('SIGTERM') } catch { /* ya muerto */ }
    }
    return pending
  }

  // SIGKILL a un intento concreto si sigue vivo tras la gracia (escalado).
  sigkillIfAlive(attemptId: string, onKill?: (rec: AttemptRecord) => void): void {
    const rec = this.children.get(attemptId)
    if (!rec || !isProcAlive(rec.proc)) return
    onKill?.(rec)
    try { rec.proc.kill('SIGKILL') } catch { /* ya muerto */ }
  }

  // (15) Reaper de huérfanos: un intento vivo que ya NO es el proceso activo
  // (superado por un takeover) y lleva más de `ageMs` sin salir → SIGKILL. Red de
  // seguridad independiente del JWT y del ciclo de la request.
  reapOrphans(
    activeProc: ManagedProc | undefined,
    now: number,
    ageMs: number,
    onKill: (rec: AttemptRecord) => void,
  ): AttemptRecord[] {
    const reaped: AttemptRecord[] = []
    for (const rec of this.children.values()) {
      if (isProcAlive(rec.proc) && rec.proc !== activeProc && now - rec.spawnedAt > ageMs) {
        reaped.push(rec)
        onKill(rec)
        try { rec.proc.kill('SIGKILL') } catch { /* ya muerto */ }
      }
    }
    return reaped
  }
}
