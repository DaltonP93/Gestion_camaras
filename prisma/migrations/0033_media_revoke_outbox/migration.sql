-- Migración 0033: outbox durable de revocación de medios (C23·H2·P2).
--
-- COMPLETAMENTE ADITIVA. Registra en Postgres la intención de revocar los grants
-- de medios de un usuario (logout / cambio de permisos) de forma DURABLE, para
-- sobrevivir a un reinicio del API mientras Redis está caído. Un worker
-- idempotente aplica el bump de epoch en Redis y marca "appliedAt".
--
-- No contiene grants, secretos ni tokens: sólo userId + timestamps + intentos.
-- La toma atómica multi-worker usa "appliedAt IS NULL ... FOR UPDATE SKIP LOCKED".
--
-- Reversible: DROP TABLE "media_revoke_outbox".

CREATE TABLE IF NOT EXISTS "media_revoke_outbox" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt"   TIMESTAMP(3),
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "media_revoke_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "media_revoke_outbox_userId_appliedAt_idx"
  ON "media_revoke_outbox" ("userId", "appliedAt");

CREATE INDEX IF NOT EXISTS "media_revoke_outbox_appliedAt_idx"
  ON "media_revoke_outbox" ("appliedAt");
