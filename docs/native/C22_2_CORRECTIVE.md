# C22.2 · Correctivo sobre las ocho pruebas adversariales

Corrige el MODELO (atomicidad, lifecycle, readiness), no condiciones aisladas.
Preserva C21/C22/C22.1. Flags OFF por defecto; A1 NO-GO. Sólo commits locales.

## P0-1 · Transición atómica completa — CORREGIDO

- `GrantStore.validateAndClaim`: una sola operación linealizable que relee grant
  + epoch + instancia + estado de uso y marca el uso. Memoria: método síncrono
  (sin await intermedio). Redis: script Lua vía `EVAL` (`LUA_VALIDATE_AND_CLAIM`).
- Defecto A (revoke vs claim) y B (expira entre validate y claim): eliminados —
  no hay pasos separados; la respuesta corresponde al estado en el punto de
  linealización. Revoke antes ⇒ REVOKED; vence antes ⇒ EXPIRED.

## P0-2 · Emisión/índices atómicos + authorizationEpoch — CORREGIDO

- `authorizationEpoch` por usuario, durable. El grant lo captura al emitir;
  `validateAndClaim` exige que siga vigente. Un issue con autorización leída antes
  del cambio NO valida después, **aunque su índice se escriba tarde** (el epoch,
  no el índice, es la garantía). Logout/permiso incrementan el epoch.
- Punto de linealización de issue: `issueGrant` (grant + índices). De revokeAll:
  `bumpUserEpoch` (INCR atómico).

## P0-3 · Revocación server-side no se traga — CORREGIDO

- `revokeUserMediaGrants` devuelve `applied | pending | failed`. Si el backend
  falla, encola en un outbox en-proceso y reintenta (`retryPendingUserRevokes`);
  durante el outage el plano FALLA CERRADO (`validateAndClaim` ⇒
  BACKEND_UNAVAILABLE; readiness ⇒ no lista). No declara revocación completa si no
  se aplicó. Probado: recuperación de Redis + vaciado del pending.

## P0-4 · mediaInstanceId conectado a una fuente real — CORREGIDO (parcial honesto)

- Fuente única por path (`registerSource`/`retireSource`/`currentInstance`) en el
  store (Redis compartido en multi-worker). `issue` se NIEGA sin fuente vigente
  (NO_MEDIA_INSTANCE); no inventa una por el string del path. Recrear la fuente
  rota la generación ⇒ grants viejos INSTANCE_MISMATCH. Una `proc-N` local de otro
  worker no se usa para validar cross-process.
- **HONESTO**: el cableado de `registerSource`/`retireSource` al lifecycle REAL de
  MediaMTX source add/remove (sub/main/main_h264) es N1 — hoy se invoca desde
  pruebas y quedaría wired al activar el relay.

## P0-5 · Readiness/RBAC unificados — CORREGIDO

- `NativeRelayReadiness`: un servicio compartido por negociación y emisión.
  Comprueba flag + secreto + store atómico + Redis vivo (`ping`) + transporte;
  degrada al fallar y se recupera sólo tras un check exitoso. Ya no `!!server.redis`.
- RBAC compartido (`hasMediaAccess`): sub ⇒ canView; main/HD ⇒ canView+canHighQuality.
  Si el usuario no puede obtener el grant elegido, la negociación NO devuelve
  nativo. Razones explícitas: HD_PERMISSION_MISSING, RELAY_BACKEND_NOT_READY.

## P0-6 · Carrera del handle nativo durante dispose — CORREGIDO

- `LivePlaybackSession.open` re-comprueba la generación DESPUÉS de
  `await dispose(prev)` y antes de publicar. Si C se publicó mientras tanto, B
  dispone su propio handle y devuelve STALE, sin sobrescribir C. Cubre también
  `invalidate()`/`dispose()` durante la espera.

## P0-7 · Concurrencia real de inferencia — CORREGIDO

- El slot REAL se libera cuando el trabajo del proveedor SE ASIENTA, no al vencer
  el timeout del drain. Un proveedor que ignora `abort` sigue ocupando el slot;
  el siguiente drain devuelve `busy` y la concurrencia real no crece. Fallos
  repetidos abren el circuit breaker (quarantine).
- **HONESTO**: JavaScript no puede matar trabajo arbitrario; para un modelo
  productivo se requiere worker/proceso cancelable con terminación supervisada
  (documentado; fuera de alcance de esta ronda).

## P1 · Revocación de conexiones ya establecidas (contrato)

Un grant de uso único protege el HANDSHAKE. Marcarlo revocado no corta un relay
ya conectado. Contrato objetivo del relay (N1): (a) desconexión activa por
`grantId`/usuario ante logout/permiso, o (b) lease renovable corto con
revalidación periódica contra `validateAndClaim` (el epoch/instancia lo cortan en
la siguiente revalidación). **Mientras N1 no exista, `NATIVE_MEDIA_RELAY_ENABLED`
permanece false y NO se declara "revocable end-to-end".**

## P1 · Docs y tooling

- Corregido el `</content>` literal en `C22_1_CORRECTIVE.md`; refs obsoletas
  (`maxUses`, `validateGrant`, "grant firmado", HMAC) en ADR/threat model; T5
  describe el modelo bearer honesto; T10/T12/T16 marcadas como no-cableadas;
  README nativo refleja 20 tests y "shared-core, no ejecutable".
- `tools/mutation-run.mjs` endurecido: exige árbol limpio + HEAD esperado, corre
  baseline primero (distingue "mutación detectada" de "test ya roto"), restaura
  por captura+trap aunque se interrumpa, y documenta que el parche acumulado debe
  estar committeado antes de usarlo.

## Limitaciones residuales honestas / NO VALIDADO

- **Redis real / Lua**: no hay Redis en este entorno. `validateAndClaim` (Lua) se
  prueba contra un fake con semántica EVAL equivalente; la ruta Lua en vivo queda
  **NO VALIDADA**.
- **Docker / `docker compose config`**: sin Docker ⇒ **NO VALIDADO**.
- **Tauri/Rust** (`cargo check/test`, binarios): sin toolchain ⇒ **NO VALIDADO**
  (se agregó `build.rs`; `Cargo.lock` se generará con toolchain).
- **P0-4 wiring**, **T10/T12 auto-revocación**, **espera cancelable** y
  **applyPlaybackDecision**: helpers/registros presentes pero NO cableados al
  lifecycle real (N1/N2).
</content>
