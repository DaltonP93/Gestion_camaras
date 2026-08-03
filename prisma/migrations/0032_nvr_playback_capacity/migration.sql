-- Migración 0032: capacidad de reproducción histórica por NVR.
--
-- COMPLETAMENTE ADITIVA. Los NVR limitan cuántas sesiones RTSP de playback
-- conceden a la vez (responden "453 Not Enough Bandwidth" al excederlo). El
-- límite es del DISPOSITIVO, no de la cámara ni de VisionCore.
--
-- Precedencia: nvrs.maxConcurrentPlaybackSessions
--              -> recordings_settings.recordingsDefaultMaxConcurrentPerNvr
--              -> valor seguro (1)
--
-- Reversible: DROP COLUMN de ambas columnas.

ALTER TABLE "nvrs"
  ADD COLUMN IF NOT EXISTS "maxConcurrentPlaybackSessions" INTEGER;

ALTER TABLE "recordings_settings"
  ADD COLUMN IF NOT EXISTS "recordingsDefaultMaxConcurrentPerNvr" INTEGER NOT NULL DEFAULT 1;
