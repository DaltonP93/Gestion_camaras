-- CreateTable: camera_views
CREATE TABLE "camera_views" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "layout" TEXT NOT NULL DEFAULT '3x3',
    "cameraSlots" JSONB NOT NULL,
    "slideshowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "slideshowInterval" INTEGER NOT NULL DEFAULT 10,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camera_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable: camera_view_access
CREATE TABLE "camera_view_access" (
    "id" TEXT NOT NULL,
    "viewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "camera_view_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable: appearance_settings
CREATE TABLE "appearance_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "siteName" TEXT NOT NULL DEFAULT 'VisionCore',
    "logoText" TEXT NOT NULL DEFAULT 'VisionCore',
    "primaryColor" TEXT NOT NULL DEFAULT '#e51d1d',
    "accentColor" TEXT NOT NULL DEFAULT '#c41616',
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "sidebarWidth" TEXT NOT NULL DEFAULT 'normal',
    "showNVRsInSidebar" BOOLEAN NOT NULL DEFAULT true,
    "customCss" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appearance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "camera_view_access_viewId_userId_key" ON "camera_view_access"("viewId", "userId");

-- AddForeignKey
ALTER TABLE "camera_view_access" ADD CONSTRAINT "camera_view_access_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "camera_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "camera_view_access" ADD CONSTRAINT "camera_view_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed singleton appearance settings
INSERT INTO "appearance_settings" ("id", "updatedAt") VALUES ('singleton', NOW()) ON CONFLICT ("id") DO NOTHING;
