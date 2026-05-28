-- AddColumn isapIStatus to NVR
-- Tracks the result of the last InputProxy probe:
-- 'available' | 'no_permission' | 'unsupported' | 'error' | 'unknown'
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "isapIStatus" TEXT DEFAULT 'unknown';
