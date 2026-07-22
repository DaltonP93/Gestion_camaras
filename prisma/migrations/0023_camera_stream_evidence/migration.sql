-- Migración 0023: evidencia real del pipeline de streaming por cámara.
-- ADITIVA e idempotente (columnas nullable, sin defaults que reescriban filas).
-- Soporta la detección server-side de CAMERA_STREAM_ERROR: timestamps del último
-- éxito/fallo de stream, última vez que MediaMTX estuvo READY, última entrega HLS
-- verificada y último código de error de pipeline.
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastStreamSuccessAt" TIMESTAMP(3);
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastStreamFailureAt" TIMESTAMP(3);
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastMediaMtxReadyAt" TIMESTAMP(3);
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastHlsSuccessAt"    TIMESTAMP(3);
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastStreamErrorCode" TEXT;
