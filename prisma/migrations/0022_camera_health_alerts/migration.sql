-- Migración 0022: salud de cámara (señal física vs pipeline) y config de alertas.
-- ADITIVA e idempotente. No modifica filas existentes (todos los defaults son
-- retrocompatibles). No toca el trabajo de Grabaciones del PR #113.

-- ── Nuevos valores del enum AlertType (TASK 3/4) ──
-- ALTER TYPE ... ADD VALUE requiere PostgreSQL 12+ para correr dentro de una
-- transacción; IF NOT EXISTS lo hace reejecutable.
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'CAMERA_RECOVERED';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'CAMERA_STREAM_ERROR';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'CAMERA_STREAM_RECOVERED';

-- ── Configuración de alertas por cámara (TASK 6) ──
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "offlineAlertEnabled"     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "streamErrorAlertEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "offlineConfirmSec"       INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "recoveryConfirmSec"      INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "offlineSeverity"         TEXT NOT NULL DEFAULT 'HIGH';
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "streamErrorSeverity"     TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "sendEmailOnOffline"      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "sendEmailOnRecovery"     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "maintenanceMode"         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "maintenanceUntil"        TIMESTAMP(3);
