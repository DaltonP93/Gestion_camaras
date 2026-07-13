# VisionCore — Arquitectura del sistema

## Componentes

```
                         ┌──────────────┐
             HLS/WebRTC  │   apps/web    │  React SPA (Vista en vivo, Grabaciones,
        ┌───────────────▶│  (nginx)      │  Analítica, Alertas, Admin, Help Center)
        │                └──────┬───────┘
        │                       │ REST / WS (JWT)
        │                ┌──────▼───────┐   Prisma    ┌────────────┐
        │                │   apps/api    │────────────▶│ PostgreSQL │
        │                │  (Fastify)    │             └────────────┘
        │                │              │   ioredis    ┌────────────┐
        │                │              │─────────────▶│   Redis    │
        │                └──┬────────┬──┘             └────────────┘
        │        ISAPI/HTTP │        │ REST v3 (config paths)
        │            ┌──────▼──┐  ┌──▼────────┐
        │            │  NVRs   │  │ MediaMTX  │◀── restream RTSP (sourceOnDemand)
        │            │(Hikvision)│ │           │
        │            └─────────┘  └──┬─────┬──┘
        └───────────────────────────┘     │ RTSP (TCP)
                                           ▼
                                   ┌───────────────┐   webhook (secreto)   ┌────────┐
                                   │ apps/analytics │──────────────────────▶│  api   │
                                   │ (FastAPI + IA) │   eventos + snapshot   └────────┘
                                   └───────────────┘
```

## Flujo de video (regla central)

`NVR → MediaMTX → { Vista en vivo (HLS/WebRTC), Analytics (RTSP/TCP), diagnósticos }`

- **MediaMTX es el único consumidor RTSP del NVR** para cada substream. Live y
  Analytics leen el mismo restream (`sourceOnDemand`), evitando abrir una segunda
  sesión que el NVR (limitado en sesiones) cortaría.
- El ciclo de vida del path se coordina con el **StreamConsumerRegistry**
  (ver `docs/analytics/ARCHITECTURE.md`): un path no se elimina mientras tenga
  consumidores vigentes (`live`, `analytics`, `recording`, `diagnostic`).

## Estado compartido

- **PostgreSQL** (Prisma): entidades de dominio.
- **Redis**: download tokens (grabaciones), StreamConsumerRegistry, y estados que
  no deben perderse al reiniciar el API. Fallback a memoria en desarrollo. Nunca
  se guardan credenciales ni URLs RTSP con secretos.
- **Memoria de proceso**: sesiones que sostienen un FFmpeg (preview/transcode)
  son locales por naturaleza (requieren sticky routing en multi-worker).

## Seguridad (resumen)

JWT + refresh con mutex en el cliente, RBAC + permisos por NVR/cámara, helmet,
CORS por env, rate-limit en login/reset, credenciales NVR cifradas (AES) y
enmascaradas en logs, endpoints internos de analítica con secreto compartido
(comparación timing-safe), guardas de path-traversal en descargas. Detalle en
`docs/security/SECURITY_AUDIT.md`.

## Observabilidad

Logs estructurados (`analytics_*`, `consumer_*`, `mediamtx_path_*`,
`recording_*`) y endpoint `/metrics` (Prometheus) en el API. El servicio de
analítica expone `/health` y `/status`; el API los agrega en
`/api/analytics/service-status`.

## Directorios

- `apps/api/src/routes` — endpoints; `services` — lógica (stream, hikvision,
  recordings, credentials, session-store, stream-consumer-registry, metrics…).
- `apps/web/src` — páginas, componentes, stores (Zustand), `lib/api.ts`.
- `apps/analytics/app` — `main.py`, `pipeline.py`, `rules.py`, `providers/`.
- `prisma` — schema + migraciones aditivas.
- `infra` — MediaMTX, Nginx, Certbot.
