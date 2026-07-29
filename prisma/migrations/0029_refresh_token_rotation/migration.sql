-- Migración 0029: rotación de refresh tokens con detección de reutilización (fase 4c).
-- Guarda el hash del token inmediatamente anterior tras cada rotación. Presentar ese
-- token ya rotado (replay) revoca toda la familia de sesiones del usuario.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "previousRefreshToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_previousRefreshToken_key" ON "sessions"("previousRefreshToken");
CREATE INDEX IF NOT EXISTS "sessions_previousRefreshToken_idx" ON "sessions"("previousRefreshToken");
