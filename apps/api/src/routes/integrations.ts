// apps/api/src/routes/integrations.ts
//
// Estado de integraciones (P1) — a diferencia de las rutas ONVIF / Hik-Connect
// (que existen SÓLO con su flag activa y responden 404 si están apagadas), esta
// ruta se registra SIEMPRE (ver server.ts). Permite que la UI muestre
// "habilitado / deshabilitado" de forma explícita sin tener que interpretar un
// 404 como "deshabilitado".
//
// Autenticado (cualquier rol con token válido): sólo reporta el estado de las
// flags, nunca secretos, URLs de dispositivos, credenciales ni configuración
// sensible. No hace ningún I/O de red.

import type { FastifyPluginAsync } from 'fastify'

export interface IntegrationsStatus {
  onvif: { enabled: boolean }
  hikConnect: { enabled: boolean }
}

export const integrationsRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/integrations/status — autenticado. Devuelve sólo el estado de las
  // flags (booleans). No revela ninguna otra variable de entorno.
  server.get('/status', { preHandler: [server.authenticate] }, async (): Promise<IntegrationsStatus> => ({
    onvif: { enabled: process.env.ONVIF_ENABLED === 'true' },
    hikConnect: { enabled: process.env.HIK_CONNECT_ENABLED === 'true' },
  }))
}

export default integrationsRoutes
