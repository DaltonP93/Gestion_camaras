-- Migration 0014: NVR channel config backup table for video/audio editing
CREATE TABLE IF NOT EXISTS "nvr_channel_config_backups" (
  "id"              TEXT        NOT NULL,
  "nvrId"           TEXT        NOT NULL,
  "cameraId"        TEXT,
  "channelNo"       INTEGER     NOT NULL,
  "streamType"      TEXT        NOT NULL,
  "configJson"      TEXT        NOT NULL,
  "createdByUserId" TEXT        NOT NULL,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "reason"          TEXT        NOT NULL,
  CONSTRAINT "nvr_channel_config_backups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "nvr_channel_config_backups_nvrId_fkey" FOREIGN KEY ("nvrId") REFERENCES "nvrs"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "nvr_channel_config_backups_nvrId_idx" ON "nvr_channel_config_backups" ("nvrId");
CREATE INDEX IF NOT EXISTS "nvr_channel_config_backups_channelNo_idx" ON "nvr_channel_config_backups" ("nvrId", "channelNo");
