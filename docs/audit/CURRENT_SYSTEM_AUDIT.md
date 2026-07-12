# VisionCore — Auditoría del sistema actual

> Fuente de verdad: código del repositorio en la rama `main` (commit de partida `c4d7c72`).
> Esta auditoría fue el paso previo obligatorio al desarrollo de la rama
> `claude/visioncore-complete-platform`. No describe intenciones: describe lo que
> el código realmente hace hoy.

## 1. Arquitectura general

Monorepo con cuatro piezas + infraestructura:

| Componente | Stack | Rol |
|---|---|---|
| `apps/api` | Fastify + Prisma + PostgreSQL + Redis | API REST/WS, orquestación de streams, ISAPI, VOD |
| `apps/web` | React 18 + Vite + Zustand + axios | SPA de operación |
| `apps/analytics` | FastAPI + OpenCV + ONNX Runtime + Supervision | IA de video (detección/tracking/zonas) |
| `prisma` | schema + 19 migraciones SQL | modelo de datos |
| `infra` | MediaMTX, Nginx, Certbot | restream RTSP→HLS/WebRTC, proxy, TLS |

Flujo de video: `NVR → (RTSP) → MediaMTX → HLS/WebRTC (Live View) / RTSP (Analytics)`.
MediaMTX es (por diseño desde `main`) el único consumidor RTSP del NVR para el
substream; Analytics consume el restream compartido, no el NVR directo.

## 2. Módulos del API (`apps/api/src/routes`)

`admin, alertSettings, alerts, analytics, appearance, auth, cameras, liveView,
nvr, nvrConfig, profile, recordings, search, users, views, websocket`.

Servicios (`apps/api/src/services`): `hikvision` (ISAPI), `stream` (MediaMTX +
FFmpeg transcode), `stream-manager` (sesiones live + refcount live),
`stream-validator` (salud RTSP), `recordingProvider`, `recordings/rtsp-url`
(helpers puros de playback), `credentials` (AES único), `session-store`
(Redis/memoria para download tokens), `notification.service` (SMTP), `nvrSync`,
`audit`, `totp`, `rtsp-probe`.

## 3. Modelo de datos (18 modelos Prisma)

`User, Session, NVR, NvrHdd, Camera, UserPermission, UserFeaturePermissions,
AuditLog, Alert, CameraView, CameraViewAccess, AppearanceSettings,
NotificationDelivery, NvrChannelConfigBackup, CameraAnalyticsConfig,
AnalyticsEvent, LicensePlateEvent, AlertSettings`.

Migraciones relevantes recientes: `0016` índices de rendimiento, `0017` analítica
(config + eventos), `0018` líneas de conteo, `0019` alertas configurables +
loitering/aforo + scaffold ALPR (`LicensePlateEvent`).

## 4. Servicio de analítica (`apps/analytics`)

- `main.py`: FastAPI con arranque en hilo de fondo (nunca tumba el proceso),
  `/health`, `/status`, `/frame/{cameraId}`.
- `pipeline.py`: `PipelineManager` (carga de modelo con reintentos + reconcile de
  workers) y `CameraWorker` (1 hilo por cámara: captura RTSP/TCP, muestreo,
  inferencia, ByteTrack, zonas `PolygonZone`, líneas `LineZone`, loitering,
  aforo, publicación de eventos con snapshot).
- `detector.py`: `YoloxDetector` (ONNX Runtime, pre/post-proceso YOLOX, NMS de
  Supervision). Descarga el modelo con timeout.
- `config.py`: settings vía pydantic-settings; transporte RTSP TCP forzado.

## 5. Estado de la integración compartida de streams

- El API en `analytics.internal/cameras` registra el path de MediaMTX
  (`publishStream`) y devuelve `analyticsRtspUrl` (restream) — `directRtspUrl`
  solo con `ANALYTICS_ALLOW_DIRECT_RTSP=true`.
- Refcount actual: `Map<string, number>` en `stream.ts`
  (`markAnalyticsConsumer/hasAnalyticsConsumer`), consultado por `removeStream`
  para no borrar un path que Analytics usa. **Solo en memoria y solo
  "analytics"** — no hay tipos `live/recording/diagnostic` ni backend Redis
  (deuda documentada en `TECHNICAL_DEBT.md`).

## 6. Observabilidad y seguridad (estado)

- Logs estructurados presentes en analytics (`analytics_worker_*`,
  `analytics_event_*`) y en stream (`mediamtx_shared_path_*`). No hay endpoint
  `/metrics` Prometheus.
- Seguridad: JWT + refresh (mutex de refresh en `api.ts`), helmet, CORS por env,
  rate-limit en login/reset, credenciales NVR cifradas (AES) y enmascaradas en
  logs, guarda de path-traversal en descargas, endpoints internos de analytics
  con secreto compartido (comparación timing-safe).

## 7. Tests presentes al inicio

`apps/api`: `credentials`, `session-store`, `stream-consumers`,
`recordings/rtsp-url` (61 casos aprox. en 4 archivos).
`apps/web`: `components/recordings/utils`.
`apps/analytics`: **ninguno** (solo `compileall` en CI).

## 8. CI

`.github/workflows/ci.yml`: jobs api (prisma validate/generate + build + tests),
web (build + tests), analytics (`py_compile`), licencias (sin GPL/AGPL).
Node 22, `workflow_dispatch` habilitado.

## 9. Conclusión de la auditoría

El núcleo VMS (NVRs, cámaras, live, visores, grabaciones, alertas, auth,
permisos) está **implementado y en producción**. La analítica está
**implementada** con la arquitectura correcta de streams compartidos, pero tiene
**deuda de robustez y extensibilidad**: refcount solo-memoria, pipeline acoplado
a YOLOX (sin abstracción de provider), sin métricas Prometheus, sin tests Python,
y los módulos de caídas/ALPR son scaffolds parciales. El trabajo de esta rama se
concentra en esas brechas — ver `FEATURE_MATRIX.md`, `MISSING_FEATURES.md` y
`TECHNICAL_DEBT.md`.
