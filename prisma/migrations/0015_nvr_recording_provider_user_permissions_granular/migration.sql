-- Migration 0015: NVR recording provider fields + granular user permissions

-- ── NVR recording provider ───────────────────────────────────────────────────
ALTER TABLE "nvrs"
  ADD COLUMN IF NOT EXISTS "recordingProvider"        TEXT    NOT NULL DEFAULT 'ISAPI',
  ADD COLUMN IF NOT EXISTS "supportsIsapiRecording"   BOOLEAN,
  ADD COLUMN IF NOT EXISTS "supportsSdkRecording"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "recordingCapabilityAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recordingCapabilityError" TEXT,
  ADD COLUMN IF NOT EXISTS "playbackWebUrl"           TEXT,
  ADD COLUMN IF NOT EXISTS "sdkEnabled"               BOOLEAN NOT NULL DEFAULT false;

-- ── UserPermission granular fields ──────────────────────────────────────────
ALTER TABLE "user_permissions"
  ADD COLUMN IF NOT EXISTS "canViewCameras"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "canViewRecordings" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canManage"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canEditVideoAudio" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canSync"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canRevalidate"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canRestart"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canViewLive"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "canDownload"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canUseMainStream"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canUseTranscode"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canAddToViews"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canReceiveAlerts"  BOOLEAN NOT NULL DEFAULT false;
