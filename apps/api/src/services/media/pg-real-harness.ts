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
// FIDELIDAD y LIMITACIÓN (declaradas):
//   - El SCHEMA se crea aplicando la MIGRACIÓN REAL `0033_media_revoke_outbox`
//     (el mismo .sql versionado), no un CREATE TABLE a mano ⇒ se valida la
//     migración real, no un esquema inventado.
//   - Se ejerce la CLASE REAL `PrismaMediaRevokeOutbox`. Su `drain` usa
//     `$transaction` + `$queryRaw`/`$executeRaw` (incluido `FOR UPDATE SKIP LOCKED`)
//     contra este Postgres real.
//   - LIMITACIÓN: los tres métodos CRUD del delegate (`create/count/findMany`) se
//     implementan aquí con SQL crudo (adapter), NO con el delegate Prisma generado
//     — por el quirk de generación del cliente en el monorepo. No se afirma validar
//     el delegate generado; sí la migración real y el camino SKIP LOCKED real.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { assertDestructiveTestAllowed } from './test-host-guard'
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

// Ruta a la migración REAL 0033 (desde apps/api, cwd de los tests / CI).
function migration0033Path(): string {
  const candidates = [
    path.resolve(process.cwd(), '../../prisma/migrations/0033_media_revoke_outbox/migration.sql'),
    path.resolve(__dirname, '../../../../../prisma/migrations/0033_media_revoke_outbox/migration.sql'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('no se encontró la migración 0033 real (media_revoke_outbox)')
}

/** Ejecuta el .sql de la migración REAL, sentencia por sentencia (Prisma
 *  $executeRawUnsafe corre una a la vez). Ignora comentarios `--`. */
async function applyMigration0033(prisma: PrismaClient): Promise<void> {
  const sql = readFileSync(migration0033Path(), 'utf8')
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt)
  }
}

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
 * Construye la URL con `?schema=<schema>` REEMPLAZANDO cualquier `schema` previo
 * (no anexando un segundo, que dejaría ambiguo cuál gana). Puro y testeable.
 */
export function buildScopedUrl(baseUrl: string, schema: string): string {
  const u = new URL(baseUrl)
  u.searchParams.set('schema', schema) // set REEMPLAZA; append dejaría dos schema=
  return u.toString()
}

/**
 * Crea un schema aislado con la tabla `media_revoke_outbox`, ejecuta `fn` con un
 * PrismaClient real + adapter, y limpia (DROP SCHEMA) pase lo que pase.
 */
export async function withEphemeralOutboxDb<T>(fn: (db: EphemeralOutboxDb) => Promise<T>): Promise<T> {
  if (!TEST_URL) throw new Error('DATABASE_URL_TEST no definido')
  // Guard: loopback + señal EXPLÍCITA de instancia descartable, ANTES de conectar o
  // de ejecutar CREATE/DROP SCHEMA CASCADE (loopback solo no prueba desechabilidad).
  assertDestructiveTestAllowed(TEST_URL, 'DATABASE_URL_TEST', 'PG_TEST_DISPOSABLE')
  const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // Bootstrap: crear el schema con una conexión sobre la URL base.
  const boot = new PrismaClient({ datasources: { db: { url: TEST_URL } } })
  try {
    await boot.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  } finally {
    await boot.$disconnect()
  }

  const scopedUrl = buildScopedUrl(TEST_URL, schema) // REEMPLAZA cualquier schema previo
  const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl } } })
  try {
    await applyMigration0033(prisma) // migración REAL 0033 dentro del schema aislado
    return await fn({ prisma, adapter: outboxAdapter(prisma) })
  } finally {
    try { await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* noop */ }
    await prisma.$disconnect()
  }
}
