# Runbook — Deploy del fix HLS auth_request (URI del request padre)

> **NO EJECUTAR TODAVÍA.** Ejecutable sólo cuando el PR #177 esté **fusionado** a
> `origin/main`. Sólo recarga nginx; **no** recrea contenedores, **no** migra, **no**
> toca datos, **nunca** desactiva `auth_request` ni vuelve a `X-Original-URI $uri`.

El procedimiento son **dos scripts Bash ejecutables y fail-closed**:

- `scripts/deploy-hls-auth-bootstrap.sh` — **punto de entrada**. Corre desde el checkout
  productivo **actual** (p.ej. `ed3e0cc`), donde los otros scripts **todavía no existen**.
- `scripts/deploy-hls-auth-parent-uri.sh` — el deploy real (ff + reload + rollback), con
  su guard adyacente `scripts/check-hls-auth-nginx.sh`.

Ambos con `set -Eeuo pipefail` + `fail(){ echo NO_GO; exit 1; }`; toda compuerta aborta de
verdad (exit ≠ 0). Pruebas positivas/negativas + un **harness hermético** (git real +
docker/curl/systemctl/hostname/cp mockeados) en `scripts/deploy-hls-auth-parent-uri.test.sh`
(job CI `compose`): compuertas, target inmóvil, **rollback por fases con contadores**,
honestidad multi-archivo, y el **bootstrap desde un checkout sin los scripts**.

## Por qué hace falta un bootstrap

Producción está en `ed3e0cc`. Los scripts `deploy-hls-auth-parent-uri.sh` y
`check-hls-auth-nginx.sh` son **nuevos del PR #177**: no existen en el checkout productivo
antes del fast-forward, así que `bash scripts/deploy-hls-auth-parent-uri.sh` no puede correr
todavía. El bootstrap resuelve esto **sin descargar nada por URL**:

1. `set -Eeuo pipefail`.
2. Confirma `hostname` exacto `camaras`.
3. Confirma rama `main` y `EXPECT_HEAD` exacto.
4. Valida los tres SHA de 40 hex.
5. `git fetch origin main`.
6. Exige `origin/main == EXPECT_TARGET_SHA` (target inmovilizado; aborta si hubo carrera).
7. Exige `EXPECT_MERGE_SHA` ancestro de `EXPECT_TARGET_SHA`.
8. Crea un directorio privado con `mktemp -d` bajo `/root`, modo `700`.
9. Extrae **del objeto Git inmóvil** (nunca por URL/curl/GitHub raw):
   `git show "${EXPECT_TARGET_SHA}:scripts/deploy-hls-auth-parent-uri.sh"` y
   `git show "${EXPECT_TARGET_SHA}:scripts/check-hls-auth-nginx.sh"`.
10. Los guarda **juntos** en el directorio privado, modo `700`.
11. Registra el **SHA-256** de ambos en `EVIDENCE.txt` (ruta de evidencia para auditoría).
12. Corre `bash -n` sobre ambos.
13. Ejecuta el deploy **desde ese directorio**; el deploy resuelve su guard **adyacente**
    (mismo directorio, vía `SELF_DIR`/`CHECK_SCRIPT`), sin depender del checkout viejo.

Nunca ejecuta código antes de validar que proviene del target exacto aprobado (pasos 6–12
preceden a cualquier ejecución).

## Variables requeridas (valores reales; abortan si faltan o no son válidas)

| Variable | Sentido |
|---|---|
| `EXPECT_HEAD` | HEAD productivo esperado **antes** del deploy (exactamente 40 hex) |
| `EXPECT_TARGET_SHA` | SHA EXACTO al que se hará fast-forward; == `origin/main` (40 hex) |
| `EXPECT_MERGE_SHA` | SHA del merge aprobado que `EXPECT_TARGET_SHA` debe contener (40 hex) |
| `HLS_PROBE_PATH` | path HLS **real** para la sonda 401, forma `/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>` |

Opcionales con default real: `DEPLOY_ROOT` (`/home/sistemas/Gestion_camaras`),
`EXPECT_BRANCH` (`main`), `NGINX_SVC`/`NGINX_CTR`, `BACKUP_DIR` (`/var/backups/visioncore`),
`BACKUP_TIMER_UNIT` (`visioncore-backup.timer`, **obligatorio**: activo antes y después),
`API_HEALTH_URL`, `SITE_BASE`.

`EXPECT_HOST` (**`camaras`**, comparación exacta) y `PRIVATE_BASE` (**`/root`**) se **fuerzan
en producción**: sólo se aceptan valores distintos con `ALLOW_TEST_OVERRIDES=1` (modo explícito
de las pruebas herméticas). **No** hay override del host productivo fuera de ese modo.

## TLS

`curl` se usa **sin `-k`**: un certificado inválido hace fallar la verificación (no se omite TLS).

## Uso (cuando esté autorizado)

```bash
cd /home/sistemas/Gestion_camaras   # checkout productivo actual (ed3e0cc)
EXPECT_HEAD=<sha40_head_productivo> \
EXPECT_TARGET_SHA=<sha40_de_origin_main_ya_fusionado> \
EXPECT_MERGE_SHA=<sha40_del_merge_de_#177> \
HLS_PROBE_PATH=/hls/nvr_<id_real>_ch<NN>_sub/index.m3u8 \
  bash scripts/deploy-hls-auth-bootstrap.sh
```

`GO: …` = éxito. Cualquier `NO_GO: …` = abortó antes de mutar (o revirtió). El bootstrap
imprime `BOOTSTRAP_OK priv=<dir>` con la ruta de evidencia antes de delegar en el deploy.

> Si el checkout productivo ya está en el target, el deploy puede correrse directo:
> `bash scripts/deploy-hls-auth-parent-uri.sh` (mismas variables).

## Compuertas del deploy — aborta ANTES de mutar si

1. `EXPECT_HEAD`/`EXPECT_TARGET_SHA`/`EXPECT_MERGE_SHA` no son 40 hex.
2. `HLS_PROBE_PATH` inválido o placeholder.
3. `hostname` != `camaras` (exacto).
4. Rama != `main`.
5. `visioncore-backup.timer` no está activo.
6. HEAD productivo != `EXPECT_HEAD`.
7. `origin/main` != `EXPECT_TARGET_SHA` (objetivo no inmovilizado / carrera).
8. `EXPECT_TARGET_SHA` no contiene el merge aprobado.
9. El contenedor nginx no está corriendo (`{{.State.Running}}` != `true`).
10. **Baseline** no sano: la config **activa** (`nginx -T`) no cumple el cableado, o
    API != 200, o HLS anónimo != 401 **antes** de tocar nada.
11. Hay más de un cambio local, o el único no es `infra/nginx/nginx.conf`.
12. El hotfix local o el `EXPECT_TARGET_SHA:nginx.conf` no cumplen el **cableado activo**
    (exactamente una directiva activa de cada una, en su location; sin `X-Original-URI $uri`
    activa) — comparación **semántica**, ignorando comentarios y números de línea.
13. No se puede crear/verificar el backup (checksum) o el backup no tiene el cableado.

La validación del cableado se hace sobre **líneas activas** con
`scripts/check-hls-auth-nginx.sh <archivo>` (reutilizable para el hotfix local, el backup, la
config de `EXPECT_TARGET_SHA` y la config **activa** de `nginx -T`).

## Backup (antes de retirar el cambio local)

Crea `${BACKUP_DIR}/nginx.conf.operativo.<ts>` (600), registra `.sha256`, **verifica el
checksum de inmediato**, y valida el cableado activo del backup.

## Mutación controlada (recién tras todas las compuertas)

`git checkout -- infra/nginx/nginx.conf` (descarta sólo el cambio respaldado) →
`git merge --ff-only "$ORIGIN_MAIN"` (objeto ya fetch-eado, **no re-fetch**) → confirma
`HEAD == EXPECT_TARGET_SHA` y árbol limpio → `nginx -t` → `nginx -s reload` (**sólo nginx**,
sin recrear contenedores).

## Verificación posterior

Mismo `Id` y `StartedAt` del contenedor nginx (no se recreó/reinició); API HTTP **200**;
HLS sin sesión HTTP **401**; la config **activa** (`nginx -T`) cumple el cableado (3
directivas, sin variante rota); backup disponible; `visioncore-backup.timer` activo.

## Rollback automático (trap) — SECUENCIAL, con corte por fase

Sólo tras mutación. Imprime **una** línea de resultado y **corta** en el primer fallo (no
ejecuta fases posteriores). `AUTOMATIC_ROLLBACK=PASS` **sólo si TODAS** las fases pasan:

- **Fase 1** — backup existe, checksum existe, `sha256sum -c` pasa, cableado del backup válido.
  Falla ⇒ FAILED **sin** `cp`, **sin** `nginx -t`, **sin** reload.
- **Fase 2** — `cp` del backup. Falla ⇒ FAILED **sin** `nginx -t`, **sin** reload.
- **Fase 3** — el archivo restaurado coincide con el SHA-256 respaldado + cableado válido.
  Falla ⇒ FAILED **sin** reload.
- **Fase 4** — `nginx -t`. Falla ⇒ FAILED **sin** reload.
- **Fase 5** — `nginx -s reload`. Falla ⇒ FAILED.
- **Fase 6** — config activa (`nginx -T`) cumple el cableado, API 200, HLS anónimo 401,
  `visioncore-backup.timer` activo. Sólo entonces ⇒ `AUTOMATIC_ROLLBACK=PASS`.

Cualquier fallo ⇒ `AUTOMATIC_ROLLBACK=FAILED (faseN: ...)` y el proceso mantiene exit ≠ 0.
Las pruebas negativas verifican con **contadores** que checksum corrupto ⇒ `cp=0, nginx -t=0,
reload=0`; `cp` falla ⇒ `nginx -t=0, reload=0`; `nginx -t` falla ⇒ `reload=0`; y que **ningún**
escenario FAILED imprime PASS. **Nunca** desactiva `auth_request` ni vuelve a `X-Original-URI $uri`.

## Estado
MERGE=NO · DEPLOY=NO · PRODUCTION=UNTOUCHED. No ejecutar sin autorización expresa y #177 fusionado.
