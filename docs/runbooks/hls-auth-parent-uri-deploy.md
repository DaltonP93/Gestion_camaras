# Runbook — Deploy del fix HLS auth_request (URI del request padre)

> **NO EJECUTAR TODAVÍA.** Ejecutable sólo cuando el PR #177 esté **fusionado** a
> `origin/main`. Sólo recarga nginx; **no** recrea contenedores, **no** migra, **no**
> toca datos, **nunca** desactiva `auth_request` ni vuelve a `X-Original-URI $uri`.

El procedimiento es un **único script Bash ejecutable y fail-closed**:
`scripts/deploy-hls-auth-parent-uri.sh` (con `set -Eeuo pipefail` y `fail()` que
termina con `exit != 0`). Toda compuerta se aborta de verdad (no hay `|| echo
ABORTAR` ni “revisar a ojo”). Las pruebas negativas viven en
`scripts/deploy-hls-auth-parent-uri.test.sh` (job CI `compose`) y demuestran que cada
compuerta crítica detiene la ejecución.

## Contexto (por qué no `git pull` a ciegas)

Producción tiene un cambio local **no versionado**: `M infra/nginx/nginx.conf`, que
es el **hotfix operativo ya validado** (contiene `set $hls_original_uri $uri;` +
`proxy_set_header X-Original-URI $hls_original_uri;`). Un `git pull` a ciegas se
detendría por ese archivo modificado. El script lo respalda, valida todo y sólo
entonces lo retira de forma controlada para hacer fast-forward.

## Variables requeridas (valores reales; sin placeholders — el script aborta si faltan)

| Variable | Sentido |
|---|---|
| `EXPECT_HEAD` | HEAD productivo esperado **antes** del deploy (40 hex) |
| `EXPECT_MERGE_SHA` | SHA del merge aprobado de #177 que `origin/main` debe contener |
| `HLS_PROBE_PATH` | path HLS **real** para la sonda 401, forma `/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>` |

Opcionales con default real: `DEPLOY_ROOT` (`/home/sistemas/Gestion_camaras`),
`EXPECT_HOST_RE` (`^camaras`), `EXPECT_BRANCH` (`main`), `NGINX_SVC` (`nginx`),
`NGINX_CTR` (`visioncore_nginx`), `API_HEALTH_URL`, `SITE_BASE`, `BACKUP_DIR`
(`/var/backups/visioncore`), `BACKUP_TIMER_UNIT` (si se define, se exige
`systemctl is-active` OK al final).

## Uso (cuando esté autorizado)

```bash
cd /home/sistemas/Gestion_camaras
EXPECT_HEAD=<sha_head_productivo_actual> \
EXPECT_MERGE_SHA=<sha_merge_de_#177_en_origin_main> \
HLS_PROBE_PATH=/hls/nvr_<id_real>_ch<NN>_sub/index.m3u8 \
  bash scripts/deploy-hls-auth-parent-uri.sh
```
Salida `GO: …` = éxito. Cualquier `NO_GO: …` = abortó antes de mutar (o revirtió).

## Compuertas — aborta ANTES de mutar si

1. `hostname` no matchea `EXPECT_HOST_RE` (camaras).
2. La rama no es `main`.
3. El HEAD productivo != `EXPECT_HEAD`.
4. `origin/main` no contiene `EXPECT_MERGE_SHA` (merge aprobado) como ancestro.
5. Hay más de un cambio local, o el único cambio no es `infra/nginx/nginx.conf`.
6. Falta el hotfix local (alguna de las 3 directivas) o aparece `X-Original-URI $uri`.
7. `origin/main` no tiene las 3 directivas, o contiene `X-Original-URI $uri`.
8. La comparación **semántica** del cableado (local vs `origin/main`) difiere.
9. `HLS_PROBE_PATH` es inválido o es un placeholder.
10. No se puede crear o verificar (checksum) el backup, o el backup no contiene las
    3 directivas / contiene la variante rota.

## Capturas antes de mutar

`HEAD_BEFORE`, `ORIGIN_MAIN`, `NGINX_ID_BEFORE`, `NGINX_STARTED_BEFORE`, estado del
árbol, ruta del backup y su SHA-256.

## Backup (antes de retirar el cambio local)

Crea `${BACKUP_DIR}/nginx.conf.operativo.<ts>` (modo 600), registra `.sha256`,
**verifica el checksum de inmediato**, y verifica que el backup contiene
`set $hls_original_uri $uri;`, `proxy_set_header X-Original-URI $hls_original_uri;`,
`auth_request /internal/hls-auth;` y **no** `proxy_set_header X-Original-URI $uri;`.

## Mutación controlada (recién tras todas las compuertas)

`git checkout -- infra/nginx/nginx.conf` (descarta sólo el cambio respaldado) →
`git pull --ff-only origin main` → confirma `HEAD == origin/main` y árbol limpio →
`nginx -t` → `nginx -s reload` (**sólo nginx**, sin recrear contenedores).

## Verificación posterior

Mismo `Id` y `StartedAt` del contenedor nginx (no se recreó/reinició); API HTTP 200;
HLS sin sesión HTTP 401; la config **activa** (`nginx -T`) conserva las 3 directivas
y `auth_request` sigue activo; backup disponible (y `BACKUP_TIMER_UNIT` activo si se
definió).

## Rollback automático (trap) — sólo si ya hubo mutación

Si algo falla **después** de mutar, el `trap` restaura el backup operativo (que ya
tiene el cableado correcto), corre `nginx -t` y `nginx -s reload`, verifica API 200 y
HLS anónimo 401, e informa `AUTOMATIC_ROLLBACK=PASS` o `FAILED`. **Nunca** desactiva
`auth_request` ni vuelve a `X-Original-URI $uri`.

## Estado
MERGE=NO · DEPLOY=NO · PRODUCTION=UNTOUCHED. No ejecutar sin autorización expresa y #177 fusionado.
