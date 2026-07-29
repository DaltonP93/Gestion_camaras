-- Migración 0027: ajustes de seguridad persistidos (singleton) — P0.
-- Reemplaza el "guardado" falso de la pestaña Seguridad por persistencia real:
-- política de contraseña (mín. 12), timeout de sesión, sesiones concurrentes,
-- lockout configurable y la POLÍTICA MFA (persistida ahora; enforcement posterior).
CREATE TABLE IF NOT EXISTS "security_settings" (
  "id"                     TEXT NOT NULL,
  "passwordMinLength"      INTEGER NOT NULL DEFAULT 12,
  "requireStrongPassword"  BOOLEAN NOT NULL DEFAULT true,
  "sessionTimeoutMinutes"  INTEGER NOT NULL DEFAULT 60,
  "maxSessions"            INTEGER NOT NULL DEFAULT 5,
  "lockoutMaxAttempts"     INTEGER NOT NULL DEFAULT 5,
  "lockoutDurationMinutes" INTEGER NOT NULL DEFAULT 15,
  "mfaRequired"            BOOLEAN NOT NULL DEFAULT false,
  "mfaGracePeriodLogins"   INTEGER NOT NULL DEFAULT 3,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  "updatedBy"              TEXT,
  CONSTRAINT "security_settings_pkey" PRIMARY KEY ("id")
);
