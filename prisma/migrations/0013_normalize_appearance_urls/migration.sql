-- Migration 0013: normalize localhost URLs in appearance_settings
-- Strips http://localhost:PORT prefix, leaving /uploads/branding/... relative paths.
-- Idempotent: ILIKE WHERE guard ensures only rows with localhost URLs are touched,
-- and regexp_replace on an already-clean value is a no-op.

UPDATE "appearance_settings"
SET
  "logoUrl"        = regexp_replace("logoUrl",        '^https?://localhost:[0-9]+', ''),
  "sidebarLogoUrl" = regexp_replace("sidebarLogoUrl", '^https?://localhost:[0-9]+', ''),
  "faviconUrl"     = regexp_replace("faviconUrl",     '^https?://localhost:[0-9]+', '')
WHERE
  "logoUrl"        ILIKE 'http://localhost:%'
  OR "logoUrl"     ILIKE 'https://localhost:%'
  OR "sidebarLogoUrl" ILIKE 'http://localhost:%'
  OR "sidebarLogoUrl" ILIKE 'https://localhost:%'
  OR "faviconUrl"  ILIKE 'http://localhost:%'
  OR "faviconUrl"  ILIKE 'https://localhost:%';
