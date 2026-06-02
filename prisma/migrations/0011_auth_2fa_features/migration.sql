-- Migration 0011: 2FA, feature permissions, session improvements, password policy

-- ─── User: 2FA fields ──────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "twoFactorEnabled"     BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "twoFactorSecret"      TEXT,
  ADD COLUMN IF NOT EXISTS "twoFactorBackupCodes" TEXT,
  ADD COLUMN IF NOT EXISTS "passwordChangedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "passwordHistory"      TEXT,
  ADD COLUMN IF NOT EXISTS "forcePasswordChange"  BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "failedLoginAttempts"  INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedUntil"          TIMESTAMP(3);

-- ─── Session: device tracking ──────────────────────────────
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "deviceName"  TEXT,
  ADD COLUMN IF NOT EXISTS "lastUsedAt"  TIMESTAMP(3);

-- ─── UserPermission: high quality ──────────────────────────
ALTER TABLE "user_permissions"
  ADD COLUMN IF NOT EXISTS "canHighQuality" BOOLEAN NOT NULL DEFAULT false;

-- ─── UserFeaturePermissions ────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_feature_permissions" (
  "id"                  TEXT         NOT NULL,
  "userId"              TEXT         NOT NULL,
  "canViewDashboard"    BOOLEAN      NOT NULL DEFAULT true,
  "canViewLive"         BOOLEAN      NOT NULL DEFAULT true,
  "canViewRecordings"   BOOLEAN      NOT NULL DEFAULT false,
  "canViewAlerts"       BOOLEAN      NOT NULL DEFAULT true,
  "canViewDiagnostics"  BOOLEAN      NOT NULL DEFAULT false,
  "canManageNVRs"       BOOLEAN      NOT NULL DEFAULT false,
  "canManageCameras"    BOOLEAN      NOT NULL DEFAULT false,
  "canManageUsers"      BOOLEAN      NOT NULL DEFAULT false,
  "canManageAppearance" BOOLEAN      NOT NULL DEFAULT false,
  "canResolveAlerts"    BOOLEAN      NOT NULL DEFAULT false,
  "canRestartStreams"    BOOLEAN      NOT NULL DEFAULT false,
  "canTranscode"        BOOLEAN      NOT NULL DEFAULT false,
  CONSTRAINT "user_feature_permissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_feature_permissions_userId_key" UNIQUE ("userId"),
  CONSTRAINT "user_feature_permissions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
