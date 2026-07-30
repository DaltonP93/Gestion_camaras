-- Migración 0031: sistema de tokens de apariencia V2 (PR 1a).
--
-- COMPLETAMENTE ADITIVA: sólo agrega columnas nullable. No elimina ni renombra
-- nada. Los campos legacy (theme, primaryColor, accentColor, sidebarWidth, ...)
-- se conservan intactos. Cuando un campo V2 es NULL, el motor de tokens del
-- frontend lo deriva del legacy equivalente (ver lib/appearanceTokens).
--
-- Reversible: DROP COLUMN de cada columna añadida (ver sección rollback del PR).

ALTER TABLE "appearance_settings"
  ADD COLUMN IF NOT EXISTS "themeMode"          TEXT,
  ADD COLUMN IF NOT EXISTS "fontFamily"         TEXT,
  ADD COLUMN IF NOT EXISTS "fontScale"          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "density"            TEXT,
  ADD COLUMN IF NOT EXISTS "borderRadius"       TEXT,
  ADD COLUMN IF NOT EXISTS "shadowLevel"        TEXT,
  ADD COLUMN IF NOT EXISTS "componentHeight"    INTEGER,
  ADD COLUMN IF NOT EXISTS "backgroundColor"    TEXT,
  ADD COLUMN IF NOT EXISTS "surfaceColor"       TEXT,
  ADD COLUMN IF NOT EXISTS "surfaceRaisedColor" TEXT,
  ADD COLUMN IF NOT EXISTS "borderColor"        TEXT,
  ADD COLUMN IF NOT EXISTS "textPrimaryColor"   TEXT,
  ADD COLUMN IF NOT EXISTS "textSecondaryColor" TEXT,
  ADD COLUMN IF NOT EXISTS "textMutedColor"     TEXT,
  ADD COLUMN IF NOT EXISTS "successColor"       TEXT,
  ADD COLUMN IF NOT EXISTS "warningColor"       TEXT,
  ADD COLUMN IF NOT EXISTS "dangerColor"        TEXT,
  ADD COLUMN IF NOT EXISTS "informationColor"   TEXT,
  ADD COLUMN IF NOT EXISTS "offlineColor"       TEXT,
  ADD COLUMN IF NOT EXISTS "recordingColor"     TEXT,
  ADD COLUMN IF NOT EXISTS "analyticsColor"     TEXT;
