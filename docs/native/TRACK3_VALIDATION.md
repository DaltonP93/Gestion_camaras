# Track 3 · Destrabar validación

Estado del entorno (Windows, esta máquina): **Node/npm sí** (registro npm
alcanzable), **Redis/Docker/cargo/ffmpeg NO instalados**, **Python = shim del
Microsoft Store (no funcional)**.

## Destrabado ✅ — Ruta Lua real validada (sin Redis)
`apps/api/src/services/media/grant-store.lua.test.ts` ejecuta el **script Lua
EXACTO** (`LUA_VALIDATE_AND_CLAIM`, el mismo string que Redis corre con `EVAL`)
sobre una VM Lua (**wasmoon**, devDependency sólo-test) con `redis`/`cjson`/
KEYS/ARGV inyectados, y cruza su resultado contra `validateAndClaimReducer` para
cada caso: happy + NOT_FOUND, REVOKED, EXPIRED, SCOPE, EPOCH, INSTANCE_REQUIRED,
INSTANCE_MISMATCH, SECRET, REPLAYED, y un caso de ORDEN (revocado+vencido ⇒
REVOKED, igual que el reducer). **11/11 verde.**

Esto cierra el hueco "Lua NO VALIDADA": ya no se prueba sólo un fake que
reimplementa la lógica en JS — se corre el Lua real y se comprueba que coincide
con la lógica TS. `cjson` se replica fielmente (JSON null → `cjson.null`
sentinela); `redis.call` respeta la semántica (GET de clave ausente ⇒ `false`).

**Alcance honesto:** valida la **lógica** del script (control de flujo, cjson,
comparaciones, EXISTS/SET). NO valida la **atomicidad/linealizabilidad de EVAL**
en un Redis real (eso lo garantiza Redis, no nuestro código) — sigue requiriendo
un servidor Redis.

## Sigue bloqueado ⛔ (documentado, no simulado)
- **Atomicidad de EVAL en Redis real**: sin `redis-server` nativo en Windows
  (Redis no es nativo; requeriría Memurai/WSL/Docker). La *lógica* ya está
  validada; falta ejercerla bajo concurrencia real en un Redis vivo.
- **`docker compose config` / imagen**: sin Docker.
- **`cargo check`/`cargo test` / binarios Tauri**: sin toolchain Rust (rustup no
  instalado). El shared-core sigue sin compilar a binario.
- **Analytics Python en runtime**: `python` es el alias del Microsoft Store (no
  ejecuta); sin intérprete real ni `pip`.

## Cómo correr
```
cd apps/api && npx vitest run src/services/media/grant-store.lua.test.ts
```
`wasmoon` quedó en `devDependencies` (no se importa desde código de runtime; el
build `tsc` excluye `*.test.ts`, así que no llega al bundle de producción).
