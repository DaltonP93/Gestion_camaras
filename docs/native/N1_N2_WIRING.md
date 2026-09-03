# Track 1 · Cableado N1/N2 (post-C22.2)

Cierra los huecos honestos que C22.2 dejó marcados como *no cableados* (N1/N2).
Todo detrás de flags **OFF por defecto**: con las flags apagadas el comportamiento
es **idéntico a C22.2** (mismos invariantes C1–C21; `main` intacto; sin push/PR/
deploy; sin tocar prod/Nginx/MediaMTX config; A1 sigue NO-GO; relay OFF).

Base: `77abae5` sobre la rama local `c22`. Suites: **API 59 files / 977 tests**,
**native 5 files / 31 tests**, `tsc` limpio en ambos.

## N1 — Lifecycle de fuente MediaMTX → registro de instancia
`apps/api/src/services/media/source-lifecycle.ts` (+ `refreshSource` en el store).

- `SourceLifecycleController` recibe eventos `onReady`/`onNotReady` y **reconcilia**
  contra la lista viva de MediaMTX (`GET /v3/paths/list`, `ready=true`, **sólo
  lectura**), tolerando eventos perdidos.
- **Invariante clave:** un `ready` duplicado **no rota** la instancia (keepalive vía
  `refreshSource`, mismo token) ⇒ no invalida grants vivos. Sólo un ciclo
  `notReady→ready` rota (reconexión ⇒ `INSTANCE_MISMATCH` para grants viejos).
- `reconcile(null)` (API caída) **no retira nada**; un registro fallido no marca el
  path como vivo y se reintenta en la próxima pasada.
- Poller con `unref()` detrás de `NATIVE_SOURCE_LIFECYCLE_ENABLED` (OFF). Con la
  flag apagada nada se registra ⇒ `issue` sigue negándose (`NO_MEDIA_INSTANCE`).
- **Límite honesto:** el `lister` real no se ejecutó contra un MediaMTX vivo en este
  entorno (sin MediaMTX); no pagina `/v3/paths/list` (paridad con el código
  existente). La ruta real queda **NO VALIDADA en vivo**.

## N2a — Auto-revocación por lifecycle del cliente
`apps/native/shared/lifecycle-binder.ts`.

- `NativeLifecycleBinder` mapea señales abstractas (`onHidden`/`onVisible`/
  `onPageHide`/`onTeardown`) a `invalidate()`/`dispose()` del coordinador, sin
  DOM/Tauri (la plataforma cablea `visibilitychange`/`pagehide`/eventos de ventana).
- `onHidden` (background/oculto/pérdida de red) revoca el grant y suelta el decoder;
  `onVisible` pide re-abrir; `pagehide` persisted=bfcache ⇒ hidden, si no dispose.
  Idempotente por estado; tras teardown todo es no-op.

## N2b — Espera cancelable de cupo
`apps/api/src/services/media/admission-wait.ts`.

- `waitForCapacity` es el upgrade **cancelable** del predicado puro
  `decideAdmissionOrWait`: espera activa a que se libere un cupo, con timeout y
  `AbortSignal`, sin busy-wait.
- **Invariante/honestidad:** **observa** disponibilidad, **no reserva**. La reserva
  atómica del límite de 2 transcodes sigue siendo del stream-manager (C1–C21). No
  reduce el TTL de 90s ni sube `MAX_TRANSCODE_SESSIONS`.

## N2c — Puente decisión → coordinador
`apps/native/shared/apply-decision.ts`.

- `applyPlaybackDecision` aplica la decisión **server-side** (`decideLivePlayback`)
  al coordinador real: `native_*` abre con transporte+codec resueltos;
  `server_h264`/`substream` invalidan cualquier nativo activo y delegan a HLS;
  `unavailable` invalida y no reproduce; una decisión nativa sin transporte nativo
  se reporta (no adivina). No decide por su cuenta (autoridad = server).

## N2d — Sesión de medios única por usuario (multi-dispositivo)
`apps/api/src/services/media/session-policy.ts` (cableado en `routes/mediaGrants.ts`).

- Al emitir un grant en una sesión nueva, revoca los grants de la **sesión previa**
  del usuario vía índice de sesión (`markRevoked` ⇒ `REVOKED`), **no** vía epoch
  (que cortaría también la nueva). Detrás de `SINGLE_ACTIVE_MEDIA_SESSION` (OFF).
- **Límite honesto:** el mapa usuario→sesión activa es **en-proceso** (detección de
  sesión previa best-effort por worker; la forma durable la guardaría en Redis). La
  revocación disparada **sí** es durable (índice compartido).

## Flags nuevas (todas OFF por defecto)
| Flag | Efecto |
|---|---|
| `NATIVE_SOURCE_LIFECYCLE_ENABLED` | Arranca el reconcile de fuente (N1). |
| `NATIVE_SOURCE_LIFECYCLE_INTERVAL_MS` | Intervalo del reconcile (default 30000). |
| `SINGLE_ACTIVE_MEDIA_SESSION` | Sesión de medios única por usuario (N2d). |

## Mutaciones (runner endurecido, `tools/mutation-run.mjs`)
Se suman 6 a las 12 de C22.2 (**18 en total**). Cada una revierte una defensa real;
eliminarla rompe al menos una prueba conductual.

| # | Mutación | Archivo | Prueba | Ítem |
|---|---|---|---|---|
| M13 | `ready` duplicado ROTA la instancia | `source-lifecycle.ts` | `source-lifecycle.test` | N1 |
| M14 | `reconcile(null)` retira todo | `source-lifecycle.ts` | `source-lifecycle.test` | N1 |
| M15 | `onHidden` no revoca | `lifecycle-binder.ts` | `lifecycle-binder.test` | N2a |
| M16 | fallback no suelta el nativo | `apply-decision.ts` | `apply-decision.test` | N2c |
| M17 | no detecta el cupo libre | `admission-wait.ts` | `admission-wait.test` | N2b |
| M18 | no revoca la sesión previa | `session-policy.ts` | `session-policy.test` | N2d |

## Pendiente real (para Codex el 7)
- Ejecutar N1 contra un MediaMTX vivo (lister real, paginación de `/v3/paths/list`).
- Adopción de `waitForCapacity` por un llamador real que luego pida el cupo al
  stream-manager (la reserva sigue siendo del invariante).
- Forma durable (Redis) de la sesión activa para multi-worker (N2d).
- Redis/Lua en vivo, Docker, cargo/Tauri, Python analytics: **NO VALIDADOS** aquí.
