-- 0034_notification_channels
-- Aditiva y reversible: agrega los canales de webhook salientes (Slack / Teams /
-- webhook genérico) a alert_settings. Columnas NOT NULL con DEFAULT ⇒ la fila
-- singleton existente queda con canales deshabilitados y URLs vacías (sin cambio de
-- comportamiento hasta que un ADMIN los configure). `IF NOT EXISTS` = idempotente.
ALTER TABLE "alert_settings" ADD COLUMN IF NOT EXISTS "slackEnabled"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "alert_settings" ADD COLUMN IF NOT EXISTS "slackWebhookUrl" TEXT    NOT NULL DEFAULT '';
ALTER TABLE "alert_settings" ADD COLUMN IF NOT EXISTS "teamsEnabled"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "alert_settings" ADD COLUMN IF NOT EXISTS "teamsWebhookUrl" TEXT    NOT NULL DEFAULT '';
ALTER TABLE "alert_settings" ADD COLUMN IF NOT EXISTS "webhookEnabled"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "alert_settings" ADD COLUMN IF NOT EXISTS "webhookUrl"      TEXT    NOT NULL DEFAULT '';
