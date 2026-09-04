# Plan de diseño A1 — Relay de medios autenticado (SIN habilitar)

> Estado: **DISEÑO. A1 sigue NO-GO / deshabilitado** (`NATIVE_MEDIA_RELAY_ENABLED=false`).
> Este documento NO autoriza habilitar nada ni tocar infra. Es el plan pedido por
> el humano (decisión: "diseñar plan sin habilitar") para poder decidir con datos.
> Base: plano de grants C22 y `docs/security/THREAT_MODEL_NATIVE_MEDIA.md`.

## 1. Problema que resuelve A1

Hoy MediaMTX acepta `user: any` (sin auth por path) y el `streamPath` es
determinista/adivinable (`nvr_<id>_ch<NN>_sub`). Consecuencias:
- **RBAC de live-view depende solo de la red** (hallazgo de seguridad P1-3): quien
  alcance el puerto de medios puede leer cualquier cámara, saltando el RBAC del API.
- Bloquea la **reproducción nativa directa** (el cliente no puede consumir el
  transporte de medios de forma autenticada) → obliga a transcodes y agrava el
  límite de 2 cupos.

A1 = poner **autenticación por path/conexión** delante de MediaMTX, validando
cada lectura contra el **plano de grants ya existente**. Cierra T1/T14/T15 y P1-3.

## 2. Arquitectura recomendada — Opción A: hooks de auth HTTP de MediaMTX

MediaMTX puede delegar autenticación a un endpoint HTTP externo (`authMethod: http`
/ `authHTTPAddress`): en cada `read`/`publish` llama a una URL con `{path, query,
protocol, user, password, action, ip}`. VisionCore expone un endpoint que:
1. Extrae el **secreto de grant** que el cliente presenta (como password RTSP/WHEP
   o token de query).
2. Llama a la lógica existente `validateAndClaim` / `/internal/media-grant/validate`
   con `{secret, path}`.
3. Devuelve 2xx (permitir) o 4xx (denegar). MediaMTX abre o rechaza la conexión.

Ventajas: reutiliza TODO el plano de grants (hash-only, epoch, scope por cámara,
revocación durable). Cambio de código mínimo (un endpoint de auth-hook) y un cambio
de config de MediaMTX (infra). **No** requiere un relay/proxy nuevo.

Opción B (descartada para v1): relay/reverse-proxy propio (Node/Go) que valida y
reenvía el stream. Más superficie, más moving parts, más CPU. Solo si los hooks de
MediaMTX resultan insuficientes.

## 3. Punto clave de diseño: conexiones LARGAS vs. grant de uso único

El grant C22 es de **uso único** (`validateAndClaim` marca el uso en la transición
atómica) — perfecto para una negociación puntual, pero una lectura de medios es
**long-lived**. A1 necesita un modo **"grant de sesión de medios"**:
- Validación **en el connect** (una vez), ligada al ciclo de vida de la conexión,
  no por frame.
- **Revocación en caliente**: al revocar (logout/cambio de permiso/vista), hay que
  **cortar la conexión activa** en MediaMTX (vía su API de runtime: kick del
  reader/path), no solo negar futuras. Esto exige un mapa conexión↔grant y un
  cableado revoke→kick.
- TTL corto + re-auth periódica (MediaMTX puede re-consultar) como defensa en
  profundidad.
- Interacción con **N1** (source-lifecycle → `mediaInstanceId`): el grant liga la
  instancia; recrear la fuente invalida grants viejos (T7).

## 4. Delta de threat model (nuevas amenazas A1)

| # | Amenaza | Mitigación propuesta |
|---|---|---|
| A-T1 | Puerto de medios abierto sin auth | El hook niega por defecto; `publish` global deshabilitado; puertos ya atados a 127.0.0.1 |
| A-T2 | Conexión persiste tras revocar | revoke → kick del reader vía API MediaMTX; mapa conexión↔grant |
| A-T3 | Secreto en URL/logs de MediaMTX | Preferir password RTSP/WHEP sobre query; no loguear credenciales; TLS (rtsps/https) |
| A-T4 | SSRF/DoS al endpoint de auth-hook | Rate-limit; el hook solo acepta llamadas desde MediaMTX (red interna/allowlist); fail-closed |
| A-T5 | Abuso para 3er transcode | El grant no crea capacidad; `MAX_TRANSCODE_SESSIONS=2` sigue mandando; A1 habilita playback NATIVO (decode en cliente) que NO consume transcode |
| A-T6 | Re-auth con grant vencido a mitad de stream | Re-consulta periódica; al fallar, kick |

## 5. Relación con los 2 dolores del usuario

- **Límite de 2 transcodes**: A1 es la palanca real. Con playback nativo
  autenticado, HEVC decodifica en el cliente ⇒ no se gasta un cupo de transcode
  para verlo. NO se sube `MAX_TRANSCODE_SESSIONS`.
- **Playback de grabaciones**: A1 es de live/transporte; las grabaciones siguen
  por el pipeline propio (RTSP→ffmpeg→HLS). A1 no las resuelve directamente.

## 6. Plan de implementación por fases (cuando/si se autorice)

- **F0 (código, testeable sin infra)**: endpoint de auth-hook en `apps/api`
  (`/internal/mediamtx/auth`), modo **"session grant"** en el grant-store, mapa
  conexión↔grant y helper revoke→kick. Todo tras `NATIVE_MEDIA_RELAY_ENABLED=false`.
  Gate tsc/vitest/mutaciones. Tests con cliente MediaMTX fake.
- **F1 (shadow, requiere infra)**: MediaMTX configurado con el hook en modo
  **log-only** (valida y registra, pero permite) para medir falsos negativos sin
  romper. Requiere MediaMTX vivo + autorización.
- **F2 (enforce)**: el hook deniega de verdad; `user: any` se retira. Rollback
  comprobable (revertir config MediaMTX).

## 7. Bloqueos honestos / lo NO validable sin infra

- El comportamiento real de los hooks de auth de MediaMTX y el kick de readers
  requiere un MediaMTX vivo (no validable en este entorno).
- El decode nativo por plataforma (Tauri/Rust) es una pieza separada (shared-core
  define la interfaz; nadie la implementa aún).
- Requiere autorización explícita para tocar la config de MediaMTX y desplegar.

## 8. Decisión que queda para el humano (más adelante, no ahora)

Cuando quieras avanzar A1: ¿autorizás la **Fase F0** (solo código, flag OFF, sin
tocar infra) para tener el auth-hook y el modo session-grant listos y testeados?
Las fases F1/F2 (infra/MediaMTX) se deciden después, con rollback preparado.
