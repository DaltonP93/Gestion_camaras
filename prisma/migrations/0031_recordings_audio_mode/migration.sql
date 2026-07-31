-- Migración 0031: política de audio de reproducción (audioMode) — P1 Grabaciones.
--
-- COMPLETAMENTE ADITIVA. Política GENERAL (sin excepciones por cámara/NVR/modelo):
-- precedencia camera.audioMode → nvr.audioMode → system.recordingsAudioMode → auto.
-- Un audio ausente/none/unknown/incompatible nunca debe impedir el video.
--
-- Reversible: DROP COLUMN de audioMode en cameras/nvrs + DROP TABLE recordings_settings.

ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "audioMode" TEXT;
ALTER TABLE "nvrs"    ADD COLUMN IF NOT EXISTS "audioMode" TEXT;

CREATE TABLE IF NOT EXISTS "recordings_settings" (
  "id"                  TEXT NOT NULL,
  "recordingsAudioMode" TEXT NOT NULL DEFAULT 'auto',
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recordings_settings_pkey" PRIMARY KEY ("id")
);
