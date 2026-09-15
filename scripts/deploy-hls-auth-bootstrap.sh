#!/usr/bin/env bash
# scripts/deploy-hls-auth-bootstrap.sh
#
# BOOTSTRAP del deploy del fix HLS, EJECUTABLE DESDE EL CHECKOUT PRODUCTIVO ACTUAL
# (p.ej. ed3e0cc) donde los scripts del runbook TODAVÍA NO EXISTEN en el árbol.
#
# Problema que resuelve: `bash scripts/deploy-hls-auth-parent-uri.sh` no puede correr
# antes del fast-forward porque ese archivo (y su guard) recién aparecen en el target.
# Este bootstrap los EXTRAE EXCLUSIVAMENTE del objeto Git INMÓVIL del target aprobado
# (git show), NUNCA por URL/curl/GitHub raw, los valida (sha256 + `bash -n`) ANTES de
# ejecutarlos, y recién entonces corre el deploy desde un directorio privado 700 bajo
# /root. El deploy resuelve su guard adyacente (mismo directorio) sin depender del
# checkout viejo.
#
# NO muta el repo ni recarga nada por sí mismo: sólo prepara y delega en el deploy
# (que sí es fail-closed y hace el ff + reload con rollback por fases).
#
# Variables REQUERIDAS (se propagan al deploy):
#   EXPECT_HEAD EXPECT_TARGET_SHA EXPECT_MERGE_SHA (40 hex)   HLS_PROBE_PATH
# Opcionales:
#   DEPLOY_ROOT=/home/sistemas/Gestion_camaras   EXPECT_BRANCH=main
#   EXPECT_HOST=camaras       (forzado salvo ALLOW_TEST_OVERRIDES=1)
#   PRIVATE_BASE=/root        (base de `mktemp -d`; override sólo con ALLOW_TEST_OVERRIDES=1)
#
# Sourcear con BOOTSTRAP_LIB=1 define funciones SIN ejecutar main().

set -Eeuo pipefail
umask 077
fail() { echo "NO_GO: $*" >&2; exit 1; }
is_sha40() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }

REL_DEPLOY='scripts/deploy-hls-auth-parent-uri.sh'
REL_CHECK='scripts/check-hls-auth-nginx.sh'

main() {
  : "${DEPLOY_ROOT:=/home/sistemas/Gestion_camaras}"
  : "${EXPECT_HEAD:?EXPECT_HEAD requerido (40 hex)}"
  : "${EXPECT_TARGET_SHA:?EXPECT_TARGET_SHA requerido (40 hex)}"
  : "${EXPECT_MERGE_SHA:?EXPECT_MERGE_SHA requerido (40 hex)}"
  : "${HLS_PROBE_PATH:?HLS_PROBE_PATH requerido (/hls/nvr_<id>_ch<NN>_<tipo>/<archivo>)}"

  # Host, rama y base privada: forzados en producción; sólo overrideables en pruebas.
  if [ "${ALLOW_TEST_OVERRIDES:-0}" = "1" ]; then
    : "${EXPECT_HOST:=camaras}"; : "${EXPECT_BRANCH:=main}"; : "${PRIVATE_BASE:=/root}"
  else
    EXPECT_HOST=camaras; EXPECT_BRANCH=main; PRIVATE_BASE=/root
  fi

  echo "== BOOTSTRAP (sin mutar nada; extrae y valida antes de ejecutar) =="
  # 1-4) Validaciones básicas SIN tocar nada.
  is_sha40 "$EXPECT_HEAD"       || fail "EXPECT_HEAD no es un SHA de 40 hex"
  is_sha40 "$EXPECT_TARGET_SHA" || fail "EXPECT_TARGET_SHA no es un SHA de 40 hex"
  is_sha40 "$EXPECT_MERGE_SHA"  || fail "EXPECT_MERGE_SHA no es un SHA de 40 hex"
  [ "$(hostname)" = "$EXPECT_HOST" ] || fail "hostname '$(hostname)' != '$EXPECT_HOST'"

  cd "$DEPLOY_ROOT" || fail "no se puede entrar a $DEPLOY_ROOT"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$EXPECT_BRANCH" ] || fail "rama != $EXPECT_BRANCH"
  [ "$(git rev-parse HEAD)" = "$EXPECT_HEAD" ] || fail "HEAD productivo != EXPECT_HEAD"

  # 5-7) Inmovilizar el target ANTES de extraer/ejecutar código.
  git fetch origin main --quiet || fail "git fetch origin main falló"
  local origin_main; origin_main="$(git rev-parse origin/main)"
  [ "$origin_main" = "$EXPECT_TARGET_SHA" ] \
    || fail "origin/main ($origin_main) != EXPECT_TARGET_SHA (target no inmovilizado / carrera)"
  git merge-base --is-ancestor "$EXPECT_MERGE_SHA" "$EXPECT_TARGET_SHA" \
    || fail "EXPECT_TARGET_SHA no contiene el merge aprobado ($EXPECT_MERGE_SHA)"

  # 8) Directorio privado (700) bajo /root, con evidencia para auditoría.
  [ -d "$PRIVATE_BASE" ] || fail "PRIVATE_BASE no existe: $PRIVATE_BASE"
  local priv; priv="$(mktemp -d "${PRIVATE_BASE%/}/hls-deploy.XXXXXX")" || fail "no se pudo crear el directorio privado"
  chmod 700 "$priv"
  local evid="$priv/EVIDENCE.txt"
  {
    echo "bootstrap_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "DEPLOY_ROOT=$DEPLOY_ROOT"
    echo "EXPECT_HEAD=$EXPECT_HEAD"
    echo "EXPECT_TARGET_SHA=$EXPECT_TARGET_SHA"
    echo "EXPECT_MERGE_SHA=$EXPECT_MERGE_SHA"
    echo "origin_main=$origin_main"
  } > "$evid"

  # 9-11) Extraer del objeto INMÓVIL + registrar sha256. NUNCA por URL/curl/raw.
  extract_from_target "$REL_DEPLOY" "$priv/deploy-hls-auth-parent-uri.sh"
  extract_from_target "$REL_CHECK"  "$priv/check-hls-auth-nginx.sh"
  chmod 700 "$priv"/*.sh
  echo "-- sha256 de los scripts extraídos --" >> "$evid"
  ( cd "$priv" && sha256sum deploy-hls-auth-parent-uri.sh check-hls-auth-nginx.sh | tee -a "$evid" )

  # 12) `bash -n` ANTES de ejecutar (15: no se ejecuta código sin validar procedencia+sintaxis).
  bash -n "$priv/deploy-hls-auth-parent-uri.sh" || fail "bash -n falló en el deploy extraído"
  bash -n "$priv/check-hls-auth-nginx.sh"       || fail "bash -n falló en el guard extraído"

  echo "BOOTSTRAP_OK priv=$priv (evidencia: $evid)"
  echo "== delegando en el deploy extraído (guard adyacente, mismo directorio privado) =="

  # 13) Ejecutar el deploy DESDE el directorio privado. CHECK_SCRIPT explícito (redundante
  #     con SELF_DIR, pero deja claro que el guard usado es el adyacente extraído).
  CHECK_SCRIPT="$priv/check-hls-auth-nginx.sh" \
    bash "$priv/deploy-hls-auth-parent-uri.sh"
}

# 9) Extrae un archivo del objeto Git EXACTO del target. Falla si no existe en ese SHA.
extract_from_target() {  # $1 = ruta en el repo, $2 = destino
  git cat-file -e "${EXPECT_TARGET_SHA}:$1" 2>/dev/null \
    || fail "el objeto ${EXPECT_TARGET_SHA}:$1 no existe (target incorrecto o script ausente)"
  git show "${EXPECT_TARGET_SHA}:$1" > "$2" || fail "no se pudo extraer $1 del target"
  [ -s "$2" ] || fail "el archivo extraído $2 quedó vacío"
}

if [ "${BOOTSTRAP_LIB:-0}" != "1" ]; then
  main "$@"
fi
