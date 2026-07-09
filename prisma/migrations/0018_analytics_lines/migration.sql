-- Migration 0018: líneas de conteo por cruce (analítica de video)
ALTER TABLE "camera_analytics_configs" ADD COLUMN IF NOT EXISTS "lines" JSONB;
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "direction" TEXT;
