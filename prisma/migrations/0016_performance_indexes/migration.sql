-- Migration 0016: índices de rendimiento
-- PostgreSQL no indexa columnas FK automáticamente — cada índice de abajo
-- respalda una consulta real del código (ver comentario por índice).

-- ── sessions ─────────────────────────────────────────────────────────────────
-- auth.ts / users.ts / profile.ts: findMany/deleteMany por userId
CREATE INDEX IF NOT EXISTS "sessions_userId_idx" ON "sessions" ("userId");
-- healthWorker.ts: limpieza horaria deleteMany({ expiresAt: { lt: now } })
CREATE INDEX IF NOT EXISTS "sessions_expiresAt_idx" ON "sessions" ("expiresAt");

-- ── audit_logs ───────────────────────────────────────────────────────────────
-- users.ts /audit/activity: orderBy createdAt desc con paginación
CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx" ON "audit_logs" ("createdAt");
-- users.ts /audit/activity?userId=: filtro por usuario + orden por fecha
CREATE INDEX IF NOT EXISTS "audit_logs_userId_createdAt_idx" ON "audit_logs" ("userId", "createdAt");
-- recordings.ts /audit: action IN (...) + orderBy createdAt desc
CREATE INDEX IF NOT EXISTS "audit_logs_action_createdAt_idx" ON "audit_logs" ("action", "createdAt");

-- ── alerts ───────────────────────────────────────────────────────────────────
-- alerts.ts /unread-count (campana, polling frecuente) y /read-all
CREATE INDEX IF NOT EXISTS "alerts_resolved_readAt_idx" ON "alerts" ("resolved", "readAt");
-- healthWorker.ts: findFirst/updateMany { nvrId, type, resolved: false }
CREATE INDEX IF NOT EXISTS "alerts_nvrId_type_resolved_idx" ON "alerts" ("nvrId", "type", "resolved");
-- healthWorker.ts: findFirst { cameraId, type, resolved: false }
CREATE INDEX IF NOT EXISTS "alerts_cameraId_type_resolved_idx" ON "alerts" ("cameraId", "type", "resolved");
-- alerts.ts / search.ts: orderBy createdAt desc
CREATE INDEX IF NOT EXISTS "alerts_createdAt_idx" ON "alerts" ("createdAt");

-- ── notification_deliveries ──────────────────────────────────────────────────
-- alertSettings.ts /settings/deliveries: orderBy createdAt desc paginado
CREATE INDEX IF NOT EXISTS "notification_deliveries_createdAt_idx" ON "notification_deliveries" ("createdAt");

-- ── nvr_channel_config_backups ───────────────────────────────────────────────
-- nvrConfig.ts restore: findFirst { nvrId, channelNo, streamType } orderBy createdAt desc
CREATE INDEX IF NOT EXISTS "nvr_channel_config_backups_nvrId_channelNo_streamType_created" ON "nvr_channel_config_backups" ("nvrId", "channelNo", "streamType", "createdAt");
