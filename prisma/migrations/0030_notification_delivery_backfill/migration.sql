-- Migración 0030: procedencia + BACKFILL del historial de entregas (PR C).
--
-- Objetivo: completar el historial de `notification_deliveries` para eventos que
-- ocurrieron antes de que existieran las columnas denormalizadas (0026) o antes de
-- que se registrara entrega alguna, distinguiendo SIEMPRE lo reconstruido de lo real.
--
-- ADITIVA e IDEMPOTENTE:
--   * columnas con IF NOT EXISTS;
--   * enriquecimiento (A) sólo toca filas aún no procesadas (backfilledAt IS NULL);
--   * síntesis (B) usa id determinista 'bf_'||alertId → la PK impide duplicados al
--     re-ejecutar, y además se filtra con NOT EXISTS.
-- Se puede re-correr sin efectos secundarios.
--
-- REVERSIBILIDAD:
--   * filas sintéticas (B):  DELETE FROM notification_deliveries WHERE source='backfill';
--   * enriquecimiento (A):   no destructivo (sólo rellenó columnas NULL); las filas
--                            afectadas son identificables por backfilledAt IS NOT NULL
--                            con source='live'.

-- ── 0. Procedencia ────────────────────────────────────────────────────────────
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "source"       TEXT NOT NULL DEFAULT 'live';
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "backfilledAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "notification_deliveries_source_idx" ON "notification_deliveries" ("source");

-- ── A. Enriquecer filas EXISTENTES con el contexto de su alerta ────────────────
-- Rellena sólo columnas NULL (COALESCE) uniéndose a la alerta original. No cambia
-- el estado ni marca la fila como 'backfill' (sigue siendo una entrega real 'live');
-- sólo estampa backfilledAt para dejar traza. Idempotente por backfilledAt IS NULL.
UPDATE "notification_deliveries" d SET
  "alertType"   = COALESCE(d."alertType", a."type"::text),
  "cameraName"  = COALESCE(d."cameraName", c."name"),
  "nvrName"     = COALESCE(d."nvrName", n."name"),
  "attemptedAt" = COALESCE(d."attemptedAt", d."createdAt"),
  "failedAt"    = CASE WHEN d."status" = 'failed' THEN COALESCE(d."failedAt", d."createdAt") ELSE d."failedAt" END,
  "subject"     = COALESCE(
    d."subject",
    '[VisionCore] ' || a."severity"::text || ': ' ||
    CASE a."type"::text
      WHEN 'NVR_OFFLINE'      THEN 'NVR Offline'
      WHEN 'CAMERA_OFFLINE'   THEN 'Cámara Offline'
      WHEN 'HDD_FULL'         THEN 'HDD Lleno'
      WHEN 'HDD_ERROR'        THEN 'Error de HDD'
      WHEN 'MOTION_DETECTED'  THEN 'Movimiento Detectado'
      WHEN 'RECORDING_ERROR'  THEN 'Error de Grabación'
      WHEN 'AUTH_FAILED'      THEN 'Fallo de Autenticación'
      ELSE a."type"::text
    END ||
    CASE WHEN n."name" IS NOT NULL THEN ' — ' || n."name" ELSE '' END
  ),
  "backfilledAt" = now()
FROM "alerts" a
LEFT JOIN "nvrs"    n ON n."id" = a."nvrId"
LEFT JOIN "cameras" c ON c."id" = a."cameraId"
WHERE d."alertId" = a."id"
  AND d."backfilledAt" IS NULL
  AND (
       d."alertType" IS NULL
    OR d."subject"   IS NULL
    OR d."attemptedAt" IS NULL
    OR (d."cameraName" IS NULL AND a."cameraId" IS NOT NULL)
    OR (d."nvrName"    IS NULL AND a."nvrId"    IS NOT NULL)
    OR (d."status" = 'failed' AND d."failedAt" IS NULL)
  );

-- ── B. Sintetizar filas para alertas SIN entrega registrada ────────────────────
-- Reconstruye una entrega por email para alertas que, según la configuración ACTUAL
-- (alert_settings.alertTypes), habrían disparado correo pero no tienen fila alguna.
--   * source='backfill' → marcado como reconstruido / NO verificado.
--   * recipient         → mejor esfuerzo desde alert_settings (el destinatario
--                         histórico no se conserva; puede ser NULL si está vacío).
--   * id='bf_'||alertId → determinista: la PK evita duplicados al re-ejecutar.
-- Nota: status='sent' es OPTIMISTA (no hay confirmación histórica); filtrar por
-- source='live' para métricas de envíos reales.
INSERT INTO "notification_deliveries" (
  "id", "alertId", "channel", "status", "recipient", "attempts",
  "sentAt", "attemptedAt", "createdAt", "updatedAt",
  "subject", "alertType", "cameraName", "nvrName",
  "source", "backfilledAt"
)
SELECT
  'bf_' || a."id",
  a."id",
  'email',
  'sent',
  (SELECT NULLIF(s."recipientEmails", '') FROM "alert_settings" s WHERE s."id" = 'singleton'),
  1,
  a."createdAt",
  a."createdAt",
  a."createdAt",
  now(),
  '[VisionCore] ' || a."severity"::text || ': ' ||
  CASE a."type"::text
    WHEN 'NVR_OFFLINE'      THEN 'NVR Offline'
    WHEN 'CAMERA_OFFLINE'   THEN 'Cámara Offline'
    WHEN 'HDD_FULL'         THEN 'HDD Lleno'
    WHEN 'HDD_ERROR'        THEN 'Error de HDD'
    WHEN 'MOTION_DETECTED'  THEN 'Movimiento Detectado'
    WHEN 'RECORDING_ERROR'  THEN 'Error de Grabación'
    WHEN 'AUTH_FAILED'      THEN 'Fallo de Autenticación'
    ELSE a."type"::text
  END ||
  CASE WHEN n."name" IS NOT NULL THEN ' — ' || n."name" ELSE '' END,
  a."type"::text,
  c."name",
  n."name",
  'backfill',
  now()
FROM "alerts" a
LEFT JOIN "nvrs"    n ON n."id" = a."nvrId"
LEFT JOIN "cameras" c ON c."id" = a."cameraId"
WHERE NOT EXISTS (
        SELECT 1 FROM "notification_deliveries" d WHERE d."alertId" = a."id"
      )
  -- Sólo tipos que la configuración actual habilita para correo (evita fabricar
  -- entregas de tipos que nunca se envían por email, p.ej. MOTION_DETECTED off).
  AND COALESCE(
        (SELECT (s."alertTypes" ->> a."type"::text)::boolean
         FROM "alert_settings" s WHERE s."id" = 'singleton'),
        false
      ) = true
ON CONFLICT ("id") DO NOTHING;
