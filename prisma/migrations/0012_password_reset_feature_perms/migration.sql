-- Migration 0012: password reset token columns + extended feature permissions
-- Safe to re-run: all statements use ADD COLUMN IF NOT EXISTS.

-- ─── User: password reset flow ─────────────────────────────────────────────
-- Added when implementing /auth/forgot-password and /auth/reset-password.
-- Both columns are nullable so existing rows are unaffected.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "passwordResetToken"  TEXT,
  ADD COLUMN IF NOT EXISTS "passwordResetExpiry" TIMESTAMP(3);

-- Index accelerates the token lookup on /auth/reset-password.
-- Partial index skips NULL rows (the common case).
CREATE INDEX IF NOT EXISTS "users_passwordResetToken_idx"
  ON "users" ("passwordResetToken")
  WHERE "passwordResetToken" IS NOT NULL;

-- ─── UserFeaturePermissions: extended action columns ───────────────────────
-- Added when implementing granular download/views/settings permissions.
-- All three default to false, matching the schema default and keeping
-- existing rows restricted until an admin explicitly grants access.
ALTER TABLE "user_feature_permissions"
  ADD COLUMN IF NOT EXISTS "canDownloadRecordings" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canManageViews"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canManageSettings"      BOOLEAN NOT NULL DEFAULT false;
