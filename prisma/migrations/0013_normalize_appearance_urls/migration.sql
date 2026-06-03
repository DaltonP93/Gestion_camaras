-- Migration 0013: normalize localhost URLs in appearance_settings
-- Replaces http://localhost:PORT/uploads/branding/... with /uploads/branding/...
-- Safe to re-run: REGEXP_REPLACE is idempotent; only rows with localhost URLs are updated.

UPDATE "appearance_settings"
SET
  "logoUrl"        = REGEXP_REPLACE("logoUrl",        '^https?://localhost(:[0-9]+)?/uploads/', '/uploads/'),
  "sidebarLogoUrl" = REGEXP_REPLACE("sidebarLogoUrl", '^https?://localhost(:[0-9]+)?/uploads/', '/uploads/'),
  "faviconUrl"     = REGEXP_REPLACE("faviconUrl",     '^https?://localhost(:[0-9]+)?/uploads/', '/uploads/')
WHERE
  "logoUrl"        LIKE 'http://localhost%/uploads/%'
  OR "logoUrl"     LIKE 'https://localhost%/uploads/%'
  OR "sidebarLogoUrl" LIKE 'http://localhost%/uploads/%'
  OR "sidebarLogoUrl" LIKE 'https://localhost%/uploads/%'
  OR "faviconUrl"  LIKE 'http://localhost%/uploads/%'
  OR "faviconUrl"  LIKE 'https://localhost%/uploads/%';
