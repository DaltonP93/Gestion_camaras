-- Migración 0028: contador de gracia para el enforcement de MFA obligatorio (fase 4b).
-- Cuenta los inicios de sesión consumidos del período de gracia mientras la política
-- exige MFA y el usuario aún no se ha enrolado. Al agotarse, el login exige el
-- enrolamiento del segundo factor antes de emitir tokens normales.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfaGraceLoginsUsed" INTEGER NOT NULL DEFAULT 0;

-- Bandera de enrolamiento forzoso (independiente de la gracia de rollout): la fija el
-- reset de MFA por admin y la auto-baja de 2FA bajo política obligatoria; se limpia al
-- (re)enrolar. Evita que un reset "regale" nuevos inicios password-only.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "forceMfaEnrollment" BOOLEAN NOT NULL DEFAULT false;
