-- Migration 0006: notification_deliveries table
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id"        TEXT NOT NULL,
  "alertId"   TEXT NOT NULL,
  "channel"   TEXT NOT NULL,
  "status"    TEXT NOT NULL,
  "recipient" TEXT,
  "error"     TEXT,
  "attempts"  INTEGER NOT NULL DEFAULT 1,
  "sentAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notification_deliveries_alertId_idx"
  ON "notification_deliveries"("alertId");
