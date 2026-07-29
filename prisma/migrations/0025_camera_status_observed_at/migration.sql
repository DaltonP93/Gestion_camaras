-- Migración 0025: marca de observación del estado físico del NVR + motivo de la
-- decisión de estado efectivo. ADITIVA e idempotente (columnas nullable).
-- Soporta la fuente de verdad única de online/offline con TTL/frescura (P0):
--   onlineInNvrAt permite que un onlineInNvr=false RECIENTE prevalezca sobre
--   éxitos RTSP antiguos, y que una observación vencida no cuente como positiva.
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "onlineInNvrAt"        TIMESTAMP(3);
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "statusDecisionReason" TEXT;
