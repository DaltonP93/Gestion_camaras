ALTER TABLE "appearance_settings" ADD COLUMN IF NOT EXISTS "logoUrl"        TEXT;
ALTER TABLE "appearance_settings" ADD COLUMN IF NOT EXISTS "sidebarLogoUrl" TEXT;
ALTER TABLE "appearance_settings" ADD COLUMN IF NOT EXISTS "faviconUrl"     TEXT;
