# C22 · Pruebas de mutación

Cada mutación se aplicó sobre el árbol committeado, se corrió la prueba objetivo
y se revirtió con `git checkout`. **12/12 detectadas**; árbol limpio tras
revertir. Confirma que las pruebas verifican comportamiento, no sólo estructura.

| # | Mutación | Archivo | Prueba que la detectó |
|---|---|---|---|
| M1 | Aceptar grant vencido (`now>=expiresAt`→`false`) | `media-grants.ts` | `media-grants.test.ts` · "T3 · vencido ⇒ EXPIRED" |
| M2 | Omitir validación de cámara (quita `cameraId!==scope`) | `media-grants.ts` | `media-grants.test.ts` · "T6 · cross-camera" |
| M3 | Reutilizar grant revocado (`revokedAt!==null`→`false`) | `media-grants.ts` | `media-grants.test.ts` · "T4 · revocado" |
| M4 | Quitar cierre al cambiar vista (invalidate no hace dispose) | `native/session-controller.ts` | `session-controller.test.ts` · "invalidate libera el handle" |
| M5 | Permitir tercer transcode (`<`→`<=` en admisión) | `live-playback-decision.ts` | `live-playback-decision.test.ts` · "INVARIANTE barrido" |
| M6 | Aplicar respuesta tardía (quita guarda de scope) | `web/nativePlaybackSelect.ts` | `nativePlaybackSelect.test.ts` · "T11 · otra cámara" |
| M7 | Eliminar deduplicación (condición dedup→`false`) | `ai/pipeline.ts` | `pipeline.test.ts` · "deduplica dentro de la ventana" |
| M8 | Exponer URI NVR (fuga `rtsp://…@…` en un campo) | `media-grants.ts` | `security-no-secrets.test.ts` · "grant emitido" |
| M9 | Quitar fallback (`server_h264`→`unavailable`) | `live-playback-decision.ts` | `live-playback-decision.test.ts` · "navegador HEVC ⇒ server_h264" |
| M10 | Quitar backpressure (límite total→`false`) | `ai/queue.ts` | `queue.test.ts` · "límite total (TOTAL_FULL)" |
| M11 | Omitir revocación en background (revokeAllForUser no revoca) | `media-grants.ts` | `media-grants.test.ts` · "T9 · revokeAllForUser" |
| M12 | Confundir path con generación (chequeo de gen→`false`) | `media-grants.ts` | `media-grants.test.ts` · "T8 · generación" |

## Cómo reproducir

El runner (`node`, sin dependencias) aplica/revierte cada mutación y corre la
prueba objetivo por paquete. Requiere `npm install` previo en `apps/api`,
`apps/web` y `apps/native`, y el cliente Prisma generado en `apps/api`
(`npx prisma generate --schema ../../prisma/schema.prisma`).
