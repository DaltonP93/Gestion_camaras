-- Correlaciona entrada/permanencia/salida de un mismo incidente de zona.
-- Aditivo: columna nullable + índice. No afecta filas existentes.
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "incidentId" TEXT;
CREATE INDEX IF NOT EXISTS "analytics_events_incidentId_idx" ON "analytics_events" ("incidentId");
