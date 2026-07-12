# VisionCore — Funcionalidades faltantes / parciales y plan

Lista accionable de lo que esta rama aborda, en orden de valor y tractabilidad.
Cada ítem indica si se implementa **real** o se deja **scaffold** (con feature
flag) por requerir un modelo/SDK externo.

## A. Registry de consumidores de stream (REAL)
- Hoy: `Map<streamPath, expiresAt>` en memoria, solo tipo "analytics".
- Falta: abstracción `StreamConsumerRegistry` con `acquire/renew/release/count/
  list/cleanupExpired`, tipos `live|analytics|recording|diagnostic`, identidad
  (`streamPath, consumerType, consumerId, createdAt, lastHeartbeat, expiresAt`),
  backend Redis con fallback memoria, y logs `consumer_acquired/renewed/released`.
- Regla clave: un path no se borra mientras tenga consumidores; no se guardan
  credenciales RTSP en Redis.

## B. Abstracción de providers de detección (REAL)
- Hoy: `pipeline.py` importa `YoloxDetector` directo.
- Falta: interfaz `DetectionProvider` (`load/unload/infer/health/metadata`) e
  implementación `YoloxOnnxProvider`; el pipeline consume la interfaz. Prepara
  extensión a otros modelos ONNX sin tocar el pipeline.

## C. Detección de caídas (SCAFFOLD — requiere modelo externo)
- No implementar con caja inclinada. Interfaces `PoseEstimationProvider` y
  `FallDetectionProvider`, eventos `FALL_DETECTED/PERSON_DOWN/IMMOBILITY_DETECTED`,
  feature flag `ANALYTICS_FALL_DETECTION_ENABLED=false`, tests con mocks,
  estado "modelo no instalado". Sin modelo ONNX validado no se activa.

## D. ALPR / matrículas (SCAFFOLD — requiere modelo externo)
- `LicensePlateEvent` ya existe + búsqueda parcial en el API. Falta: interfaces
  `PlateDetectorProvider` y `PlateOcrProvider`, feature flag
  `ANALYTICS_ALPR_ENABLED=false`, tests mock, doc de modelos compatibles
  (licencia permisiva). No incluir dependencia AGPL.

## E. Observabilidad Prometheus (REAL)
- Endpoint `/metrics` en el API (formato texto Prometheus, sin dependencia
  pesada) exponiendo consumidores de MediaMTX, sesiones de preview y errores.
  El servicio analytics ya expone `/status` (agregado por el API en
  `/api/analytics/service-status`).

## F. Índices de DB faltantes (REAL)
- `AnalyticsEvent(className, occurredAt)`, `AnalyticsEvent(zoneName, occurredAt)`,
  `AnalyticsEvent(direction, occurredAt)` — las consultas de Forense filtran por
  esos campos y hoy no tienen índice compuesto con `occurredAt`.

## G. Tests (REAL)
- Python (pytest): provider mock, worker lifecycle/backoff, cooldown/dedupe,
  zonas/líneas/loitering/occupancy, API/MediaMTX caídos, modelo ausente.
- API: registry de consumidores (tipos + expiración + concurrencia).

## H. Documentación + Help Center (REAL)
- `docs/architecture`, `docs/analytics`, `docs/recordings`, `docs/security`,
  `docs/development` + temas nuevos en el Help Center (analítica avanzada,
  caídas, ALPR, estados de servicio).

## Fuera de alcance de esta rama (documentado, no implementado)
- Reproducción reversa/frame-atrás real y decodificación nativa multicanal →
  **REQUIERE SDK NATIVO** (HCNetSDK) en un worker separado, nunca dentro del API.
- Canales WhatsApp/Telegram/SMS → solo se deja la arquitectura de delivery
  preparada; no se integran proveedores concretos.
- Modelos de caídas y ALPR productivos → requieren pesos con licencia
  compatible; se entrega la arquitectura + mocks + docs.
