// apps/api/src/routes/onvif.ts
//
// Ruta ONVIF (P1) — SÓLO se registra si ONVIF_ENABLED=true (ver server.ts); con
// la flag apagada estas rutas responden 404 y el API se comporta idéntico. Todas
// las operaciones exigen rol ADMIN (server.authorize(['ADMIN'])).
//
// El I/O de red real NO se ejercita en tests (la ruta no se registra sin la flag,
// y la flag está OFF por defecto). Las credenciales del dispositivo llegan en el
// body y se pasan por llamada al servicio; NUNCA se loguean.
//
// SSRF: el servicio valida `deviceUrl` (LAN-only, bloquea metadatos cloud) antes
// de cualquier POST. Un OnvifError('SSRF_BLOCKED'|'INVALID_URL') → HTTP 400.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { OnvifService, isOnvifError } from '../services/onvif'

const credsSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
})

const deviceSchema = z.object({
  deviceUrl: z.string().url().max(2048),
  creds: credsSchema,
})

const ptzVectorSchema = z.object({
  x: z.number().min(-1).max(1).optional(),
  y: z.number().min(-1).max(1).optional(),
  zoom: z.number().min(-1).max(1).optional(),
})

const imagingSchema = z.object({
  brightness: z.number().optional(),
  contrast: z.number().optional(),
  colorSaturation: z.number().optional(),
  sharpness: z.number().optional(),
  irCutFilter: z.enum(['ON', 'OFF', 'AUTO']).optional(),
  focus: z
    .object({
      autoFocusMode: z.enum(['AUTO', 'MANUAL']).optional(),
      defaultSpeed: z.number().optional(),
    })
    .optional(),
})

function buildService(): OnvifService {
  const timeoutMs = Number(process.env.ONVIF_SOAP_TIMEOUT_MS) || undefined
  return new OnvifService({
    timeoutMs,
    ssrfPolicy: { allowPublic: process.env.ONVIF_ALLOW_PUBLIC === 'true' },
  })
}

/** Mapea OnvifError a un status HTTP; nunca filtra credenciales ni cuerpos SOAP. */
function statusFor(code: string): number {
  switch (code) {
    case 'NOT_ENABLED':
      return 404
    case 'SSRF_BLOCKED':
    case 'INVALID_URL':
    case 'INVALID_ARG':
      return 400
    case 'TIMEOUT':
      return 504
    case 'SOAP_FAULT':
    case 'TRANSPORT_ERROR':
    case 'PARSE_ERROR':
      return 502
    default:
      return 500
  }
}

export const onvifRoutes: FastifyPluginAsync = async (server) => {
  const admin = { preHandler: [server.authorize(['ADMIN'])] }

  const handle = async (reply: import('fastify').FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return reply.send(await fn())
    } catch (e) {
      if (isOnvifError(e)) return reply.status(statusFor(e.code)).send({ code: e.code, message: e.message })
      server.log.error('onvif_route_error')
      return reply.status(500).send({ code: 'INTERNAL', message: 'error interno' })
    }
  }

  server.post('/discover', admin, async (request, reply) => {
    const timeoutMs = Number(process.env.ONVIF_DISCOVERY_TIMEOUT_MS) || undefined
    return handle(reply, async () => ({ devices: await buildService().discover({ timeoutMs }) }))
  })

  server.post('/device-information', admin, async (request, reply) => {
    const { deviceUrl, creds } = deviceSchema.parse(request.body)
    return handle(reply, () => buildService().getDeviceInformation(deviceUrl, creds))
  })

  server.post('/profiles', admin, async (request, reply) => {
    const { deviceUrl, creds } = deviceSchema.parse(request.body)
    return handle(reply, async () => ({ profiles: await buildService().getProfiles(deviceUrl, creds) }))
  })

  server.post('/stream-uri', admin, async (request, reply) => {
    const body = deviceSchema.extend({ profileToken: z.string().min(1).max(256) }).parse(request.body)
    return handle(reply, async () => ({ uri: await buildService().getStreamUri(body.deviceUrl, body.creds, body.profileToken) }))
  })

  server.post('/ptz/configurations', admin, async (request, reply) => {
    const { deviceUrl, creds } = deviceSchema.parse(request.body)
    return handle(reply, async () => ({ configurations: await buildService().getPtzConfigurations(deviceUrl, creds) }))
  })

  server.post('/ptz/move', admin, async (request, reply) => {
    const body = deviceSchema
      .extend({ profileToken: z.string().min(1).max(256), velocity: ptzVectorSchema })
      .parse(request.body)
    return handle(reply, async () => {
      await buildService().ptzMove(body.deviceUrl, body.creds, body.profileToken, body.velocity)
      return { ok: true }
    })
  })

  server.post('/ptz/stop', admin, async (request, reply) => {
    const body = deviceSchema.extend({ profileToken: z.string().min(1).max(256) }).parse(request.body)
    return handle(reply, async () => {
      await buildService().ptzStop(body.deviceUrl, body.creds, body.profileToken)
      return { ok: true }
    })
  })

  server.post('/imaging/get', admin, async (request, reply) => {
    const body = deviceSchema.extend({ videoSourceToken: z.string().min(1).max(256) }).parse(request.body)
    return handle(reply, async () => ({ settings: await buildService().getImaging(body.deviceUrl, body.creds, body.videoSourceToken) }))
  })

  server.post('/imaging/set', admin, async (request, reply) => {
    const body = deviceSchema
      .extend({ videoSourceToken: z.string().min(1).max(256), settings: imagingSchema })
      .parse(request.body)
    return handle(reply, async () => {
      await buildService().setImaging(body.deviceUrl, body.creds, body.videoSourceToken, body.settings)
      return { ok: true }
    })
  })
}

export default onvifRoutes
