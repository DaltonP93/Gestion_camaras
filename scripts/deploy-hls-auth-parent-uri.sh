#!/usr/bin/env bash
# scripts/deploy-hls-auth-parent-uri.sh
#
# Runbook EJECUTABLE y FAIL-CLOSED del deploy del fix HLS (URI del request padre).
# Sólo recarga nginx; NO recrea contenedores, NO migra, NO toca datos. Producción
# tiene `M infra/nginx/nginx.conf` (hotfix operativo no versionado): el script lo
# respalda, valida TODO con compuertas que abortan (exit != 0), retira sólo ese cambio
# respaldado, hace fast-forward al SHA objetivo INMÓVIL y recarga sólo nginx, con
# rollback automático real si algo falla DESPUÉS de mutar.
#
# NUNCA desactiva `auth_request` ni vuelve a `X-Original-URI $uri`.
#
# Variables REQUERIDAS (reales; aborta si faltan):
#   EXPECT_HEAD        HEAD productivo esperado ANTES del deploy (40 hex)
#   EXPECT_TARGET_SHA  SHA EXACTO al que se hará fast-forward (40 hex); == origin/main
#   EXPECT_MERGE_SHA   SHA del merge aprobado que EXPECT_TARGET_SHA debe contener (40 hex)
#   HLS_PROBE_PATH     path HLS real para la sonda 401 (/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>)
# Opcionales con default real:
#   DEPLOY_ROOT=/home/sistemas/Gestion_camaras  EXPECT_HOST=camaras  EXPECT_BRANCH=main
#   NGINX_SVC=nginx  NGINX_CTR=visioncore_nginx  BACKUP_DIR=/var/backups/visioncore
#   BACKUP_TIMER_UNIT=visioncore-backup.timer (OBLIGATORIO: se exige activo antes y después)
#   API_HEALTH_URL=https://camaras.saa.com.py/api/health  SITE_BASE=https://camaras.saa.com.py
#
# TLS: curl SIN `-k` (un certificado inválido debe fallar).
#
# Compuertas puras en funciones gate_* para pruebas negativas; sourcear con
# RUNBOOK_LIB=1 define funciones SIN ejecutar main().

set -Eeuo pipefail

fail() { echo "NO_GO: $*" >&2; exit 1; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="${CHECK_SCRIPT:-$SELF_DIR/check-hls-auth-nginx.sh}"
CONF_REL="infra/nginx/nginx.conf"
D_SET='set $hls_original_uri $uri;'
D_HDR='proxy_set_header X-Original-URI $hls_original_uri;'
D_AUTH='auth_request /internal/hls-auth;'
D_BROKEN='proxy_set_header X-Original-URI $uri;'

is_sha40() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }

# Valida el cableado auth_request ACTIVO (ignora comentarios) de un archivo de config.
validate_wiring() { bash "$CHECK_SCRIPT" "$1" >/dev/null 2>&1; }

# curl SIN -k (TLS estricto) y SIN -f (para poder capturar 401). Código o 000.
http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo "000"; }

# ── Compuertas (fail() ⇒ exit != 0) ───────────────────────────────────────────
gate_host()   { [ "${1:-}" = "${EXPECT_HOST:-camaras}" ] || fail "hostname '${1:-}' != '${EXPECT_HOST:-camaras}'"; }
gate_branch() { [ "${1:-}" = "${EXPECT_BRANCH:-main}" ] || fail "rama '${1:-}' != ${EXPECT_BRANCH:-main}"; }
gate_sha40()  { is_sha40 "${2:-}" || fail "$1 no es un SHA de 40 hex: '${2:-}'"; }
gate_head()   { [ "${1:-}" = "${2:-}" ] || fail "HEAD productivo '${1:-}' != esperado '${2:-}'"; }
gate_origin_is_target() { [ "${1:-}" = "${2:-}" ] || fail "origin/main '${1:-}' != EXPECT_TARGET_SHA '${2:-}' (target no inmovilizado)"; }
gate_target_has_merge() {  # $1 = target, $2 = merge aprobado; merge debe ser ancestro de target
  git merge-base --is-ancestor "$2" "$1" || fail "EXPECT_TARGET_SHA ($1) no contiene el merge aprobado ($2)"
}
gate_single_local_change() {  # $1 = git status --porcelain
  local st="$1" n; n="$(printf '%s' "$st" | grep -c . || true)"
  [ "$n" -eq 1 ] || fail "hay $n cambios locales (se espera EXACTAMENTE 1: $CONF_REL)"
  printf '%s\n' "$st" | grep -qE "^ M ${CONF_REL}\$" || fail "el único cambio local no es ' M ${CONF_REL}'"
}
gate_conf_has_directives() {  # valida SÓLO líneas activas vía el guard reutilizable
  validate_wiring "$1" || fail "cableado auth_request inválido/roto (líneas activas) en $1"
}
gate_semantic_equal() {  # comparación semántica: ambos deben cumplir el MISMO contrato activo
  validate_wiring "$1" || fail "cableado auth_request inválido en el hotfix local ($1)"
  validate_wiring "$2" || fail "cableado auth_request inválido en origin/main ($2)"
}
gate_probe_path() {
  local p="${1:-}"
  case "$p" in *'<'*|*'>'*|*'algún'*) fail "HLS_PROBE_PATH contiene un placeholder: '$p'";; esac
  [[ "$p" =~ ^/hls/nvr_[^/]+_ch[0-9]+_[A-Za-z0-9_]+/.+$ ]] \
    || fail "HLS_PROBE_PATH inválido: '$p' (esperado /hls/nvr_<id>_ch<NN>_<tipo>/<archivo>)"
}
gate_timer_active() { systemctl is-active --quiet "$1" || fail "timer de backup '$1' no está activo"; }
gate_backup_ok() {  # existe, no vacío, checksum verifica, cableado activo válido
  local bk="$1" sums="$2"
  [ -s "$bk" ] || fail "el backup $bk no existe o está vacío"
  [ -s "$sums" ] || fail "no existe el checksum $sums"
  ( cd "$(dirname "$sums")" && sha256sum -c "$(basename "$sums")" >/dev/null 2>&1 ) || fail "checksum del backup NO verifica"
  validate_wiring "$bk" || fail "el backup no tiene el cableado auth_request correcto"
}

# ── Rollback automático real (sólo tras mutación). Verifica CADA paso. ─────────
MUTATED=0
BACKUP_FILE=""
BACKUP_SUMS=""
do_rollback() {  # devuelve 0 sólo si TODOS los pasos pasan
  set +e
  local ok=1 want have act
  # (1) backup + checksum revalidan
  [ -s "$BACKUP_FILE" ] && [ -s "$BACKUP_SUMS" ] || ok=0
  ( cd "$(dirname "$BACKUP_SUMS")" && sha256sum -c "$(basename "$BACKUP_SUMS")" >/dev/null 2>&1 ) || ok=0
  # (2) cp termina en 0
  cp -f "$BACKUP_FILE" "$CONF_REL" || ok=0
  # (3) archivo restaurado coincide con el SHA-256 respaldado
  want="$(cut -d' ' -f1 "$BACKUP_SUMS" 2>/dev/null)"
  have="$(sha256sum "$CONF_REL" 2>/dev/null | cut -d' ' -f1)"
  [ -n "$want" ] && [ "$want" = "$have" ] || ok=0
  # (4) nginx -t == 0
  docker compose exec -T "$NGINX_SVC" nginx -t >/dev/null 2>&1 || ok=0
  # (5) nginx -s reload == 0
  docker compose exec -T "$NGINX_SVC" nginx -s reload >/dev/null 2>&1 || ok=0
  # (6)(7) config ACTIVA con 3 directivas y sin variante rota
  act="$(mktemp)"
  if docker compose exec -T "$NGINX_SVC" nginx -T > "$act" 2>/dev/null; then
    validate_wiring "$act" || ok=0
  else ok=0; fi
  rm -f "$act"
  # (8) API 200
  [ "$(http_code "$API_HEALTH_URL")" = "200" ] || ok=0
  # (9) HLS anónimo 401
  [ "$(http_code "${SITE_BASE}${HLS_PROBE_PATH}")" = "401" ] || ok=0
  [ "$ok" -eq 1 ]
}
on_exit() {
  local rc="$1"
  [ "$rc" -eq 0 ] && return 0
  if [ "$MUTATED" -ne 1 ]; then
    echo "NO_GO (sin mutación; nada que revertir)." >&2
    return 0
  fi
  echo "AUTOMATIC_ROLLBACK: iniciando (restaurando backup operativo)..." >&2
  if do_rollback; then
    echo "AUTOMATIC_ROLLBACK=PASS" >&2
  else
    echo "AUTOMATIC_ROLLBACK=FAILED — INTERVENCIÓN MANUAL (nunca se desactiva auth_request ni se vuelve a \$uri)" >&2
  fi
  # el exit code sigue siendo != 0 (rc): el deploy falló aunque el rollback pase.
}
trap 'on_exit $?' EXIT

main() {
  : "${DEPLOY_ROOT:=/home/sistemas/Gestion_camaras}"
  : "${EXPECT_HOST:=camaras}"
  : "${EXPECT_BRANCH:=main}"
  NGINX_SVC="${NGINX_SVC:-nginx}"
  NGINX_CTR="${NGINX_CTR:-visioncore_nginx}"
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/visioncore}"
  BACKUP_TIMER_UNIT="${BACKUP_TIMER_UNIT:-visioncore-backup.timer}"
  API_HEALTH_URL="${API_HEALTH_URL:-https://camaras.saa.com.py/api/health}"
  SITE_BASE="${SITE_BASE:-https://camaras.saa.com.py}"
  : "${EXPECT_HEAD:?EXPECT_HEAD requerido (HEAD productivo esperado, 40 hex)}"
  : "${EXPECT_TARGET_SHA:?EXPECT_TARGET_SHA requerido (SHA objetivo exacto, 40 hex)}"
  : "${EXPECT_MERGE_SHA:?EXPECT_MERGE_SHA requerido (merge aprobado, 40 hex)}"
  : "${HLS_PROBE_PATH:?HLS_PROBE_PATH requerido (/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>)}"

  cd "$DEPLOY_ROOT" || fail "no se puede entrar a $DEPLOY_ROOT"

  echo "== PRE-COMPUERTAS (sin mutar) =="
  gate_sha40 "EXPECT_HEAD" "$EXPECT_HEAD"
  gate_sha40 "EXPECT_TARGET_SHA" "$EXPECT_TARGET_SHA"
  gate_sha40 "EXPECT_MERGE_SHA" "$EXPECT_MERGE_SHA"
  gate_probe_path "$HLS_PROBE_PATH"
  gate_host   "$(hostname)"
  gate_branch "$(git rev-parse --abbrev-ref HEAD)"
  gate_timer_active "$BACKUP_TIMER_UNIT"           # OBLIGATORIO antes

  # 6) Capturas ANTES de mutar.
  HEAD_BEFORE="$(git rev-parse HEAD)"
  gate_head "$HEAD_BEFORE" "$EXPECT_HEAD"
  git fetch origin main --quiet || fail "git fetch origin main falló"
  ORIGIN_MAIN="$(git rev-parse origin/main)"
  gate_origin_is_target "$ORIGIN_MAIN" "$EXPECT_TARGET_SHA"     # target INMÓVIL
  gate_target_has_merge "$EXPECT_TARGET_SHA" "$EXPECT_MERGE_SHA"

  NGINX_ID_BEFORE="$(docker inspect -f '{{.Id}}' "$NGINX_CTR")" || fail "no se pudo inspeccionar $NGINX_CTR"
  NGINX_STARTED_BEFORE="$(docker inspect -f '{{.State.StartedAt}}' "$NGINX_CTR")" || fail "no se pudo leer StartedAt"
  TREE_STATUS="$(git status --porcelain)"
  gate_single_local_change "$TREE_STATUS"

  gate_conf_has_directives "$CONF_REL"             # hotfix local válido (líneas activas)

  ORIGIN_CONF="$(mktemp)"; trap 'rm -f "$ORIGIN_CONF"' RETURN
  git show "${EXPECT_TARGET_SHA}:${CONF_REL}" > "$ORIGIN_CONF" || fail "no se pudo leer ${EXPECT_TARGET_SHA}:${CONF_REL}"
  gate_conf_has_directives "$ORIGIN_CONF"          # target válido (líneas activas)
  gate_semantic_equal "$CONF_REL" "$ORIGIN_CONF"   # semántica: ambos cumplen el contrato activo

  # 3+5) Backup + checksum + verificación inmediata (ANTES de retirar el cambio local).
  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 700 "$BACKUP_DIR" || fail "no se pudo crear $BACKUP_DIR"
  BACKUP_FILE="${BACKUP_DIR}/nginx.conf.operativo.${ts}"
  BACKUP_SUMS="${BACKUP_FILE}.sha256"
  install -m 600 "$CONF_REL" "$BACKUP_FILE" || fail "no se pudo crear el backup"
  ( cd "$(dirname "$BACKUP_FILE")" && sha256sum "$(basename "$BACKUP_FILE")" > "$BACKUP_SUMS" ) || fail "no se pudo calcular el checksum"
  gate_backup_ok "$BACKUP_FILE" "$BACKUP_SUMS"

  echo "HEAD_BEFORE=$HEAD_BEFORE"
  echo "ORIGIN_MAIN=$ORIGIN_MAIN"
  echo "EXPECT_TARGET_SHA=$EXPECT_TARGET_SHA"
  echo "NGINX_ID_BEFORE=$NGINX_ID_BEFORE"
  echo "NGINX_STARTED_BEFORE=$NGINX_STARTED_BEFORE"
  echo "BACKUP_FILE=$BACKUP_FILE"
  echo "BACKUP_SHA256=$(cut -d' ' -f1 "$BACKUP_SUMS")"

  # 7) MUTACIÓN CONTROLADA (a partir de aquí, el trap revierte ante cualquier fallo).
  echo "== MUTACIÓN CONTROLADA =="
  MUTATED=1
  git checkout -- "$CONF_REL"                       # descarta SÓLO el cambio respaldado
  git merge --ff-only "$ORIGIN_MAIN"                # ff al objeto YA fetch-eado (inmóvil); NO re-fetch
  [ "$(git rev-parse HEAD)" = "$EXPECT_TARGET_SHA" ] || fail "HEAD tras ff != EXPECT_TARGET_SHA"
  [ -z "$(git status --porcelain)" ] || fail "árbol no limpio tras el ff"
  gate_conf_has_directives "$CONF_REL"

  # 8) nginx -t + recarga SÓLO nginx (sin recrear).
  docker compose exec -T "$NGINX_SVC" nginx -t || fail "nginx -t falló tras el ff"
  docker compose exec -T "$NGINX_SVC" nginx -s reload || fail "nginx -s reload falló"

  # Verificación posterior.
  local id_after started_after
  id_after="$(docker inspect -f '{{.Id}}' "$NGINX_CTR")"
  started_after="$(docker inspect -f '{{.State.StartedAt}}' "$NGINX_CTR")"
  [ "$id_after" = "$NGINX_ID_BEFORE" ]           || fail "el contenedor nginx cambió de ID (¿se recreó?)"
  [ "$started_after" = "$NGINX_STARTED_BEFORE" ] || fail "StartedAt de nginx cambió (¿se reinició?)"

  [ "$(http_code "$API_HEALTH_URL")" = "200" ]                  || fail "API no responde 200"
  [ "$(http_code "${SITE_BASE}${HLS_PROBE_PATH}")" = "401" ]    || fail "HLS sin sesión no responde 401"

  local act; act="$(mktemp)"
  docker compose exec -T "$NGINX_SVC" nginx -T > "$act" 2>/dev/null || fail "no se pudo volcar la config activa (nginx -T)"
  validate_wiring "$act" || { rm -f "$act"; fail "la config ACTIVA no tiene el cableado correcto o tiene la variante rota"; }
  rm -f "$act"

  gate_backup_ok "$BACKUP_FILE" "$BACKUP_SUMS"      # backup disponible para rollback
  gate_timer_active "$BACKUP_TIMER_UNIT"            # OBLIGATORIO después

  echo "GO: deploy HLS auth_request OK — HEAD=$EXPECT_TARGET_SHA, nginx recargado (id/StartedAt intactos),"
  echo "    api=200, hls_anon=401, config activa con set/\$hls_original_uri + X-Original-URI \$hls_original_uri + auth_request."
  echo "MERGE=NO DEPLOY=solo-nginx-reload PRODUCTION=modificada-solo-nginx"
}

if [ "${RUNBOOK_LIB:-0}" != "1" ]; then
  main "$@"
fi
