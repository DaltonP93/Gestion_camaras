# C22.1 · Pruebas de mutación

Runner reproducible en `tools/mutation-run.mjs` (`node tools/mutation-run.mjs`).
Cada mutación se aplica sobre el árbol committeado, corre la prueba objetivo y se
revierte con `git checkout`. **12/12 detectadas**; árbol limpio tras revertir.

| # | Mutación (revierte una defensa) | Archivo | Prueba que la detecta |
|---|---|---|---|
| M1 | Perder una actualización del índice | `media/grant-store.ts` | `media-grants.test` · revokeAll concurrente / >256 |
| M2 | Volver a no-atómico (claimUse siempre true) | `media/grant-store.ts` | `media-grants.test` · cross-process uno gana |
| M3 | Omitir revocación en logout/permisos | `media/grant-service.ts` | `users.permissions-revoke.test` (inject) |
| M4 | Hacer la instancia opcional | `media/media-grants.ts` | `media-grants.test` · INSTANCE_REQUIRED |
| M5 | Scope no server-derivado (tipo efectivo) | `routes/mediaGrants.ts` | `mediaGrants.route.test` · HEVC⇒main |
| M6 | Quitar dispose de A (open A→B) | `native/session-controller.ts` | `session-controller.test` |
| M7 | Permitir que A tardía reemplace B | `native/coordinator.ts` | `coordinator.test` (decoder abrió sólo B) |
| M8 | Olvidar pending tras error de revoke | `native/grant-client.ts` | `grant-client.test` · pending/retry |
| M9 | Quitar RBAC de la demo de IA | `routes/aiDemo.ts` | `aiDemo.route.test` · no-admin 403 |
| M10 | Quitar AbortController (timeout no aborta) | `ai/pipeline.ts` | `pipeline.test` · abort + inFlight 0 |
| M11 | Eliminar cleanup de dedup | `ai/pipeline.ts` | `pipeline.test` · dedup acotado |
| M12 | Respuesta contradictoria (nativeDirect) | `routes/liveView.ts` | `liveView.route.test` · coherencia |

Estas mutaciones corresponden a la lista obligatoria del correctivo: pérdida de
índice, lock sólo local, omitir revocación, instancia opcional, confiar en el
cliente, quitar dispose de A, A tardía reemplaza B, olvidar pending, quitar RBAC
de IA, quitar AbortController, eliminar cleanup de dedup y respuesta contradictoria.
