# Runbook — Deploy del fix HLS auth_request (URI del request padre)

> **NO EJECUTAR TODAVÍA.** Ejecutable sólo cuando el PR #177 esté **fusionado** a
> `origin/main`. Sólo recarga nginx; **no** recrea contenedores, **no** migra, **no**
> toca datos, **nunca** desactiva `auth_request` ni vuelve a `X-Original-URI $uri`.

El procedimiento es un **único script Bash ejecutable y fail-closed**:
`scripts/deploy-hls-auth-parent-uri.sh` (`set -Eeuo pipefail` + `fail(){ echo NO_GO;
exit 1; }`). Toda compuerta aborta de verdad (exit ≠ 0). Pruebas positivas/negativas y
un **harness hermético** (git real + docker/curl/systemctl/hostname/cp mockeados) en
`scripts/deploy-hls-auth-parent-uri.test.sh` (job CI `compose`).

## Contexto (por qué no `git pull` a ciegas)

Producción tiene `M infra/nginx/nginx.conf` (hotfix operativo no versionado). Un
`git pull` a ciegas se detendría por el archivo modificado y, además, **re-fetch**
podría traer un `origin/main` avanzado no auditado. Por eso el script:
**inmoviliza el objetivo** — exige `origin/main == EXPECT_TARGET_SHA`, verifica que ese
SHA contiene el merge aprobado, respalda el archivo, y hace `git merge --ff-only
"$ORIGIN_MAIN"` sobre el objeto **ya fetch-eado** (no vuelve a consultar/descargar).

## Variables requeridas (valores reales; el script aborta si faltan o no son válidas)

| Variable | Sentido |
|---|---|
| `EXPECT_HEAD` | HEAD productivo esperado **antes** del deploy (exactamente 40 hex) |
| `EXPECT_TARGET_SHA` | SHA EXACTO al que se hará fast-forward; debe ser == `origin/main` (40 hex) |
| `EXPECT_MERGE_SHA` | SHA del merge aprobado que `EXPECT_TARGET_SHA` debe contener (40 hex) |
| `HLS_PROBE_PATH` | path HLS **real** para la sonda 401, forma `/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>` |

Opcionales con default real: `DEPLOY_ROOT` (`/home/sistemas/Gestion_camaras`),
`EXPECT_HOST` (**`camaras`**, comparación **exacta**), `EXPECT_BRANCH` (`main`),
`NGINX_SVC`/`NGINX_CTR`, `BACKUP_DIR` (`/var/backups/visioncore`),
`BACKUP_TIMER_UNIT` (`visioncore-backup.timer`, **obligatorio**: activo antes y después),
`API_HEALTH_URL`, `SITE_BASE`.

## TLS

`curl` se usa **sin `-k`**: un certificado inválido hace fallar la verificación (no se
omite TLS).

## Uso (cuando esté autorizado)

```bash
cd /home/sistemas/Gestion_camaras
EXPECT_HEAD=<sha40_head_productivo> \
EXPECT_TARGET_SHA=<sha40_de_origin_main_ya_fusionado> \
EXPECT_MERGE_SHA=<sha40_del_merge_de_#177> \
HLS_PROBE_PATH=/hls/nvr_<id_real>_ch<NN>_sub/index.m3u8 \
  bash scripts/deploy-hls-auth-parent-uri.sh
```
`GO: …` = éxito. Cualquier `NO_GO: …` = abortó antes de mutar (o revirtió).

## Compuertas — aborta ANTES de mutar si

1. `EXPECT_HEAD`/`EXPECT_TARGET_SHA`/`EXPECT_MERGE_SHA` no son 40 hex.
2. `HLS_PROBE_PATH` inválido o placeholder.
3. `hostname` != `camaras` (exacto).
4. Rama != `main`.
5. `visioncore-backup.timer` no está activo.
6. HEAD productivo != `EXPECT_HEAD`.
7. `origin/main` != `EXPECT_TARGET_SHA` (objetivo no inmovilizado / carrera).
8. `EXPECT_TARGET_SHA` no contiene el merge aprobado.
9. Hay más de un cambio local, o el único no es `infra/nginx/nginx.conf`.
10. El hotfix local o el `EXPECT_TARGET_SHA:nginx.conf` no cumplen el **cableado activo**
    (exactamente una directiva activa de cada una, en su location; sin `X-Original-URI $uri`
    activa) — comparación **semántica**, ignorando comentarios y números de línea.
11. No se puede crear/verificar el backup (checksum) o el backup no tiene el cableado.

La validación del cableado se hace sobre **líneas activas** con
`scripts/check-hls-auth-nginx.sh <archivo>` (reutilizable para el hotfix local, el
backup, la config de `EXPECT_TARGET_SHA` y la config **activa** de `nginx -T`).

## Backup (antes de retirar el cambio local)

Crea `${BACKUP_DIR}/nginx.conf.operativo.<ts>` (600), registra `.sha256`, **verifica el
checksum de inmediato**, y valida el cableado activo del backup.

## Mutación controlada (recién tras todas las compuertas)

`git checkout -- infra/nginx/nginx.conf` (descarta sólo el cambio respaldado) →
`git merge --ff-only "$ORIGIN_MAIN"` (objeto ya fetch-eado, **no re-fetch**) → confirma
`HEAD == EXPECT_TARGET_SHA` y árbol limpio → `nginx -t` → `nginx -s reload` (**sólo
nginx**, sin recrear contenedores).

## Verificación posterior

Mismo `Id` y `StartedAt` del contenedor nginx (no se recreó/reinició); API HTTP **200**;
HLS sin sesión HTTP **401**; la config **activa** (`nginx -T`) cumple el cableado
(3 directivas, sin variante rota); backup disponible; `visioncore-backup.timer` activo.

## Rollback automático (trap) — sólo si ya hubo mutación

`AUTOMATIC_ROLLBACK=PASS` **sólo si TODOS** pasan: (1) backup+checksum revalidan; (2) `cp`
del backup == 0; (3) el archivo restaurado coincide con el SHA-256 respaldado; (4) `nginx
-t` == 0; (5) `nginx -s reload` == 0; (6) config activa con las 3 directivas; (7) sin
variante rota activa; (8) API 200; (9) HLS anónimo 401. Si falla cualquiera →
`AUTOMATIC_ROLLBACK=FAILED` y el proceso mantiene exit ≠ 0. **Nunca** desactiva
`auth_request` ni vuelve a `X-Original-URI $uri`.

## Estado
MERGE=NO · DEPLOY=NO · PRODUCTION=UNTOUCHED. No ejecutar sin autorización expresa y #177 fusionado.
