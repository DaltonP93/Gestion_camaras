# Threat model · Plano de medios nativo y grants efímeros (C22)

Alcance: el plano de autorización de reproducción nativa (`media-grants`), la
negociación/fallback y la base de IA introducidos en C22. No cubre A1 (NO-GO).

> No contiene IPs internas, credenciales ni URIs RTSP.

## Activos a proteger

- Credenciales del NVR y URIs RTSP (nunca deben salir del API).
- La evidencia de grabaciones (fuera de alcance directo aquí, pero el plano no
  debe abrir vías de acceso a ella).
- La capacidad de transcodificación (2 cupos) y el lifecycle de FFmpeg/MediaMTX.
- El control de acceso RBAC por cámara.

## Frontera de confianza

- **Confiable:** el API (Fastify) y, sólo tras N1, un relay que valida grants.
- **No confiable:** el cliente (navegador o app nativa) y la red de medios
  mientras MediaMTX acepte `user: any`. Por eso el transporte nativo directo
  permanece deshabilitado (`NATIVE_MEDIA_RELAY_ENABLED=false`).

## Amenazas y mitigaciones

| # | Amenaza | Mitigación en C22 | Prueba |
|---|---|---|---|
| T1 | **Robo de token/grant** | El grant es opaco y de vida corta; el API guarda sólo `sha256(secret)`; el secreto viaja una sola vez en la emisión | `media-grants.test` (secret nunca almacenado en claro) |
| T2 | **Replay** | Grant de USO ÚNICO: el uso se marca en la MISMA transición atómica (`validateAndClaim`; Lua en Redis / síncrona en memoria), así que dos consumos (mismo proceso o dos procesos) ⇒ exactamente uno gana; el segundo es REPLAYED. Bearer sin HMAC (sólo hash). | `media-grants.test` / `grant-store.test` (uso único, cross-process) |
| T3 | **Grant vencido** | La expiración se comprueba en el punto de linealización de `validateAndClaim` (reloj vigente), no en un paso separado ⇒ sin ventana validate→claim | `media-grants.test` (EXPIRED en el punto de claim) |
| T4 | **Grant revocado** | `revokeGrant` marca `revokedAt`; validación rechaza REVOKED; logout/cambio de vista/permiso revoca | `media-grants.test` (REVOKED) |
| T5 | **Acceso cruzado entre usuarios** | Modelo BEARER honesto: en `validateAndClaim` el `userId` se compara contra el propio grant almacenado (no lo asevera la ruta) — quien posea el secreto puede usarlo. El aislamiento cross-user REAL viene de (a) RBAC en la EMISIÓN y (b) el `authorizationEpoch` por usuario (logout/permiso lo incrementa ⇒ EPOCH_MISMATCH), más TTL corto y uso único. | `media-grants.test` (epoch / SCOPE), `grant-service.test` |
| T6 | **Acceso cruzado entre cámaras** | El grant liga `cameraId`/`streamPath`; validar contra otro path ⇒ SCOPE_MISMATCH; la instancia se busca por el path del grant | `media-grants.test` (SCOPE) |
| T7 | **Reutilización de path** | `mediaInstanceId` server-derivado; recrear la fuente (`registerSource` rota la instancia) ⇒ el grant viejo da INSTANCE_MISMATCH. **HONESTO**: hoy la instancia la crea `registerSource`/`retireSource`; su cableado al lifecycle real de MediaMTX source add/remove es N1 (no está wired en C22.2). | `media-grants.test` (rotar instancia) |
| T8 | **Instancia de otro proceso** | La instancia vive en el store (Redis compartido en multi-worker); `validateAndClaim` la relee atómicamente. `issue` se NIEGA si no hay fuente vigente (NO_MEDIA_INSTANCE); no inventa una por el string del path. Una `proc-N` local de otro worker NO se usa para validar cross-process. | `media-grants.test` (NO_MEDIA_INSTANCE, cross-process) |
| T9 | **Logout / cambio de permisos** | `revokeUserMediaGrants` incrementa el `authorizationEpoch` DURABLE (wired en `auth.ts` y `users.ts`); no se traga fallos (applied/pending/failed + retry). Backend caído ⇒ pending + fail-closed. | `grant-service.test` (fail-closed + retry) + `users.permissions-revoke.test` (inject) |
| T10 | **bfcache / app suspendida / pérdida de red** | **NO WIRED en C22.2**: TTL corto es la garantía base. La revocación por `pagehide`/cambio de vista se ofrece como endpoints (`DELETE /media-grant/view/:viewId`) que el cliente llama; su cableado automático a bfcache/background es N2. | endpoints (probados por ruta); auto-wiring pendiente |
| T11 | **Respuesta tardía aplica cámara equivocada** | El cliente descarta decisiones fuera de scope (`applyPlaybackDecision`, helper puro probado — **no** cableado en las páginas web actuales) | `nativePlaybackSelect.test` (web, helper) |
| T12 | **Múltiples dispositivos del mismo usuario** | El grant liga `sessionId` opcional; `revokeBySession` existe. **HONESTO**: revocar POR sesión es best-effort por índice; logout/permiso revoca TODO por epoch. No hay una prueba multi-device dedicada. | `media-grants.test` (revoke owner) |
| T13 | **Fuerza bruta del secreto** | Secreto de 256 bits (`randomBytes(32)`); comparación de hash; TTL corto + uso único | `media-grants.test` (SECRET_MISMATCH) |
| T14 | **Logs con secretos / URIs** | El grant nunca incluye credenciales/URIs; los logs usan sólo `grantId` y razones | `security-no-secrets.test` |
| T15 | **Cliente modificado maliciosamente** | El servidor no confía en campos del cliente: `streamPath/codec/effectiveType/mediaInstanceId/epoch` son server-derivados; sólo el grant bearer (hash-only) + RBAC deciden | `mediaGrants.route.test` (scope server-side) |
| T16 | **Tercer transcode por abuso** | `MAX_TRANSCODE_SESSIONS=2` lo aplica el lifecycle de stream-manager (C1–C21). `decideAdmissionOrWait` es un helper PURO probado, **NO** un flujo nuevo cableado. | `live-playback-decision.test` (helper) |
| T17 | **IA tira el video** | Cola con backpressure + circuit breaker; si analytics cae, el video no se bloquea | `ai/queue.test`, `ai/circuit-breaker.test` |

## Atomicidad y reinicio del API (C22.1)

Los grants se guardan en un `GrantStore` atómico: Redis (`SET NX` para el uso
único, `SADD/SMEMBERS/SREM` para los índices, instancia por path) con fallback a
memoria. La memoria es atómica **dentro de un proceso** (event loop de un solo
hilo, mutación in-place); el uso único ENTRE PROCESOS exige Redis. Por eso la
emisión de grants de relay **falla cerrado** (`GRANT_ATOMICITY_UNAVAILABLE`) si
se pide relay sin Redis. Tras reiniciar el API con Redis, los grants vigentes
siguen validando hasta su TTL; sin Redis se pierden y el cliente renegocia (la
pérdida cierra el acceso, nunca lo abre).

## Fuera de alcance / bloqueos honestos

- El relay que valida grants **no** está habilitado en C22
  (`NATIVE_MEDIA_RELAY_ENABLED=false`) porque MediaMTX hoy acepta `user: any`.
  Habilitar el puerto sin auth por path violaría T1/T14; se deja documentado y
  deshabilitado hasta N1.
