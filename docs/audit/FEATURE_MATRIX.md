# VisionCore — Matriz de funcionalidades

Estados: **IMPLEMENTADA Y VALIDADA** · **IMPLEMENTADA SIN VALIDACIÓN SUFICIENTE** ·
**PARCIAL** · **DEFECTUOSA** · **AUSENTE** · **REQUIERE MODELO EXTERNO** ·
**REQUIERE SDK NATIVO** · **NO VIABLE COMPLETAMENTE EN NAVEGADOR**.

> "Validada" = cubierta por tests automatizados en el repo o por lógica pura
> testeada. Live/Grabaciones están probadas en producción pero con poca cobertura
> automatizada → "impl. sin validación suficiente".

| Módulo | Funcionalidad | Estado | Archivos | Tests | Problema | Cambio requerido | Riesgo regresión |
|---|---|---|---|---|---|---|---|
| Auth | Login / JWT / refresh mutex | IMPL. SIN VALIDACIÓN SUFICIENTE | `apps/api/src/routes/auth.ts`, `apps/web/src/lib/api.ts` | parcial | refresh concurrente sin test | tests de concurrencia 401 | bajo |
| Auth | 2FA TOTP | IMPLEMENTADA | `routes/auth.ts`, `services/totp.ts` | no | — | — | — |
| Permisos | RBAC + por NVR/cámara | IMPLEMENTADA | `middleware/requireAuth`, `routes/*` | no | falta test IDOR | tests de permisos | medio |
| NVRs | alta/edición/salud/sync | IMPL. SIN VALIDACIÓN SUFICIENTE | `routes/nvr.ts`, `services/nvrSync.ts` | no | monolito grande | (no tocar) | — |
| Cámaras | listado/snapshot/PTZ | IMPLEMENTADA | `routes/cameras.ts` | no | — | — | — |
| Live View | layouts/slots/HD/HEVC/reconn | IMPL. SIN VALIDACIÓN SUFICIENTE | `pages/LiveViewPage.tsx`, `services/stream-manager.ts` | no | sin tests de ciclo de vida | tests de refcount live | medio |
| Live View | zoom digital / captura | IMPLEMENTADA | `LiveViewPage.tsx` | no | — | — | — |
| Visores | guardar/compartir/slideshow | IMPLEMENTADA | `routes/views.ts`, `pages/ViewsPage.tsx` | no | — | — | — |
| Grabaciones | búsqueda/timeline/multicam sync | IMPL. SIN VALIDACIÓN SUFICIENTE | `pages/RecordingsPage.tsx`, `routes/recordings.ts` | parcial (`rtsp-url`) | máquina de estados implícita | formalizar estados + tests | medio |
| Grabaciones | continuidad por timer/ended | IMPLEMENTADA | `RecordingsPage.tsx` | no | — | tests de regresión | medio |
| Grabaciones | MP4 bajo demanda + caché + token | IMPLEMENTADA | `routes/recordings.ts`, `services/session-store.ts` | `session-store` | — | — | bajo |
| Grabaciones | 453 / fallback variantes | IMPLEMENTADA Y VALIDADA | `services/recordings/rtsp-url.ts` | sí | — | — | bajo |
| Grabaciones | reversa real / frame atrás | REQUIERE SDK NATIVO | — | — | fMP4 no soporta | worker HCNetSDK aparte | — |
| Streams | MediaMTX compartido live+analytics | IMPLEMENTADA Y VALIDADA | `services/stream.ts`, `routes/analytics.ts` | `stream-consumers` | refcount solo memoria/1 tipo | **StreamConsumerRegistry** | medio |
| Analytics | servicio never-crash + /health /status | IMPLEMENTADA | `apps/analytics/app/main.py` | no (compileall) | sin tests | pytest lifecycle | bajo |
| Analytics | detección YOLOX ONNX | IMPLEMENTADA | `detector.py` | no | acoplado al pipeline | **DetectionProvider** | medio |
| Analytics | ByteTrack / PolygonZone / LineZone | IMPLEMENTADA | `pipeline.py` | no | sin TraceAnnotator | tests + trazas | bajo |
| Analytics | eventos person/vehicle/zone/line | IMPLEMENTADA | `pipeline.py`, `routes/analytics.ts` | no | — | tests de reglas | medio |
| Analytics | loitering / occupancy | IMPLEMENTADA | `pipeline.py` | no | sin test | pytest | bajo |
| Analytics | señal perdida/tampering/obstrucción | AUSENTE | — | — | no existe | eventos nuevos (futuro) | — |
| Analytics | alertas configurables por evento | IMPLEMENTADA | `routes/analytics.ts` | no | — | — | bajo |
| Analytics | UI Estado/Config/Vivo/Eventos/Dash/Forense | IMPLEMENTADA | `pages/AnalyticsPage.tsx` | no | falta pestaña "Estado" separada | extender UI | bajo |
| Detección caídas | pose + reglas | REQUIERE MODELO EXTERNO | — | — | no existe modelo | **scaffold provider + flag** | — |
| ALPR | detección + OCR matrícula | REQUIERE MODELO EXTERNO | `LicensePlateEvent`, `routes/analytics.ts` (search) | no | sin modelo/OCR | **scaffold providers + flag** | — |
| Alertas | campana/WS/email + retención | IMPLEMENTADA | `routes/alerts.ts`, `notification.service.ts`, `jobs/healthWorker.ts` | no | delivery sin retry robusto | retry + tests | bajo |
| DB | índices analítica/alertas/audit | IMPLEMENTADA | `prisma/migrations/0016..0019` | — | falta índice className/zone | migración índices | bajo |
| Observabilidad | logs estructurados | PARCIAL | analytics + stream | — | sin `/metrics` | endpoint Prometheus | bajo |
| Seguridad | helmet/cors/rate-limit/mask | IMPLEMENTADA | `server.ts`, `services/*` | parcial | falta test path-traversal | tests seguridad | bajo |
| Help Center | manual flotante | IMPLEMENTADA | `components/help/*` | no | falta temas nuevos | añadir topics | bajo |
| CI | build+test+licencias | IMPLEMENTADA | `.github/workflows/ci.yml` | — | sin pytest ni compose config | ampliar CI | bajo |

## Resumen por prioridad de intervención (solo PARCIAL/DEFECTUOSO/AUSENTE)

1. **StreamConsumerRegistry** (evoluciona refcount memoria→Redis, 4 tipos) — sección 5.
2. **DetectionProvider abstraction** (desacoplar YOLOX) — sección 8/9.
3. **Scaffold Fall detection + completar ALPR arch** (flags, providers, tests mock, docs) — 12/13.
4. **`/metrics` Prometheus + logs** — sección 18.
5. **Tests** Python (pytest) + API (analytics/consumer) + seguridad.
6. **Índices DB** faltantes (className/zoneName/direction) — sección 15.
7. **Docs** arquitectura/analytics/seguridad + Help Center topics.
