-- Migration: 0005_camera_diagnostics_nvr_hdds
-- Expand Camera with diagnostics fields + add NvrHdd + expand NVR

-- NVR new columns
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "sdkPort" INTEGER DEFAULT 8000;
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "encodingVersion" TEXT;
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "webVersion" TEXT;
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "lastRtspOkAt" TIMESTAMP(3);
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMP(3);
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT;
ALTER TABLE "nvrs" ADD COLUMN IF NOT EXISTS "lastError" TEXT;

-- Camera new columns
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "channelCode" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "ipAddress" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "protocol" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "managementPort" INTEGER;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "securityStatus" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "preferredStream" TEXT NOT NULL DEFAULT 'sub';
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "mainRtspPath" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "subRtspPath" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "mainCodec" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "subCodec" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "mainResolution" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "subResolution" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "mainFps" INTEGER;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "subFps" INTEGER;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "mainBitrate" INTEGER;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "subBitrate" INTEGER;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "rtspMainOk" BOOLEAN;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "rtspSubOk" BOOLEAN;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastRtspCheckAt" TIMESTAMP(3);
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastRtspError" TEXT;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cameras" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMP(3);

-- NvrHdd table
CREATE TABLE IF NOT EXISTS "nvr_hdds" (
    "id" TEXT NOT NULL,
    "nvrId" TEXT NOT NULL,
    "diskNumber" INTEGER NOT NULL,
    "capacityGb" DOUBLE PRECISION,
    "freeGb" DOUBLE PRECISION,
    "usedPercent" DOUBLE PRECISION,
    "status" TEXT,
    "type" TEXT,
    "property" TEXT,
    "process" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "nvr_hdds_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "nvr_hdds" DROP CONSTRAINT IF EXISTS "nvr_hdds_nvrId_diskNumber_key";
ALTER TABLE "nvr_hdds" ADD CONSTRAINT "nvr_hdds_nvrId_diskNumber_key" UNIQUE ("nvrId", "diskNumber");

ALTER TABLE "nvr_hdds" DROP CONSTRAINT IF EXISTS "nvr_hdds_nvrId_fkey";
ALTER TABLE "nvr_hdds" ADD CONSTRAINT "nvr_hdds_nvrId_fkey"
    FOREIGN KEY ("nvrId") REFERENCES "nvrs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
