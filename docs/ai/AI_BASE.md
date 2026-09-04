# Base de IA de VisionCore (C22, Hito 5)

Base **desacoplada y verificable** para futuras capacidades de analítica. **No**
implementa un sistema de inferencia productivo: provee contratos, cola con
backpressure, circuit breaker, proveedor mock y una ruta de demostración
determinista. Todo detrás de `AI_EVENTS_ENABLED` (apagado por defecto).

## Piezas

| Módulo | Rol |
|---|---|
| `services/ai/contracts.ts` | `AnalyticsEvent`, `Detection`, `Track`, `Alert`, `InferenceProvider`, estado/versión de modelo, política de retención/dedup |
| `services/ai/queue.ts` | Cola acotada (por cámara + global), backpressure drop-newest |
| `services/ai/circuit-breaker.ts` | Aísla al pipeline de un proveedor caído (closed/open/half-open) |
| `services/ai/mock-provider.ts` | `InferenceProvider` mock (sólo pruebas/demo) |
| `services/ai/pipeline.ts` | Orquesta proveedor + cola + breaker + timeout + dedup; nunca bloquea el video |
| `routes/aiDemo.ts` | `POST/GET /api/ai/demo/*` con eventos deterministas (`source: 'demo'`) |

## Garantías

- **No bloquea el video**: `submit` es O(1) y no lanza; `drainOne` está aislado
  con try/catch. Un proveedor caído produce `error`/`timeout`, nunca una
  excepción hacia el camino del stream.
- **Memoria acotada**: la cola rechaza al llenarse (por cámara y global).
- **Restream compartido**: `InferenceInput.streamPath` referencia el restream de
  MediaMTX; el pipeline NO abre una 2.ª conexión al NVR por consumidor de IA
  (se integra vía `StreamConsumerRegistry`, tipo `analytics`).
- **Sin fingir detección**: los eventos de la demo se marcan `source: 'demo'`.

## Cómo se conectaría un proveedor real (fase posterior)

El servicio Python existente (YOLOX/ONNX) implementa `InferenceProvider` o envía
`AnalyticsEvent` por el webhook interno actual (`/api/analytics/internal/...`,
secreto compartido timing-safe). El pipeline TS queda como capa de resiliencia
(cola/breaker/dedup) delante del consumidor, sin acoplarse a YOLOX.

## Funciones futuras (diseño, no implementadas aquí)

- Personas y vehículos (clasificación + tracking).
- Cruce de línea, zonas (intrusión/permanencia), conteo/aforo.
- Búsqueda por eventos y alertas configurables (ya existen modelos Prisma).
- **Privacidad**: minimización de snapshots, enmascarado, acceso por RBAC.
- **Retención**: TTL por tipo de evento; purga verificable.
- **Evaluación de precisión**: dataset etiquetado, métricas P/R por clase antes
  de declarar cualquier detección "productiva".
