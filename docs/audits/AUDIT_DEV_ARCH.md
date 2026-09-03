# Auditoría DEV / Arquitectura — VisionCore (c22)

> Auditor: DEV/ARQUITECTURA (solo lectura). Fecha: 2026-09-03.
> Base: rama `claude/multi-agent-project-audit-hf14wq`, commit `0b3c2f8` (c22 ≡ `9fbb01f`).
> Alcance: `apps/api`, `apps/web`, `apps/native`, `apps/analytics`, con foco c22
> (plano de grants de medios, N1/N2, lifecycle FFmpeg/MediaMTX, coordinación de viewport).

## Resumen ejecutivo

El trabajo c22 está, en general, bien diseñado y fuertemente probado: 110 archivos de
test, la lógica pura del plano de grants (`validateAndClaim`, reducer + script Lua
cruzado en wasmoon), el control de admisión por NVR, el registro de procesos FFmpeg y
el coordinador de viewport son piezas cuidadas, idempotentes y coherentes con los
invariantes C1–C21. Con todas las flags en OFF el comportamiento es equivalente a C21,
tal como exige la restricción dura. Los 77 tests de `services/media` pasan.

El hallazgo más serio es una **fuga de la revocación durable**: la cola de reintentos
(`retryPendingUserRevokes`) existe y está probada en aislamiento, pero **no está cableada
a ningún punto de recuperación** (evento de reconexión de Redis ni barrido periódico), y
el estado que devuelve `revokeUserMediaGrants` (applied/pending/failed) se **ignora** en
los tres call sites. Con el plano de medios activo, un logout o cambio de permisos durante
un outage de Redis queda "pending" para siempre; al recuperar Redis el epoch nunca se
incrementó y los grants previos vuelven a validar (viola C2/RBAC, amenaza T9). El resto de
hallazgos son de menor severidad: no-atomicidad real de `issueGrant` en Redis (contradice
su comentario), riesgo de retiro espurio de instancias por falta de paginación en el
lifecycle de fuente, política de sesión única best-effort por proceso sin `forget` cableado,
y verificación de scope tautológica en la frontera del relay. La deuda técnica declarada
(skeleton Rust, `waitForCapacity`/`retryPending` sin adoptar) está documentada con honestidad.

## Hallazgos por severidad

| Sev | Área | Título | Detalle | Evidencia | Recomendación |
|-----|------|--------|---------|-----------|---------------|
| **P1** | media/grants · seguridad | Revocación durable se pierde tras outage de Redis (retry no cableado) | `revokeUserMediaGrants` devuelve applied/pending/failed y encola en `pendingUserRevokes` cuando `bumpUserEpoch` lanza (Redis caído). Pero `retryPendingUserRevokes` **no se llama en ningún lugar de producción** (no hay handler `redis.on('ready'/'connect')` ni barrido). Además el valor de retorno se **descarta** en los 3 call sites (logout y cambio de permisos). Secuencia: logout con Redis caído → epoch NO incrementado → `pending` → al recuperar Redis el outbox nunca se drena → los grants emitidos antes del logout siguen con `authorizationEpoch` == epoch vigente → **validan de nuevo**. Rompe C2/RBAC (T9). Mitigante: gated tras `NATIVE_PLAYBACK_ENABLED` (OFF) y requiere ventana de outage. | `services/media/grant-service.ts:68-95` (outbox y retry); `plugins/redis.ts:1-15` (sin hook de reconexión); `services/media/grant-store.ts:279-282`; call sites que ignoran el estado: `routes/auth.ts:685`, `routes/users.ts:359`, `routes/users.ts:447` | Cablear `retryPendingUserRevokes` a un `redis.on('ready')` y a un barrido periódico; que logout/permisos actúen sobre el estado `pending` (p.ej. 202/reintento) en vez de descartarlo; test de integración de drenaje post-reconexión. |
| **P2** | media/grants · atomicidad | `RedisGrantStore.issueGrant` no es atómico pese al comentario | El comentario dice "Un pipeline agrupa las escrituras", pero son `await` secuenciales sin `MULTI`/pipeline/Lua. Un crash entre `set(grant)` y los `sadd(idx…)` deja un grant sin índice (o un índice colgado). La revocación por índice `view`/`session` (`revokeByView`/`revokeBySession`, política de sesión única) puede no encontrarlo. La revocación durable por epoch sí lo cubre, pero el corte por-índice queda incompleto. | `services/media/grant-store.ts:243-250` | Envolver las escrituras en un `MULTI/EXEC` o un pequeño script Lua; o corregir el comentario para no prometer atomicidad que no existe. |
| **P2** | media/N1 · lifecycle | Retiro espurio de instancias por falta de paginación en `/v3/paths/list` | `listReadyPaths` no pagina (declarado como "honestidad"). Con más paths que una página, la lista viva se **trunca pero no es null**, así que `reconcile` trata los paths ausentes como caídos → `onNotReady` → `retireSource`. Eso rota/elimina instancias de fuentes VIVAS con espectadores → grants en curso pasan a `INSTANCE_MISMATCH` y la reproducción nativa cae. Gated tras `NATIVE_SOURCE_LIFECYCLE_ENABLED` (OFF) y requiere >1 página. | `services/media/source-lifecycle.ts:146-164` (lister sin paginar) y `:89-99` (reconcile retira ausentes) | Paginar `/v3/paths/list`; ante paginación incompleta, tratar como `null` (no retirar) en vez de asumir ausencia. |
| **P2** | media/N2d · sesión única | Política de sesión única best-effort por proceso y sin `forget` en logout | El mapa `userId→sessionId` es en-proceso (documentado): en multi-worker la detección de "sesión previa" no cruza workers, así que un login en el dispositivo B puede no cortar el A si cayeron en workers distintos. Además `SingleActiveSessionPolicy.forget()` no se invoca en logout, así que el mapa no se limpia (fuga acotada por nº de usuarios; el `register` sobrescribe). Gated tras `SINGLE_ACTIVE_MEDIA_SESSION` (OFF). | `services/media/session-policy.ts:22-52`; `routes/mediaGrants.ts:83-86` (register sin forget); logout en `routes/auth.ts:677-688` no llama `getSessionPolicy().forget` | Persistir la sesión activa en Redis (cross-process) si la feature va a producción; cablear `forget()` en logout. |
| **P3** | media/relay · defensa | Verificación de scope tautológica en `/internal/media-grant/validate` | `scope.userId` y `scope.cameraId` se copian del grant peekeado, no de datos presentados por el relay, así que `SCOPE_MISMATCH` **nunca** puede fallar por esos campos; sólo `streamPath`/`transport` (presentados) se verifican realmente. Aceptable porque el relay se autentica con secreto compartido, pero es defensa-en-profundidad debilitada. | `routes/mediaGrants.ts:111-118` | Documentar explícitamente que userId/cameraId no son verificables aquí, o hacer que el relay presente y se compare el cameraId. |
| **P3** | analytics · lifecycle | Solape de RTSP al reiniciar/reconciliar workers | `_reconcile` y `restart_worker` hacen `w.stop()` (sólo set del `Event`) y crean de inmediato el worker nuevo sin `join()`. El hilo viejo mantiene su `VideoCapture` hasta notar el stop → dos sesiones RTSP contra el NVR pueden solaparse brevemente para la misma cámara. | `apps/analytics/app/pipeline.py:511-537` | Esperar (con timeout) a que el hilo viejo suelte la captura antes de crear el nuevo, o marcar el slot como "reiniciando". |
| **P3** | native · deuda | Código skeleton / helpers no adoptados | `video.rs` es un skeleton con `todo!()` (declarado, N2/N3, no compilado). `waitForCapacity` (N2b) y `retryPending`/`retryPendingRevokes` de los clientes nativos no están adoptados por ningún llamador real (declarado). No son bugs, pero son superficie muerta que puede pudrirse sin un caller. | `apps/native/src-tauri/src/video.rs:78-90`; `services/media/admission-wait.ts` (sin caller prod); `apps/native/shared/grant-client.ts:69-75`, `coordinator.ts:43-49` | Mantener issues de seguimiento; añadir un caller de `retryPending` en el binder de lifecycle del cliente antes de habilitar la feature. |
| **P3** | api/server · robustez | Re-registro de streams en `setTimeout(…, 5000)` sin control de fallo por-cámara agregable | El bloque de arranque re-publica paths tras 5 s; si `publishStream` falla para una cámara puntual, se propaga al `catch` global y aborta el resto del lote (el `for` no aísla por cámara como sí hace el `skipped` del NVR). | `server.ts:300-325` | Envolver cada `publishStream` en try/catch por-cámara para no perder el resto del lote ante un fallo aislado. |

## Coherencia con invariantes C1–C21

- **Capacidad de transcode (C1, MAX=2)**: correcta. La comprobación `counts.total >= MAX`
  y el reclamo single-flight por path corren en una sección **síncrona** (sin `await`
  intermedio), por lo que la reserva es atómica en el event loop; dos cámaras distintas no
  pueden sobrepasar el límite. Reutilización de path vivo no consume cupo nuevo.
  `stream-manager.ts:2426-2473`.
- **Liberación de procesos / cierre exacto (C5)**: `PreviewProcessRegistry` confirma la
  salida REAL sólo por `exit/close` (`markExited`), nunca por `signalCode`; el hard gate
  `PREVIOUS_FFMPEG_NOT_REAPED` impide spawnear un segundo FFmpeg para la misma sessionId.
  Reaper de huérfanos como red de seguridad. Sólido. `preview-process-registry.ts`,
  `routes/recordings.ts:2284-2319`.
- **Leases / retenciones (C3)**: `NvrPlaybackAdmissionController` libera capacidad sólo
  cuando el proceso salió; estados `terminating`/`terminating_stuck` siguen ocupando cupo;
  `expireUnconsumedLeases` evita reservas colgadas; FIFO determinista con `reconcile` antes
  de decidir. Idempotente. Coherente. `nvr-playback-admission.ts`.
- **processInstanceId / instancia de fuente**: `issue` EXIGE una instancia vigente
  (`NO_MEDIA_INSTANCE`), el validador la re-lee y la exige; recrear el path rota la
  generación e invalida grants viejos. Coherente — pero ver P2 (retiro espurio por
  paginación). `grant-store.ts`, `contracts.ts:76-90`, `source-lifecycle.ts`.
- **Viewport invalida timers/colas/respuestas (C4)**: `createViewportSessionController`
  centraliza scope/heartbeat/timers/cola con vigencia PRE y POST respuesta, cierre por
  identidad exacta, single-flight por identidad+fuerza y registro de retenciones. Muy sólido.
  `apps/web/src/lib/viewportSessionController.ts`.
- **Revocación durable / RBAC (C2)**: el mecanismo por epoch es correcto y fail-closed en
  el momento del fallo, PERO la recuperación no está cerrada (ver **P1**): el outbox no se
  drena y el estado de revocación se pierde tras un outage. Este es el punto débil de los
  invariantes.
- **Flags OFF ≡ C21**: verificado por construcción — rutas de grant y de IA sólo se
  registran con su flag; poller N1 sólo arranca con su flag; políticas N2 son no-op sin flag.
  `server.ts:202-212, 274-286`.

## Deuda técnica y cobertura de tests

- **Cobertura fuerte** en lógica pura: 110 archivos de test; `services/media` 77 tests en
  verde; reducer de `validateAndClaim` cruzado contra el script Lua real en wasmoon
  (`grant-store.lua.test.ts`); admisión NVR, budget, registry de procesos y viewport con
  suites extensas y deterministas (reloj/sleep inyectables).
- **Huecos de cobertura**:
  1. No hay test de **integración del drenaje de revocaciones** tras reconexión de Redis
     (justo el gap P1): `grant-service.test` prueba `retryPendingUserRevokes` en aislamiento
     pero nada verifica que se invoque en producción.
  2. No hay test **multi-worker** de la política de sesión única (P2), ni de la
     **paginación** del lister de MediaMTX (P2) — ambos declarados como honestidad.
  3. **Rust** (`src-tauri`) no se compila ni testea en este entorno (skeleton).
  4. Analítica: `tests/` cubre providers y reglas puras, no el ciclo de reinicio de workers
     (P3).
- **Deuda declarada con honestidad** (positivo): comentarios marcan explícitamente lo NO
  validado en vivo (atomicidad de EVAL en Redis real, MediaMTX ausente, paginación no
  implementada, helpers sin adoptar). Recomendado convertir cada "HONESTIDAD/NOTA" en un
  issue de seguimiento para que no se pierda al habilitar flags.
- **Discrepancias comentario↔código**: `issueGrant` promete un pipeline que no existe
  (P2); conviene alinear comentario y código para no inducir a error a futuros lectores.
