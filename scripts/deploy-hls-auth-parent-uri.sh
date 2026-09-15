#!/usr/bin/env bash
# scripts/deploy-hls-auth-parent-uri.sh
#
# Runbook EJECUTABLE y FAIL-CLOSED del deploy del fix HLS (URI del request padre).
# Sólo recarga nginx; NO recrea contenedores, NO migra, NO toca datos. Producción
# tiene un cambio local no versionado (`M infra/nginx/nginx.conf` = hotfix operativo),
# así que un `git pull` a ciegas se detendría: este script respalda ese archivo,
# valida TODO con compuertas que abortan (exit != 0), retira el cambio local
# respaldado, hace fast-forward y recarga sólo nginx, con rollback automático al
# backup si algo falla DESPUÉS de mutar.
#
# NUNCA desactiva `auth_request` ni vuelve a `X-Original-URI $uri`.
#
# Requiere variables reales (sin placeholders); aborta si faltan:
#   EXPECT_HEAD        HEAD productivo esperado ANTES del deploy (SHA de 40 hex)
#   EXPECT_MERGE_SHA   SHA del merge aprobado de #177 que origin/main debe contener
#   HLS_PROBE_PATH     path HLS real para la sonda 401 (/hls/nvr_<id>_ch<NN>_<tipo>/...)
# Opcionales con default real:
#   DEPLOY_ROOT=/home/sistemas/Gestion_camaras  EXPECT_HOST_RE='^camaras'
#   EXPECT_BRANCH=main  NGINX_SVC=nginx  NGINX_CTR=visioncore_nginx
#   API_HEALTH_URL=https://camaras.saa.com.py/api/health
#   SITE_BASE=https://camaras.saa.com.py  BACKUP_DIR=/var/backups/visioncore
#   BACKUP_TIMER_UNIT=   (si se define, se exige `systemctl is-active` OK al final)
#
# La lógica de compuertas está en funciones puras (gate_*) para poder ejercerla con
# pruebas negativas (ver scripts/deploy-hls-auth-parent-uri.test.sh). Sourcear con
# RUNBOOK_LIB=1 define las funciones SIN ejecutar main().

set -Eeuo pipefail

fail() {
  echo "NO_GO: $*" >&2
  exit 1
}

CONF_REL="infra/nginx/nginx.conf"
D_SET='set $hls_original_uri $uri;'
D_HDR='proxy_set_header X-Original-URI $hls_original_uri;'
D_AUTH='auth_request /internal/hls-auth;'
D_BROKEN='proxy_set_header X-Original-URI $uri;'

# ── Compuertas puras (fallan con exit != 0 vía fail()) ────────────────────────
gate_host()   { [[ "${1:-}" =~ ${EXPECT_HOST_RE:-^camaras} ]] || fail "hostname '${1:-}' no es camaras"; }
gate_branch() { [ "${1:-}" = "${EXPECT_BRANCH:-main}" ] || fail "rama '${1:-}' != ${EXPECT_BRANCH:-main}"; }
gate_head()   { [ "${1:-}" = "${2:-}" ] || fail "HEAD productivo '${1:-}' != esperado '${2:-}'"; }

# origin/main ($1) debe CONTENER el merge aprobado ($2) como ancestro (o ser igual).
gate_origin_has_merge() {
  local origin="$1" merge="$2"
  [ -n "$origin" ] && [ -n "$merge" ] || fail "faltan SHAs para verificar el merge en origin/main"
  git merge-base --is-ancestor "$merge" "$origin" \
    || fail "origin/main ($origin) no contiene el merge aprobado ($merge)"
}

# $1 = salida de `git status --porcelain`. Exactamente 1 cambio y es CONF_REL.
gate_single_local_change() {
  local st="$1" n
  n="$(printf '%s' "$st" | grep -c . || true)"
  [ "$n" -eq 1 ] || fail "hay $n cambios locales (se espera EXACTAMENTE 1: $CONF_REL)"
  printf '%s\n' "$st" | grep -qE "^ M ${CONF_REL}\$" \
    || fail "el único cambio local no es ' M ${CONF_REL}'"
}

# El archivo ($1) DEBE contener las 3 directivas del fix.
gate_conf_has_directives() {
  local f="$1"
  [ -f "$f" ] || fail "no existe el archivo $f"
  grep -qF "$D_SET"  "$f" || fail "falta en $f: $D_SET"
  grep -qF "$D_HDR"  "$f" || fail "falta en $f: $D_HDR"
  grep -qF "$D_AUTH" "$f" || fail "falta en $f: $D_AUTH"
}

# El archivo ($1) NO debe contener la variante rota.
gate_conf_no_broken() {
  local f="$1"
  [ -f "$f" ] || fail "no existe el archivo $f"
  ! grep -qF "$D_BROKEN" "$f" || fail "$f contiene la variante rota: $D_BROKEN"
}

# Comparación SEMÁNTICA del cableado auth_request entre local ($1) y origin ($2).
# No es "a ojo": extrae las líneas relevantes y exige igualdad exacta.
gate_semantic_equal() {
  local local_f="$1" origin_f="$2" a b
  a="$(grep -nE 'hls_original_uri|auth_request /internal/hls-auth;|X-Original-URI' "$local_f" | sed 's/^[0-9]*://')"
  b="$(grep -nE 'hls_original_uri|auth_request /internal/hls-auth;|X-Original-URI' "$origin_f" | sed 's/^[0-9]*://')"
  [ -n "$a" ] || fail "no se pudo extraer el cableado auth_request del hotfix local"
  [ "$a" = "$b" ] || fail "el cableado auth_request DIFIERE entre el hotfix local y origin/main"
}

# HLS_PROBE_PATH ($1) debe tener forma de stream real (sin placeholders).
gate_probe_path() {
  local p="${1:-}"
  [[ "$p" =~ ^/hls/nvr_[^/]+_ch[0-9]+_[A-Za-z0-9_]+/.+$ ]] \
    || fail "HLS_PROBE_PATH inválido: '$p' (esperado /hls/nvr_<id>_ch<NN>_<tipo>/<archivo>)"
  [[ "$p" == *'<'* || "$p" == *'>'* || "$p" == *'algún'* ]] \
    && fail "HLS_PROBE_PATH contiene un placeholder: '$p'" || true
}

# Verifica un backup: existe, no vacío, checksum OK, tiene 3 directivas y no la rota.
gate_backup_ok() {
  local bk="$1" sums="$2"
  [ -s "$bk" ] || fail "el backup $bk no existe o está vacío"
  [ -s "$sums" ] || fail "no existe el checksum $sums"
  ( cd "$(dirname "$sums")" && sha256sum -c "$(basename "$sums")" >/dev/null 2>&1 ) \
    || fail "el checksum del backup NO verifica ($sums)"
  gate_conf_has_directives "$bk"
  gate_conf_no_broken "$bk"
}

http_code() { curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo "000"; }

# ── Rollback automático (sólo si ya hubo mutación) ────────────────────────────
MUTATED=0
BACKUP_FILE=""
on_exit() {
  local rc="$1"
  [ "$rc" -eq 0 ] && return 0
  if [ "$MUTATED" -ne 1 ]; then
    echo "NO_GO (sin mutación; nada que revertir)." >&2
    return 0
  fi
  echo "AUTOMATIC_ROLLBACK: iniciando (restaurando backup operativo)..." >&2
  set +e
  cp -f "$BACKUP_FILE" "$CONF_REL"
  # NUNCA desactivar auth_request ni volver a $uri: se restaura el backup tal cual,
  # que ya contiene el cableado correcto (validado por gate_backup_ok).
  docker compose exec -T "${NGINX_SVC:-nginx}" nginx -t \
    && docker compose exec -T "${NGINX_SVC:-nginx}" nginx -s reload
  local api hls
  api="$(http_code "${API_HEALTH_URL}")"
  hls="$(http_code "${SITE_BASE}${HLS_PROBE_PATH}")"
  if [ "$api" = "200" ] && [ "$hls" = "401" ]; then
    echo "AUTOMATIC_ROLLBACK=PASS (api=$api hls_anon=$hls)" >&2
  else
    echo "AUTOMATIC_ROLLBACK=FAILED (api=$api hls_anon=$hls) — INTERVENCIÓN MANUAL" >&2
  fi
}
trap 'on_exit $?' EXIT

main() {
  # Config (valores reales; requeridos abortan si faltan — NO son placeholders).
  : "${DEPLOY_ROOT:=/home/sistemas/Gestion_camaras}"
  : "${EXPECT_HOST_RE:=^camaras}"
  : "${EXPECT_BRANCH:=main}"
  NGINX_SVC="${NGINX_SVC:-nginx}"
  NGINX_CTR="${NGINX_CTR:-visioncore_nginx}"
  API_HEALTH_URL="${API_HEALTH_URL:-https://camaras.saa.com.py/api/health}"
  SITE_BASE="${SITE_BASE:-https://camaras.saa.com.py}"
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/visioncore}"
  : "${EXPECT_HEAD:?EXPECT_HEAD requerido (HEAD productivo esperado, 40 hex)}"
  : "${EXPECT_MERGE_SHA:?EXPECT_MERGE_SHA requerido (merge aprobado que origin/main debe contener)}"
  : "${HLS_PROBE_PATH:?HLS_PROBE_PATH requerido (/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>)}"

  cd "$DEPLOY_ROOT" || fail "no se puede entrar a $DEPLOY_ROOT"

  echo "== PRE-COMPUERTAS (sin mutar) =="
  gate_probe_path "$HLS_PROBE_PATH"
  gate_host   "$(hostname)"
  gate_branch "$(git rev-parse --abbrev-ref HEAD)"

  # 6) Capturas ANTES de cualquier mutación.
  HEAD_BEFORE="$(git rev-parse HEAD)"
  gate_head "$HEAD_BEFORE" "$EXPECT_HEAD"
  git fetch origin main --quiet || fail "git fetch origin main falló"
  ORIGIN_MAIN="$(git rev-parse origin/main)"
  gate_origin_has_merge "$ORIGIN_MAIN" "$EXPECT_MERGE_SHA"

  NGINX_ID_BEFORE="$(docker inspect -f '{{.Id}}' "$NGINX_CTR")"       || fail "no se pudo inspeccionar $NGINX_CTR"
  NGINX_STARTED_BEFORE="$(docker inspect -f '{{.State.StartedAt}}' "$NGINX_CTR")" || fail "no se pudo leer StartedAt de $NGINX_CTR"
  TREE_STATUS="$(git status --porcelain)"
  gate_single_local_change "$TREE_STATUS"

  # El hotfix local DEBE estar presente y correcto (fail-closed).
  gate_conf_has_directives "$CONF_REL"
  gate_conf_no_broken      "$CONF_REL"

  # origin/main fusionado DEBE tener las 3 directivas y NO la rota.
  ORIGIN_CONF="$(mktemp)"; trap 'rm -f "$ORIGIN_CONF"' RETURN
  git show "origin/main:${CONF_REL}" > "$ORIGIN_CONF" || fail "no se pudo leer origin/main:${CONF_REL}"
  gate_conf_has_directives "$ORIGIN_CONF"
  gate_conf_no_broken      "$ORIGIN_CONF"

  # Comparación semántica programática (no "a ojo").
  gate_semantic_equal "$CONF_REL" "$ORIGIN_CONF"

  # 3+5) Backup del archivo operativo + checksum + verificación inmediata.
  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 700 "$BACKUP_DIR" || fail "no se pudo crear $BACKUP_DIR"
  BACKUP_FILE="${BACKUP_DIR}/nginx.conf.operativo.${ts}"
  install -m 600 "$CONF_REL" "$BACKUP_FILE" || fail "no se pudo crear el backup"
  local SUMS="${BACKUP_FILE}.sha256"
  ( cd "$(dirname "$BACKUP_FILE")" && sha256sum "$(basename "$BACKUP_FILE")" > "$SUMS" ) || fail "no se pudo calcular el checksum"
  gate_backup_ok "$BACKUP_FILE" "$SUMS"

  echo "HEAD_BEFORE=$HEAD_BEFORE"
  echo "ORIGIN_MAIN=$ORIGIN_MAIN"
  echo "NGINX_ID_BEFORE=$NGINX_ID_BEFORE"
  echo "NGINX_STARTED_BEFORE=$NGINX_STARTED_BEFORE"
  echo "BACKUP_FILE=$BACKUP_FILE"
  echo "BACKUP_SHA256=$(cut -d' ' -f1 "$SUMS")"

  # 7) MUTACIÓN CONTROLADA (a partir de aquí, el trap revierte ante cualquier fallo).
  echo "== MUTACIÓN CONTROLADA =="
  MUTATED=1
  git checkout -- "$CONF_REL"                 # descarta SÓLO el cambio local (respaldado)
  git pull --ff-only origin main              # fast-forward; falla si no lo es
  [ "$(git rev-parse HEAD)" = "$ORIGIN_MAIN" ] || fail "HEAD tras pull != origin/main"
  [ -z "$(git status --porcelain)" ]          || fail "árbol no limpio tras el pull"
  gate_conf_has_directives "$CONF_REL"
  gate_conf_no_broken      "$CONF_REL"

  # 8) nginx -t y recarga SÓLO de nginx (sin recrear contenedores).
  docker compose exec -T "$NGINX_SVC" nginx -t || fail "nginx -t falló tras el pull"
  docker compose exec -T "$NGINX_SVC" nginx -s reload || fail "nginx -s reload falló"

  # Verificación posterior.
  local id_after started_after
  id_after="$(docker inspect -f '{{.Id}}' "$NGINX_CTR")"
  started_after="$(docker inspect -f '{{.State.StartedAt}}' "$NGINX_CTR")"
  [ "$id_after" = "$NGINX_ID_BEFORE" ]           || fail "el contenedor nginx cambió de ID (¿se recreó?)"
  [ "$started_after" = "$NGINX_STARTED_BEFORE" ] || fail "StartedAt de nginx cambió (¿se reinició?)"

  local api hls
  api="$(http_code "$API_HEALTH_URL")"
  [ "$api" = "200" ] || fail "API no responde 200 (got $api)"
  hls="$(http_code "${SITE_BASE}${HLS_PROBE_PATH}")"
  [ "$hls" = "401" ] || fail "HLS sin sesión no responde 401 (got $hls)"

  # La config ACTIVA (nginx -T) conserva las 3 directivas y auth_request activo.
  local active; active="$(docker compose exec -T "$NGINX_SVC" nginx -T 2>/dev/null)"
  printf '%s' "$active" | grep -qF "$D_SET"  || fail "config activa sin: $D_SET"
  printf '%s' "$active" | grep -qF "$D_HDR"  || fail "config activa sin: $D_HDR"
  printf '%s' "$active" | grep -qF "$D_AUTH" || fail "config activa sin auth_request (¿desactivado?)"
  printf '%s' "$active" | grep -qF "$D_BROKEN" && fail "config activa contiene la variante rota" || true

  # Backup disponible para rollback (y timer de backup activo si se configuró).
  gate_backup_ok "$BACKUP_FILE" "$SUMS"
  if [ -n "${BACKUP_TIMER_UNIT:-}" ]; then
    systemctl is-active --quiet "$BACKUP_TIMER_UNIT" || fail "timer de backup '$BACKUP_TIMER_UNIT' no activo"
  fi

  echo "GO: deploy HLS auth_request OK — nginx recargado (id/StartedAt intactos), api=200, hls_anon=401,"
  echo "    config activa conserva set/\$hls_original_uri + X-Original-URI \$hls_original_uri + auth_request."
  echo "MERGE=NO DEPLOY=solo-nginx-reload PRODUCTION=modificada-solo-nginx"
}

if [ "${RUNBOOK_LIB:-0}" != "1" ]; then
  main "$@"
fi
