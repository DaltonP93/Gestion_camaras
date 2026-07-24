-- Migración 0024: paths efectivos de streaming. ADITIVA e idempotente.
-- Separa "start-stream aceptado" del éxito real HLS/frames (lastStreamSuccessAt)
-- y agrega el tipo de alerta STREAM_DEGRADED (sub caído, fallback main activo —
-- NO es pérdida total de video).
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'STREAM_DEGRADED';
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastStreamStartAcceptedAt" TIMESTAMP(3);
