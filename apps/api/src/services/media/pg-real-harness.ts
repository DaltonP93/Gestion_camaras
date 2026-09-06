// apps/api/src/services/media/pg-real-harness.ts
//
// Helper de INTEGRACIÓN con PostgreSQL REAL y EFÍMERO para validar la atomicidad
// `FOR UPDATE SKIP LOCKED` de `PrismaMediaRevokeOutbox` (C23·H2·P2). NUNCA apunta a
// una base remota ni de producción: exige `DATABASE_URL_TEST`, que en CI provee el
// `services: postgres` del job y en dev un Postgres desechable (p. ej. docker).
//
// AISLAMIENTO: cada corrida crea un SCHEMA único (`t_<rand>`) y fija
// `?schema=…` en la URL, de modo que la tabla `media_revoke_outbox` (nombre no
// calificado que usa el SQL de la clase) resuelva ahí; al terminar hace
// `DROP SCHEMA … CASCADE`. Suites concurrentes no se pisan.
//
// FIDELIDAD: se ejerce la CLASE REAL `PrismaMediaRevokeOutbox`. Su `drain` usa
// `$transaction` + `$queryRaw`/`$executeRaw` (incluido el `FOR UPDATE SKIP LOCKED`
// real) contra este Postgres real. Los tres métodos CRUD del delegate
// (`create/count/findMany`) se implementan aquí con SQL crudo, para no depender de
// la regeneración del cliente Prisma (irrelevante para la garantía de locking).

import { PrismaClient } from '@prisma/client'
import type { PrismaOutboxClient, PrismaOutboxTx } from './revoke-outbox'

const TEST_URL = process.env.DATABASE_URL_TEST

export function pgAvailable(): boolean {
  return !!TEST_URL
}

/** Postgres obligatorio en CI: si el entorno lo exige (`REQUIRE_REAL_PG=1`) y no
 *  hay `DATABASE_URL_TEST`, se LANZA para que la suite FALLE, nunca se omita en silencio. */
export function assertPgRequiredOrSkip(): boolean {
  const have = pgAvailable()
  if (!have && process.env.REQUIRE_REAL_PG === '1') {
    throw new Error('REQUIRE_REAL_PG=1 pero no hay DATABASE_URL_TEST (Postgres efímero real). CI no puede omitir esta suite.')
  }
  return have
}

const CREATE_TABLE = `
  CREATE TABLE "media_revoke_outbox" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt"   TIMESTAMP(3),
    "attempts"    INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "media_revoke_outbox_pkey" PRIMARY KEY ("id")
  )`

let cuidSeq = 0
function genId(): string { return `r${Date.now().toString(36)}${(cuidSeq++).toString(36)}${Math.random().toString(36).slice(2, 8)}` }

/** Adapter `PrismaOutboxClient` sobre un PrismaClient real: los CRUD via SQL crudo,
 *  `$transaction` delega en el interactivo REAL (tx real ⇒ SKIP LOCKED real). */
function outboxAdapter(prisma: PrismaClient): PrismaOutboxClient {
  return {
    mediaRevokeOutbox: {
      async create({ data }) {
        await prisma.$executeRaw`INSERT INTO "media_revoke_outbox" ("id","userId") VALUES (${genId()}, ${data.userId})`
      },
      async count({ where }) {
        const rows = where.userId !== undefined
          ? await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "media_revoke_outbox" WHERE "userId" = ${where.userId} AND "appliedAt" IS NULL`
          : await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "media_revoke_outbox" WHERE "appliedAt" IS NULL`
        return Number(rows[0]?.c ?? 0)
      },
      async findMany() {
        const rows = await prisma.$queryRaw<{ userId: string }[]>`SELECT DISTINCT "userId" FROM "media_revoke_outbox" WHERE "appliedAt" IS NULL`
        return rows
      },
    },
    $transaction<T>(fn: (tx: PrismaOutboxTx) => Promise<T>): Promise<T> {
      return prisma.$transaction((tx) => fn(tx as unknown as PrismaOutboxTx))
    },
  }
}

export interface EphemeralOutboxDb {
  prisma: PrismaClient
  adapter: PrismaOutboxClient
}

/**
 * Crea un schema aislado con la tabla `media_revoke_outbox`, ejecuta `fn` con un
 * PrismaClient real + adapter, y limpia (DROP SCHEMA) pase lo que pase.
 */
export async function withEphemeralOutboxDb<T>(fn: (db: EphemeralOutboxDb) => Promise<T>): Promise<T> {
  if (!TEST_URL) throw new Error('DATABASE_URL_TEST no definido')
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // Bootstrap: crear el schema con una conexión sobre la URL base.
  const boot = new PrismaClient({ datasources: { db: { url: TEST_URL } } })
  try {
    await boot.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  } finally {
    await boot.$disconnect()
  }

  const scopedUrl = TEST_URL + (TEST_URL.includes('?') ? '&' : '?') + `schema=${schema}`
  const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl } } })
  try {
    await prisma.$executeRawUnsafe(CREATE_TABLE)
    return await fn({ prisma, adapter: outboxAdapter(prisma) })
  } finally {
    try { await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* noop */ }
    await prisma.$disconnect()
  }
}
