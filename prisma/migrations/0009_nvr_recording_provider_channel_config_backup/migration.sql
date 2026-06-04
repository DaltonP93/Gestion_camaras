-- Migration 0009: NVR recording provider + channel config backup

ALTER TABLE "nvrs"
  ADD COLUMN IF NOT EXISTS "recordingProvider"        TEXT    NOT NULL DEFAULT 'ISAPI',
  ADD COLUMN IF NOT EXISTS "supportsIsapiRecording"   BOOLEAN,
  ADD COLUMN IF NOT EXISTS "supportsSdkRecording"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "recordingCapabilityAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recordingCapabilityError" TEXT,
  ADD COLUMN IF NOT EXISTS "playbackWebUrl"           TEXT,
  ADD COLUMN IF NOT EXISTS "sdkEnabled"               BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "nvr_channel_config_backups" (
    "id"              TEXT NOT NULL,
    "nvrId"           TEXT NOT NULL,
    "cameraId"        TEXT,
    "channelNo"       INTEGER NOT NULL,
    "streamType"      TEXT NOT NULL,
    "configJson"      TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason"          TEXT NOT NULL,
    CONSTRAINT "nvr_channel_config_backups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "nvr_channel_config_backups_nvrId_fkey" FOREIGN KEY ("nvrId") REFERENCES "nvrs"("id") ON DELETE CASCADE
);
