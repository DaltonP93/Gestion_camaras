-- AddColumn: avatar and phone to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable: alert_settings
CREATE TABLE IF NOT EXISTS "alert_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smtpHost" TEXT NOT NULL DEFAULT '',
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "smtpUser" TEXT NOT NULL DEFAULT '',
    "smtpPassword" TEXT NOT NULL DEFAULT '',
    "smtpFromEmail" TEXT NOT NULL DEFAULT '',
    "smtpFromName" TEXT NOT NULL DEFAULT 'VisionCore Alertas',
    "recipientEmails" TEXT NOT NULL DEFAULT '',
    "alertTypes" JSONB NOT NULL DEFAULT '{"CAMERA_OFFLINE":true,"NVR_OFFLINE":true,"HDD_FULL":true,"HDD_ERROR":true,"MOTION_DETECTED":false,"RECORDING_ERROR":true,"AUTH_FAILED":false}',
    "minSeverity" TEXT NOT NULL DEFAULT 'HIGH',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_settings_pkey" PRIMARY KEY ("id")
);

-- Seed singleton alert settings
INSERT INTO "alert_settings" ("id", "updatedAt") VALUES ('singleton', NOW()) ON CONFLICT ("id") DO NOTHING;
