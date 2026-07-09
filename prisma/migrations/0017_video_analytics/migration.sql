-- Migration 0017: analítica de video (Roboflow Supervision)

-- Nuevos tipos de alerta generados por el servicio de analítica
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'PERSON_DETECTED';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'VEHICLE_DETECTED';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'ZONE_INTRUSION';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'LINE_CROSSING';

-- Configuración de analítica por cámara
CREATE TABLE IF NOT EXISTS "camera_analytics_configs" (
    "id"            TEXT NOT NULL,
    "cameraId"      TEXT NOT NULL,
    "enabled"       BOOLEAN NOT NULL DEFAULT false,
    "classes"       JSONB NOT NULL DEFAULT '["person"]',
    "minConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sampleFps"     DOUBLE PRECISION NOT NULL DEFAULT 2,
    "zones"         JSONB,
    "cooldownSec"   INTEGER NOT NULL DEFAULT 60,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "camera_analytics_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "camera_analytics_configs_cameraId_key"
    ON "camera_analytics_configs" ("cameraId");

-- Eventos de analítica (detecciones, intrusiones)
CREATE TABLE IF NOT EXISTS "analytics_events" (
    "id"          TEXT NOT NULL,
    "cameraId"    TEXT NOT NULL,
    "type"        TEXT NOT NULL,
    "className"   TEXT NOT NULL,
    "confidence"  DOUBLE PRECISION NOT NULL,
    "trackId"     INTEGER,
    "zoneName"    TEXT,
    "bboxes"      JSONB,
    "snapshotUrl" TEXT,
    "alertId"     TEXT,
    "occurredAt"  TIMESTAMP(3) NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "analytics_events_cameraId_occurredAt_idx"
    ON "analytics_events" ("cameraId", "occurredAt");
CREATE INDEX IF NOT EXISTS "analytics_events_type_occurredAt_idx"
    ON "analytics_events" ("type", "occurredAt");
CREATE INDEX IF NOT EXISTS "analytics_events_occurredAt_idx"
    ON "analytics_events" ("occurredAt");
