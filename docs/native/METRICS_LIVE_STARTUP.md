# Métricas de arranque de LiveView (C22, Hito 4)

Desglose por etapas del tiempo hasta el primer frame, con **cardinalidad
acotada**: los únicos labels son `stage` (conjunto fijo) y `outcome` (conjunto
fijo). **Nunca** se usan `cameraId`, `userId`, token ni URI como labels.

## Métricas Prometheus

| Métrica | Tipo | Labels | Origen |
|---|---|---|---|
| `visioncore_live_transcode_hls_ready_seconds` | histogram | `outcome` | C21 (spawn→HLS listo) |
| `visioncore_live_transcode_startup_total` | counter | `outcome` | C21 |
| `visioncore_live_transcode_capacity/processes/available/starting/retained` | gauge | — | C21 |
| `visioncore_live_startup_stage_seconds` | histogram | `stage`, `outcome` | **C22** (desglose por etapa) |

## Etapas (`stage`)

| stage | Tramo | Dónde se mide | Estado C22 |
|---|---|---|---|
| `request_to_admission` | solicitud → admisión (cupo) | API | definido; wiring incremental |
| `admission_to_spawn` | admisión → spawn FFmpeg | API | definido; wiring incremental |
| `spawn_to_hls_ready` | spawn → manifiesto HLS usable | API | **INSTRUMENTADO** (reusa `elapsedMs` de C21) |
| `manifest_to_first_frame` | manifiesto → primer frame | cliente (web) | helper `firstFrameTiming.ts` |
| `close_to_slot_free` | cierre → cupo disponible | API | definido; wiring incremental |
| `wait_for_slot` | espera por cupo (2 ocupados) | API | definido; wiring incremental |
| `native_start_to_first_frame` | inicio nativo → primer frame | cliente (nativo) | helper `firstFrameTiming.ts` |

`outcome ∈ { ready, process_exited, partial_manifest, timeout, cancelled }`.

## Garantía de cardinalidad

`services/live-startup-timing.ts` expone `isBoundedStageLabels()` y las pruebas
verifican que el render del histograma no contiene identificadores de alta
cardinalidad. Cualquier call-site nuevo debe usar sólo `{stage, outcome}`.

## Optimización (medición, no cambios de comportamiento)

C21 ya estableció con prueba de producción que el cierre libera el cupo en el
mismo segundo y que los ~5–7 s visibles son la preparación HLS. C22 no reduce el
TTL de 90 s ni sube `MAX_TRANSCODE_SESSIONS` (permanece en 2). Las palancas a
medir antes de tocar nada (GOP/keyframes, LL-HLS/fMP4, duración de segmentos,
precalentamiento sin cupo huérfano) se instrumentan aquí primero; sólo se
conserva una optimización si reduce el tiempo de forma medible sin romper el
lifecycle ni aumentar procesos por encima de dos.
