-- Migration 0019: analítica robusta — alertas configurables, loitering,
-- aforo y scaffold ALPR

ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'LOITERING';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'OCCUPANCY_LIMIT';

ALTER TABLE "camera_analytics_configs" ADD COLUMN IF NOT EXISTS "alertConfig" JSONB;

CREATE TABLE IF NOT EXISTS "license_plate_events" (
    "id"                   TEXT NOT NULL,
    "cameraId"             TEXT NOT NULL,
    "plateText"            TEXT NOT NULL,
    "plateConfidence"      DOUBLE PRECISION NOT NULL,
    "plateCropSnapshotUrl" TEXT,
    "fullSnapshotUrl"      TEXT,
    "occurredAt"           TIMESTAMP(3) NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "license_plate_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "license_plate_events_plateText_idx" ON "license_plate_events" ("plateText");
CREATE INDEX IF NOT EXISTS "license_plate_events_cameraId_occurredAt_idx" ON "license_plate_events" ("cameraId", "occurredAt");
CREATE INDEX IF NOT EXISTS "license_plate_events_occurredAt_idx" ON "license_plate_events" ("occurredAt");
