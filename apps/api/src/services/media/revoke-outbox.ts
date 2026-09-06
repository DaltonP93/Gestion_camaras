// apps/api/src/services/media/revoke-outbox.ts
//
// C23·H2·P2 — OUTBOX DURABLE e idempotente de revocación de medios. Sustituye al
// Set en-proceso `pendingUserRevokes` como ÚNICA fuente: la durabilidad vive en
// Postgres, así que la intención de revocar (logout / cambio de permisos)
// SOBREVIVE a un reinicio del API mientras Redis está caído.
//
//   - `enqueue`: registra DURABLEMENTE una fila (userId, requestedAt) ANTES/
//     independiente de tocar Redis. Nunca guarda grants, secretos ni tokens.
//   - `hasPending`: ¿hay deuda de revocación sin aplicar para el usuario? El relay
//     lo consulta para FALLAR CERRADO mientras exista deuda.
//   - `drain`: un worker idempotente aplica el bump de epoch (callback `apply`) y
//     marca `appliedAt`. TOMA ATÓMICA para soportar >1 worker sin doble
//     procesamiento destructivo: Postgres usa `FOR UPDATE SKIP LOCKED`; la impl en
//     memoria marca la fila "en proceso" de forma síncrona (event loop de un solo
//     hilo) antes de cualquier await.
//
// La impl Postgres es CÓDIGO REAL (usada en producción vía server.prisma). Su
// atomicidad `FOR UPDATE SKIP LOCKED` está VALIDADA contra Postgres efímero real en
// `revoke-outbox.pg.int.test.ts` (dos drenajes concurrentes toman filas distintas;
// mutar SKIP LOCKED → el test falla por bloqueo). La interfaz durable y el
// comportamiento idempotente/fail-closed también se validan con la impl en memoria
// y con Redis REAL (`revoke-outbox.int.test.ts`).

export interface MediaRevokeOutboxRepo {
  /** Registra DURABLEMENTE la intención de revocar (una fila por intención). */
  enqueue(userId: string): Promise<void>
  /** ¿Existe deuda de revocación SIN aplicar para el usuario? (fail-closed). */
  hasPending(userId: string): Promise<boolean>
  /** Usuarios con al menos una fila pendiente (para el drenaje / diagnóstico). */
  pendingUserIds(): Promise<string[]>
  /**
   * Drena las filas pendientes aplicando `apply(userId)` (bump de epoch). Marca
   * `appliedAt` SÓLO si `apply` resuelve true; si falla (p.ej. Redis aún caído),
   * la fila queda pendiente para el próximo disparo. Toma atómica ⇒ dos workers
   * no aplican la misma fila. Devuelve cuántas filas se marcaron aplicadas.
   */
  drain(apply: (userId: string) => Promise<boolean>): Promise<number>
}

// ─── impl en memoria (única fuente en tests sin Postgres) ────────────
interface MemRow { id: number; userId: string; appliedAt: number | null; attempts: number; claiming: boolean }

export class InMemoryMediaRevokeOutbox implements MediaRevokeOutboxRepo {
  private rows: MemRow[] = []
  private seq = 0

  async enqueue(userId: string): Promise<void> {
    this.rows.push({ id: ++this.seq, userId, appliedAt: null, attempts: 0, claiming: false })
  }
  async hasPending(userId: string): Promise<boolean> {
    return this.rows.some((r) => r.userId === userId && r.appliedAt === null)
  }
  async pendingUserIds(): Promise<string[]> {
    return [...new Set(this.rows.filter((r) => r.appliedAt === null).map((r) => r.userId))]
  }
  /** Conteo síncrono de USUARIOS con deuda pendiente (para el helper de pruebas). */
  pendingCountSync(): number { return new Set(this.rows.filter((r) => r.appliedAt === null).map((r) => r.userId)).size }

  async drain(apply: (userId: string) => Promise<boolean>): Promise<number> {
    // TOMA ATÓMICA (equivalente a SKIP LOCKED): marcamos "en proceso" de forma
    // SÍNCRONA (sin await intermedio) antes de aplicar, de modo que un drenaje
    // concurrente en el mismo proceso NO tome las mismas filas.
    const claimed = this.rows.filter((r) => r.appliedAt === null && !r.claiming)
    for (const r of claimed) r.claiming = true
    let applied = 0
    for (const r of claimed) {
      r.attempts++
      let ok = false
      try { ok = await apply(r.userId) } catch { ok = false }
      if (ok) { r.appliedAt = Date.now(); applied++ }
      r.claiming = false  // aplicada o no: liberar (si falló, reintenta el próximo drenaje)
    }
    return applied
  }
}

// ─── impl Postgres (durable, real; SKIP LOCKED VALIDADO en test) ─
/** Subconjunto estructural del PrismaClient que usa el outbox. */
export interface PrismaOutboxClient {
  mediaRevokeOutbox: {
    create(args: { data: { userId: string } }): Promise<unknown>
    count(args: { where: { userId?: string; appliedAt: null } }): Promise<number>
    findMany(args: { where: { appliedAt: null }; select: { userId: true }; distinct: ['userId'] }): Promise<{ userId: string }[]>
  }
  $transaction<T>(fn: (tx: PrismaOutboxTx) => Promise<T>): Promise<T>
}
export interface PrismaOutboxTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

export class PrismaMediaRevokeOutbox implements MediaRevokeOutboxRepo {
  constructor(private readonly prisma: PrismaOutboxClient) {}

  async enqueue(userId: string): Promise<void> {
    await this.prisma.mediaRevokeOutbox.create({ data: { userId } })
  }
  async hasPending(userId: string): Promise<boolean> {
    return (await this.prisma.mediaRevokeOutbox.count({ where: { userId, appliedAt: null } })) > 0
  }
  async pendingUserIds(): Promise<string[]> {
    const rows = await this.prisma.mediaRevokeOutbox.findMany({ where: { appliedAt: null }, select: { userId: true }, distinct: ['userId'] })
    return rows.map((r) => r.userId)
  }
  async drain(apply: (userId: string) => Promise<boolean>): Promise<number> {
    let applied = 0
    // Una fila por transacción: se TOMA con FOR UPDATE SKIP LOCKED (dos workers no
    // toman la misma), se aplica el bump DENTRO del lock (idempotente aunque se
    // repita) y se marca appliedAt en la misma transacción. Si el apply falla,
    // se corta el drenaje (Redis aún caído): las filas quedan pendientes.
    for (;;) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; userId: string }[]>`
          SELECT "id", "userId" FROM "media_revoke_outbox"
          WHERE "appliedAt" IS NULL ORDER BY "requestedAt" ASC
          FOR UPDATE SKIP LOCKED LIMIT 1`
        if (rows.length === 0) return 'empty' as const
        const row = rows[0]
        let ok = false
        try { ok = await apply(row.userId) } catch { ok = false }
        if (ok) {
          await tx.$executeRaw`UPDATE "media_revoke_outbox" SET "appliedAt" = CURRENT_TIMESTAMP, "attempts" = "attempts" + 1 WHERE "id" = ${row.id}`
          return 'applied' as const
        }
        await tx.$executeRaw`UPDATE "media_revoke_outbox" SET "attempts" = "attempts" + 1 WHERE "id" = ${row.id}`
        return 'failed' as const
      })
      if (outcome === 'applied') { applied++; continue }
      break  // 'empty' (nada pendiente) o 'failed' (backend caído): parar
    }
    return applied
  }
}
