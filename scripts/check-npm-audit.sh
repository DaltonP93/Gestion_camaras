#!/usr/bin/env bash
# scripts/check-npm-audit.sh
# Política de auditoría de dependencias para CI — FAIL-CLOSED.
#
# Corre `npm audit --omit=dev` (SOLO dependencias de PRODUCCIÓN; las devDeps NO
# bloquean) en las apps Node y FALLA (exit != 0) ante:
#   - directorio de app inexistente o sin package.json;
#   - `npm` o `python3` ausentes;
#   - error de red/registry (npm devuelve un objeto {"error":...});
#   - salida vacía de npm audit;
#   - JSON inválido o schema inesperado (sin clave "vulnerabilities");
#   - HIGH/CRITICAL de producción en un paquete FUERA del allowlist.
#
# Nada de lo anterior se ignora ("|| true" + continue era fail-open y ocultaba
# riesgo). La clasificación del JSON vive en scripts/audit_classify.py (pura,
# testeable). Pruebas negativas: scripts/check-npm-audit.test.sh.
#
# ALLOWLIST — deuda conocida TEMPORAL, NO política definitiva. Por defecto
# `axios form-data` (HIGH transitivos de apps/web que remedia el PR #172). Estas
# entradas deben corresponder SIEMPRE a una remediación en curso; al fusionarse
# #172 el allowlist debe vaciarse. Overridable con la env `AUDIT_ALLOWLIST` (no
# se amplía a la ligera). Un paquete prod NUEVO con HIGH/CRITICAL fuera del
# allowlist rompe CI.
#
# Uso: scripts/check-npm-audit.sh [app_dir ...]   (default: apps/api apps/web)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY="$HERE/audit_classify.py"

APPS=("$@")
[ "${#APPS[@]}" -gt 0 ] || APPS=(apps/api apps/web)

export ALLOWLIST="${AUDIT_ALLOWLIST:-axios form-data}"

fail() { echo "❌ $*" >&2; }

# ── Precondiciones de entorno (fail-closed) ───────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  fail "npm no está disponible en PATH — no se puede auditar (fail-closed)."
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 no está disponible — el clasificador de audit lo requiere (fail-closed)."
  exit 2
fi
if [ ! -f "$CLASSIFY" ]; then
  fail "no se encontró $CLASSIFY (fail-closed)."
  exit 2
fi

overall=0
for app in "${APPS[@]}"; do
  echo "== $app"
  if [ ! -d "$app" ]; then
    fail "directorio de app inexistente: $app"
    overall=1
    continue
  fi
  if [ ! -f "$app/package.json" ]; then
    fail "no hay package.json en $app"
    overall=1
    continue
  fi

  # npm audit sale con rc!=0 CUANDO ENCUENTRA vulns (normal), así que el rc por sí
  # solo NO distingue "encontró vulns" de "error de red". Capturamos la salida y
  # dejamos que el clasificador decida (detecta el objeto {"error":...}).
  out="$(cd "$app" && npm audit --omit=dev --json 2>/dev/null)"
  if [ -z "$out" ]; then
    fail "$app: npm audit no produjo salida (posible npm roto / sin package-lock) — fail-closed."
    overall=1
    continue
  fi

  cls="$(printf '%s' "$out" | python3 "$CLASSIFY")"
  crc=$?

  printf '%s\n' "$cls" | grep '^KNOWN' | while read -r _ sev pkg; do
    echo "   • (allowlist/deuda temporal, remediar) $sev en $pkg — no bloquea"
  done
  printf '%s\n' "$cls" | grep '^BLOCK' | while read -r _ sev pkg; do
    echo "   ❌ $sev en $pkg (dependencia de PRODUCCIÓN, fuera del allowlist)"
  done

  case "$crc" in
    0) echo "   ✅ sin HIGH/CRITICAL prod fuera del allowlist" ;;
    1) overall=1 ;;  # bloqueante (ya listado arriba)
    3) fail "$app: npm audit vacío/JSON inválido ($(printf '%s' "$cls" | grep '^ERROR' | head -1)) — fail-closed."; overall=1 ;;
    4) fail "$app: npm audit devolvió ERROR de red/registry ($(printf '%s' "$cls" | grep '^ERROR' | head -1)) — fail-closed."; overall=1 ;;
    5) fail "$app: schema de npm audit inesperado ($(printf '%s' "$cls" | grep '^ERROR' | head -1)) — fail-closed."; overall=1 ;;
    *) fail "$app: clasificador devolvió código inesperado $crc — fail-closed."; overall=1 ;;
  esac
done

if [ "$overall" -ne 0 ]; then
  echo ""
  fail "Auditoría de producción FALLÓ (HIGH/CRITICAL nuevos, o condición no evaluable)."
  echo "   Política: dev-only no bloquea; low/moderate no bloquean; allowlist TEMPORAL (${ALLOWLIST})."
  exit 1
fi
echo "✅ Política de audit de producción OK (allowlist temporal: ${ALLOWLIST})"
