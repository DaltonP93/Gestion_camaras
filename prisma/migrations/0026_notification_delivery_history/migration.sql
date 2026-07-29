-- Migración 0026: historial de entregas de notificaciones completo (P1).
-- ADITIVA e idempotente (columnas nullable). Fecha/hora reales para enviados Y
-- fallidos (los fallidos ya no dependen de sentAt) + contexto denormalizado de la
-- alerta (tipo, cámara, NVR, asunto) para mostrarlo aunque la alerta se elimine.
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "attemptedAt" TIMESTAMP(3);
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "failedAt"    TIMESTAMP(3);
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "errorCode"   TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "subject"     TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "alertType"   TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "cameraName"  TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "nvrName"     TEXT;
CREATE INDEX IF NOT EXISTS "notification_deliveries_status_createdAt_idx" ON "notification_deliveries" ("status", "createdAt");
