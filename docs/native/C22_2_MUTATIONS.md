# C22.2 · Pruebas de mutación

Runner endurecido en `tools/mutation-run.mjs`: exige árbol limpio + HEAD esperado
(`MUT_EXPECTED_HEAD`), corre BASELINE por test (distingue "detectada" de "test ya
roto") y restaura por contenido capturado (+ trap de señales). El parche acumulado
debe estar committeado antes de correrlo.

**12/12 detectadas**; árbol limpio tras revertir.

| # | Mutación (revierte una defensa) | Archivo | Prueba | P0 |
|---|---|---|---|---|
| M1 | Reducer sin check REVOKED | `grant-store.ts` | `media-grants.test` | P0-1A |
| M2 | Reducer sin check EXPIRED | `grant-store.ts` | `media-grants.test` | P0-1B |
| M3 | Reducer sin check EPOCH | `grant-store.ts` | `media-grants.test` | P0-2 |
| M4 | Reducer sin check INSTANCE | `grant-store.ts` | `media-grants.test` | P0-4 |
| M5 | Reducer sin uso único (REPLAYED) | `grant-store.ts` | `media-grants.test` | P0-1 |
| M6 | `issue` inventa instancia (no NO_MEDIA_INSTANCE) | `media-grants.ts` | `media-grants.test` | P0-4 |
| M7 | Revocación server-side se traga el fallo | `grant-service.ts` | `grant-service.test` | P0-3 |
| M8 | Readiness ignora salud del backend | `native-readiness.ts` | `liveView.route.test` | P0-5 |
| M9 | RBAC HD siempre permite | `native-readiness.ts` | `mediaGrants.route.test` | P0-5 |
| M10 | Session sin re-check tras `dispose(prev)` | `session-controller.ts` | `session-controller.test` | P0-6 |
| M11 | Pipeline sin gate de concurrencia real | `pipeline.ts` | `pipeline.test` | P0-7 |
| M12 | Coordinator: A tardía reemplaza B | `coordinator.ts` | `coordinator.test` | P0-4 |

Cada mutación corresponde a una defensa de los defectos P0-1..P0-7; eliminarla
rompe al menos una prueba conductual (no guarda estructural).
