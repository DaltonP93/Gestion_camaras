# Analítica — Arquitectura

## Servicio (`apps/analytics`)

FastAPI que **nunca muere**: el arranque pesado (imports de cv2/onnx/supervision,
carga del modelo) ocurre en un hilo de fondo (`main._boot`) protegido con
try/except. `/health` y `/status` responden aunque el modelo esté caído.

### Estados del servicio
`starting · running · degraded · model_error · api_error · stopping`
(expuestos en `serviceStatus`). `/health` → `{status: ok|degraded, serviceStatus,
modelLoaded}`.

### PipelineManager
- `_model_loop`: crea el `DetectionProvider` vía factory y lo carga con
  reintentos (cada `MODEL_RETRY_SEC`). Un modelo caído deja `model_error` pero
  el proceso sigue.
- `_refresh_loop`: cada `REFRESH_INTERVAL_SEC` consulta
  `GET /api/analytics/internal/cameras` (secreto compartido) y reconcilia
  workers (crea/actualiza/detiene). Respeta `MAX_WORKERS`.
- `restart_worker(cameraId)`: reinicio manual (p.ej. tras `disabled_due_errors`).

### CameraWorker (1 hilo por cámara)
`captura → muestreo (sampleFps) → provider.infer → ByteTrack → reglas
(zonas/líneas/loitering/aforo) → snapshot anotado → webhook`.

Estados por worker: `starting · running · reconnecting · rtsp_down ·
disabled_due_errors · stopped`.

Robustez:
- **Transporte RTSP TCP forzado** (`OPENCV_FFMPEG_CAPTURE_OPTIONS`) — MediaMTX es
  TCP-only; sin esto no llegan frames.
- **Backoff exponencial** (`10s/30s/60s/300s`) + **circuit breaker**: tras N
  fallos consecutivos el worker queda `disabled_due_errors` hasta cambio de
  config o reinicio manual. Un worker en error no afecta a los demás.
- Consume `analyticsRtspUrl` (restream MediaMTX). `directRtspUrl` solo si
  `ANALYTICS_ALLOW_DIRECT_RTSP=true`.

## StreamConsumerRegistry (`apps/api`)

`apps/api/src/services/stream-consumer-registry.ts`. Refcount de consumidores por
path de MediaMTX.

- Operaciones: `acquire · renew · release · count · list · cleanupExpired`.
- Tipos: `live · analytics · recording · diagnostic`.
- Identidad: `streamPath, consumerType, consumerId, createdAt, lastHeartbeat,
  expiresAt`.
- Backend Redis (sobrevive reinicios, multi-worker) + fallback memoria.
- `removeStream` no borra un path con consumidores vigentes (log
  `mediamtx_path_kept`). Analytics renueva su lease en cada poll; al deshabilitar
  la cámara, deja de renovar y el lease expira (o se libera).

## Separación de responsabilidades

- **Provider** (`providers/`): detección (modelo). Ver `PROVIDERS.md`.
- **rules.py**: cooldown, deduplicación por tracker, horarios, backoff, circuit
  breaker — puro, testeable sin cv2.
- **pipeline.py**: orquestación, tracking, zonas/líneas, anotación, publicación.
- **API `routes/analytics.ts`**: config por cámara, feed interno de cámaras,
  webhook de eventos → Alert + AnalyticsEvent, status/frame proxy, búsqueda.

## Flujo de un evento

```
worker detecta → aplica reglas (dedupe/cooldown/schedule) → POST /internal/events
  → API valida secreto → guarda snapshot (/uploads/analytics) → crea AnalyticsEvent
  → según alertConfig: crea Alert (campana/WS) y/o dispara email (no bloquea)
```
