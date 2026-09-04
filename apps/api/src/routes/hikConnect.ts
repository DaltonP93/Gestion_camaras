// apps/api/src/routes/hikConnect.ts
//
// Ruta Hik-Connect (P1) — SÓLO se registra si HIK_CONNECT_ENABLED=true (ver
// server.ts); con la flag apagada estas rutas responden 404 y el API se comporta
// idéntico. Todas las operaciones exigen rol ADMIN.
//
// SEGURIDAD:
//   - AppKey/SecretKey se leen SÓLO de env (nunca del body): son credenciales de
//     Technology Partner. Jamás se loguean ni se retornan.
//   - El accessToken NO se expone al frontend: /token devuelve metadatos
//     (areaDomain, expiración), nunca el token crudo.
//   - SSRF: el `isapiPath` pasa por validación estricta en el servicio; el host
//     destino es siempre el areaDomain validado del token.
//
// LIMITACIÓN: la nube entrega H.264 únicamente (sin HEVC, sin transcode).

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { HikConnectProvider, isHikConnectError } from '../services/providers/hik-connect'

const hlsSchema = z.object({
  deviceSerial: z.string().min(1).max(128),
  channelNo: z.number().int().min(1).max(999).optional(),
})

const isapiSchema = z.object({
  deviceSerial: z.string().min(1).max(128),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  // La validación ESTRICTA definitiva vive en el servicio (assertSafeIsapiPath);
  // aquí sólo se acota tamaño para rechazo temprano.
  isapiPath: z.string().min(1).max(1024),
  body: z.string().max(65536).optional(),
  channelNo: z.number().int().min(1).max(999).optional(),
})

function buildProvider(): HikConnectProvider {
  return new HikConnectProvider({
    timeoutMs: Number(process.env.HIK_CONNECT_TIMEOUT_MS) || undefined,
    hlsTtlSec: Number(process.env.HIK_CONNECT_HLS_TTL_SEC) || undefined,
  })
}

/** Mapea HikConnectError a un status HTTP; nunca filtra secretos ni cuerpos. */
function statusFor(code: string): number {
  switch (code) {
    case 'NOT_ENABLED':
      return 404
    case 'NOT_CONFIGURED':
      return 503
    case 'INVALID_AREA_DOMAIN':
    case 'INVALID_ISAPI_PATH':
    case 'INVALID_ARG':
      return 400
    case 'TIMEOUT':
      return 504
    case 'API_ERROR':
    case 'TRANSPORT_ERROR':
    case 'PARSE_ERROR':
      return 502
    default:
      return 500
  }
}

export const hikConnectRoutes: FastifyPluginAsync = async (server) => {
  const admin = { preHandler: [server.authorize(['ADMIN'])] }

  const handle = async (reply: import('fastify').FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return reply.send(await fn())
    } catch (e) {
      if (isHikConnectError(e)) {
        // Sólo code + apiCode + mensaje saneado; nunca el cuerpo crudo.
        return reply.status(statusFor(e.code)).send({ code: e.code, apiCode: e.apiCode, message: e.message })
      }
      server.log.error('hik_connect_route_error')
      return reply.status(500).send({ code: 'INTERNAL', message: 'error interno' })
    }
  }

  // Metadatos del token (areaDomain + expiración). NUNCA el accessToken crudo.
  server.post('/token', admin, async (_request, reply) => {
    return handle(reply, () => buildProvider().getToken())
  })

  server.post('/hls', admin, async (request, reply) => {
    const body = hlsSchema.parse(request.body)
    return handle(reply, () => buildProvider().getHlsAddress(body.deviceSerial, body.channelNo))
  })

  server.post('/isapi', admin, async (request, reply) => {
    const body = isapiSchema.parse(request.body)
    return handle(reply, async () => ({
      result: await buildProvider().proxyIsapi(body.deviceSerial, body.method, body.isapiPath, body.body, body.channelNo),
    }))
  })
}

export default hikConnectRoutes
