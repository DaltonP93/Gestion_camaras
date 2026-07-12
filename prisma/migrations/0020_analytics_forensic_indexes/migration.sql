-- Migration 0020: índices para la búsqueda forense de analítica.
-- Los filtros de la pestaña Forense combinan className/zoneName/direction con
-- rango de occurredAt; sin estos índices compuestos hacían seq scan + sort.
CREATE INDEX IF NOT EXISTS "analytics_events_className_occurredAt_idx"
    ON "analytics_events" ("className", "occurredAt");
CREATE INDEX IF NOT EXISTS "analytics_events_zoneName_occurredAt_idx"
    ON "analytics_events" ("zoneName", "occurredAt");
CREATE INDEX IF NOT EXISTS "analytics_events_direction_occurredAt_idx"
    ON "analytics_events" ("direction", "occurredAt");
