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

## Por qué hace falta un Stage 0 copiable (y no un script de archivo)

Producción está en `ed3e0cc`. Los **tres** archivos del runbook —
`deploy-hls-auth-bootstrap.sh`, `deploy-hls-auth-parent-uri.sh` y
`check-hls-auth-nginx.sh` — son **nuevos del PR #177**: **ninguno existe** en el checkout
productivo antes del fast-forward. Por eso `bash scripts/deploy-hls-auth-bootstrap.sh`
(igual que el deploy o el guard) **no puede ejecutarse desde `ed3e0cc`** — sería el mismo
problema de recursión.

El **punto de entrada** es el bloque **Stage 0** de la sección siguiente: un fragmento Bash
**autocontenido** que el operador **copia y pega** en la terminal del servidor. Stage 0 no
depende de ningún archivo del working tree ni de la red: hace todas las compuertas, inmoviliza
el target, y sólo entonces **extrae los tres scripts del objeto Git inmóvil** (`git show
${EXPECT_TARGET_SHA}:…`) a un directorio privado, registra su SHA-256, corre `bash -n`, y
ejecuta **directamente el deploy con su guard adyacente**. **Nunca** usa URL, `curl`,
`raw.githubusercontent.com` ni scripts del working tree, y **nunca** ejecuta código antes de
validar que proviene del target exacto aprobado.

## Stage 0 — punto de entrada (copiar/pegar desde el checkout productivo)

Exportar antes las 4 variables reales (`EXPECT_HEAD`, `EXPECT_TARGET_SHA`, `EXPECT_MERGE_SHA`,
`HLS_PROBE_PATH`) y pegar tal cual:

```bash
# >>> STAGE 0 BEGIN
set -Eeuo pipefail
umask 077
fail(){ echo "NO_GO: $*" >&2; exit 1; }
is40(){ [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }

: "${EXPECT_HEAD:?EXPECT_HEAD requerido (40 hex)}"
: "${EXPECT_TARGET_SHA:?EXPECT_TARGET_SHA requerido (40 hex)}"
: "${EXPECT_MERGE_SHA:?EXPECT_MERGE_SHA requerido (40 hex)}"
: "${HLS_PROBE_PATH:?HLS_PROBE_PATH requerido (/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>)}"
: "${DEPLOY_ROOT:=/home/sistemas/Gestion_camaras}"

# host / rama / base privada: forzados en producción; sólo overrideables con
# ALLOW_TEST_OVERRIDES=1 (modo explícito de las pruebas herméticas).
if [ "${ALLOW_TEST_OVERRIDES:-0}" = "1" ]; then
  : "${EXPECT_HOST:=camaras}"; : "${EXPECT_BRANCH:=main}"; : "${PRIVATE_BASE:=/root}"
else
  EXPECT_HOST=camaras; EXPECT_BRANCH=main; PRIVATE_BASE=/root
fi

is40 "$EXPECT_HEAD"       || fail "EXPECT_HEAD no es 40 hex"
is40 "$EXPECT_TARGET_SHA" || fail "EXPECT_TARGET_SHA no es 40 hex"
is40 "$EXPECT_MERGE_SHA"  || fail "EXPECT_MERGE_SHA no es 40 hex"
[ "$(hostname)" = "$EXPECT_HOST" ] || fail "hostname '$(hostname)' != '$EXPECT_HOST'"

cd "$DEPLOY_ROOT" || fail "no se puede entrar a $DEPLOY_ROOT"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$EXPECT_BRANCH" ] || fail "rama != $EXPECT_BRANCH"
[ "$(git rev-parse HEAD)" = "$EXPECT_HEAD" ] || fail "HEAD productivo != EXPECT_HEAD"

git fetch origin main --quiet || fail "git fetch origin main falló"
[ "$(git rev-parse origin/main)" = "$EXPECT_TARGET_SHA" ] \
  || fail "origin/main != EXPECT_TARGET_SHA (target no inmovilizado / carrera)"
git merge-base --is-ancestor "$EXPECT_MERGE_SHA" "$EXPECT_TARGET_SHA" \
  || fail "EXPECT_TARGET_SHA no contiene EXPECT_MERGE_SHA"

[ -d "$PRIVATE_BASE" ] || fail "PRIVATE_BASE no existe: $PRIVATE_BASE"
STAGE0_PRIV="$(mktemp -d "${PRIVATE_BASE%/}/hls-deploy.XXXXXX")" || fail "no se pudo crear el dir privado"
chmod 700 "$STAGE0_PRIV"

# Extraer los TRES scripts SÓLO del objeto Git inmóvil (nunca URL/curl/raw ni working tree).
for f in scripts/deploy-hls-auth-bootstrap.sh scripts/deploy-hls-auth-parent-uri.sh scripts/check-hls-auth-nginx.sh; do
  git cat-file -e "${EXPECT_TARGET_SHA}:$f" 2>/dev/null || fail "no existe ${EXPECT_TARGET_SHA}:$f"
  git show "${EXPECT_TARGET_SHA}:$f" > "$STAGE0_PRIV/$(basename "$f")" || fail "no se pudo extraer $f"
  [ -s "$STAGE0_PRIV/$(basename "$f")" ] || fail "extracción vacía de $f"
done
chmod 700 "$STAGE0_PRIV"/*.sh

# Registrar SHA-256 de los TRES y validar sintaxis ANTES de ejecutar nada.
( cd "$STAGE0_PRIV" && sha256sum deploy-hls-auth-bootstrap.sh deploy-hls-auth-parent-uri.sh check-hls-auth-nginx.sh | tee EVIDENCE.sha256 )
for s in deploy-hls-auth-bootstrap.sh deploy-hls-auth-parent-uri.sh check-hls-auth-nginx.sh; do
  bash -n "$STAGE0_PRIV/$s" || fail "bash -n falló en $s"
done
echo "STAGE0_OK priv=$STAGE0_PRIV"

# Ejecutar DIRECTAMENTE el deploy desde el dir privado, con su guard adyacente extraído.
# (Alternativa equivalente: bash "$STAGE0_PRIV/deploy-hls-auth-bootstrap.sh".)
CHECK_SCRIPT="$STAGE0_PRIV/check-hls-auth-nginx.sh" \
  bash "$STAGE0_PRIV/deploy-hls-auth-parent-uri.sh"
# <<< STAGE 0 END
```

`STAGE0_OK …` seguido de `GO: …` = éxito. Cualquier `NO_GO: …` = abortó antes de mutar
(o revirtió). El deploy ya versionado (`scripts/deploy-hls-auth-parent-uri.sh`) y el
bootstrap (`scripts/deploy-hls-auth-bootstrap.sh`) sólo son utilizables **una vez que el
checkout está en el target**; desde `ed3e0cc` el único punto de entrada válido es este
Stage 0.

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

Desde `ed3e0cc`, **el único punto de entrada es el bloque Stage 0 de arriba** (copiar/pegar).
Exportar antes las 4 variables:

```bash
cd /home/sistemas/Gestion_camaras   # checkout productivo actual (ed3e0cc)
export EXPECT_HEAD=<sha40_head_productivo>
export EXPECT_TARGET_SHA=<sha40_de_origin_main_ya_fusionado>
export EXPECT_MERGE_SHA=<sha40_del_merge_de_#177>
export HLS_PROBE_PATH=/hls/nvr_<id_real>_ch<NN>_sub/index.m3u8
# …luego pegar el bloque Stage 0 completo de la sección anterior.
```

> **No** ejecutar `bash scripts/deploy-hls-auth-bootstrap.sh` (ni el deploy/guard) desde
> `ed3e0cc`: esos archivos **no existen** en el checkout productivo hasta el fast-forward.
> Sólo son utilizables una vez que el checkout está en el target.

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
