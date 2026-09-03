# C22 · Entrega (base para auditoría independiente)

> No autoriza producción, despliegue, PR ni operación remota. Sólo commits
> locales sobre una rama de trabajo. A1 continúa **NO-GO**.

## Alcance por hito

- **H0 · ADR + threat model + contratos**: `ADR-0001`, `THREAT_MODEL_NATIVE_MEDIA`,
  `services/media/contracts.ts`, `services/ai/contracts.ts`.
- **H1 · Grants**: `media-grants.ts` (bearer opaco; el API guarda sólo
  `sha256(secret)`; scope estricto; uso único anti-replay; TTL corto; revocación
  por id y masiva; lock por grantId anti-TOCTOU) + rutas gated.
- **H2 · Negociación/fallback**: `live-playback-decision.ts` (decisión explícita
  + razón; nunca un 3er transcode; espera cancelable) + web `nativePlaybackSelect`.
- **H3 · Nativo**: `apps/native/shared` (TS, probado) + skeleton Tauri/Rust (NO
  compilado).
- **H4 · Métricas**: histograma de etapas con cardinalidad acotada + timing puro.
- **H5 · IA**: cola con backpressure + circuit breaker + mock + pipeline
  (no bloquea el video) + ruta demo determinista.
- **H6 · Seguridad**: hardening de concurrencia + pruebas transversales de no-fuga.

## Flags nuevas (todas OFF por defecto)

`NATIVE_PLAYBACK_ENABLED=false`, `NATIVE_MEDIA_RELAY_ENABLED=false`,
`MEDIA_RELAY_SECRET=`, `MEDIA_GRANT_TTL_MS=30000`, `AI_EVENTS_ENABLED=false`.
Con todas apagadas, el comportamiento es idéntico a C21.

## Estado de validación

- **VALIDADO** (Node/TS): `apps/api` (typecheck + vitest), `apps/web` (typecheck +
  vitest), `apps/native/shared` (typecheck + vitest). 12/12 mutaciones detectadas.
- **NO VALIDADO** en este entorno (falta toolchain): binarios Tauri/Rust
  (sin `cargo`/`rustc`), Android (`.aab/.apk`), iOS (`.ipa`), `docker compose
  config` (sin Docker), servicio Python analytics (sin Python).

## Plan de rollback

Todo vive en la rama local `c22`; `main` no fue tocado. Para descartar:
`git checkout main` y borrar la rama (`git branch -D c22`). Cada hito es un commit
separado y revertible de forma independiente (`git revert <sha>`). Las flags
apagadas ya garantizan neutralidad en runtime aunque el código esté presente.

## Instrucciones de prueba en entorno aislado

```bash
# API
cd apps/api && npm ci
npx prisma generate --schema ../../prisma/schema.prisma   # DATABASE_URL dummy
npx tsc --noEmit -p tsconfig.json && npx vitest run
# Web
cd ../web && npm ci && npx tsc --noEmit && npx vitest run
# Shared-core nativo
cd ../native && npm install && npm run typecheck && npm test
```

No se requiere DB/Redis/NVR: las pruebas son unitarias con dependencias
inyectadas. No tocar producción, Nginx, MediaMTX ni contenedores.

## Limitaciones residuales honestas

- El transporte nativo directo permanece **deshabilitado**; requiere el relay
  autenticado (N1) antes de `nativeDirect.available=true`.
- El lock anti-TOCTOU es por proceso; multi-worker exige atomicidad en Redis
  (INCR/Lua) — pendiente para N1.
- El desglose de etapas instrumenta hoy `spawn_to_hls_ready`; el resto está
  definido y documentado para wiring incremental.
- La IA es una base: no hay modelo productivo ni detección real validada.

## Próximo paso recomendado

Auditoría independiente (Codex) del diff acumulado; luego N1 (relay autenticado
+ auth por path en MediaMTX + atomicidad Redis de grants) en un entorno con
toolchain nativo.
