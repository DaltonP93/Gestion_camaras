# C22.1 · Correctivo sobre las seis pruebas adversariales

Corrige los defectos hallados por la auditoría independiente. Preserva C1–C21 y
lo correcto de C22. **No** amplía alcance a N1/N2. Flags OFF por defecto; A1
sigue NO-GO. Sólo commits locales.

## P0-1 · Revocación perdida por concurrencia — CORREGIDO

- Servicio de grants **singleton** propiedad del servidor (`grant-service.ts`),
  no un manager por ruta.
- **Índice atómico** por usuario/vista/sesión (`grant-store.ts`): memoria con
  mutación in-place (atómica en el event loop); Redis con `SADD/SMEMBERS/SREM`.
  Se elimina el patrón `get→array→set` y el **truncado a 256**.
- **Uso único atómico**: memoria `Set` in-place; Redis `SET NX`. Dos consumos
  (mismo proceso o dos procesos) ⇒ exactamente uno gana.
- **Fail-closed**: relay sin backend atómico cross-process (Redis) ⇒
  `GRANT_ATOMICITY_UNAVAILABLE` (503); no se emiten grants habilitables.
- Revocación exacta por grant, usuario, vista y sesión; wired a **logout** y
  **cambio de permisos** (`auth.ts`, `users.ts`). Revocación fallida en el
  cliente/coordinador queda **pending + retry** (no se olvida).

## P0-2 · Instancia coherente con el lifecycle — CORREGIDO

- Se elimina `processGeneration:number`. Se introduce `mediaInstanceId:string`
  derivado SERVER-SIDE (de `getCurrentProcessInstance` real cuando existe, o del
  registro de instancias por path).
- El validador la **exige** (`INSTANCE_REQUIRED` si falta; `INSTANCE_MISMATCH` si
  el path se recreó). Una instancia A nunca autoriza una B que reutilice el path.
- `streamPath/codec/effectiveType` son server-derivados; el codec/path del
  cliente **no** altera el scope. RBAC real: `sub`⇒`canView`; `main`/HD⇒
  `canView`+`canHighQuality`.

## P0-3 · Contrato de negociación coherente — CORREGIDO

- `nativeDirect.available` refleja EXACTAMENTE la decisión: nunca `false` junto a
  una decisión nativa (la ruta lo fuerza coherente).
- Nativo sólo si el relay está REALMENTE listo: `relayReady = flag && secreto &&
  atomicidad cross-process` (no basta `env=true`), más capacidad real del
  dispositivo (`maxHardwareDecoders`).
- Con flags OFF, respuesta idéntica a C21.

## P0-4 · Lifecycle nativo — CORREGIDO

- `LivePlaybackSession.open` **dispone el handle previo** antes de publicar el
  nuevo (open(A)→open(B) libera A).
- `LivePlaybackCoordinator` posee grant + decoder con **latest-request-wins**: A
  tardía tras B se **revoca** y B permanece; no abre decoder con grant vencido;
  dispose idempotente; callbacks de generaciones viejas descartados; revocación
  fallida en pending/retry.

## P0-5 · IA con aislamiento y cancelación — CORREGIDO

- Demo estrictamente **ADMIN** (POST y GET) + filtro por `cameraId`.
- `InferenceProvider.infer(input, signal)`; el timeout ejecuta `abort()` y el
  trabajo deja de estar en vuelo (`inFlightCount` vuelve a 0).
- **Concurrencia acotada** (`maxConcurrent`) y **poda del mapa de dedup**
  (ventana + cota dura), que ya no crece sin límite.

## P1 · Flags, pruebas y documentación

- Rutas de medios y demo se **registran condicionalmente** (server.ts): con flag
  OFF no existen ⇒ 404 antes de auth/parseo/DB (idéntico a C21).
- Doc corregida: se eliminó el reclamo de HMAC (uso único bearer); T7/T8 ahora
  describen `mediaInstanceId` real; revocación logout/permisos documentada como
  wired; se aclara qué es sólo helper puro (abajo).
- Pruebas de RUTA con `fastify.inject` (medios, demo, revocación por permisos),
  no sólo helpers puros. Runner de mutaciones **incluido** en el repo
  (`tools/mutation-run.mjs`).
- Tauri sigue **NO VALIDADO**; se agrega `build.rs`. `Cargo.lock` se generará
  cuando exista toolchain.

## Limitaciones residuales honestas (sin sobre-declarar)

- **Espera cancelable**: `decideAdmissionOrWait` es un predicado PURO probado; la
  aplicación real del límite de 2 transcodes sigue en el lifecycle de
  stream-manager (invariante C1–C21). No se declara un "flujo nuevo".
- **`applyPlaybackDecision`** (web) es un helper PURO probado; **no** está
  cableado dentro de `LiveViewPage`/`ViewPlayerPage` (no se modificaron esas
  páginas). Se documenta como disponible, no como integrado.
- **Redis**: no hay servidor Redis en este entorno; la ruta Redis del store se
  unit-testea contra un fake con semántica atómica (`SET NX`, etc.), **no**
  contra un Redis real (NO VALIDADO en vivo).
- **Nativo (Tauri/Rust)**: sin `cargo`/SDK; no se compila. El shared-core TS sí.
