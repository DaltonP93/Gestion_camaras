-- Migración 0029: rotación de refresh tokens con detección de reutilización (fase 4c).
-- Guarda el hash del token inmediatamente anterior tras cada rotación. Presentar ese
-- token ya rotado (replay) revoca toda la familia de sesiones del usuario.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "previousRefreshToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_previousRefreshToken_key" ON "sessions"("previousRefreshToken");
CREATE INDEX IF NOT EXISTS "sessions_previousRefreshToken_idx" ON "sessions"("previousRefreshToken");

-- Historial de tokens consumidos (fase 4c, revisión Codex): detección de reutilización
-- sobre toda la familia + ventana de gracia para refrescos concurrentes multi-pestaña.
CREATE TABLE IF NOT EXISTS "used_refresh_tokens" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "sessionId" TEXT,
  "usedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "used_refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "used_refresh_tokens_tokenHash_key" ON "used_refresh_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "used_refresh_tokens_userId_idx" ON "used_refresh_tokens"("userId");
CREATE INDEX IF NOT EXISTS "used_refresh_tokens_expiresAt_idx" ON "used_refresh_tokens"("expiresAt");
