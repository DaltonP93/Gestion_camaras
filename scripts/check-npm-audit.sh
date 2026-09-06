#!/usr/bin/env bash
# scripts/check-npm-audit.sh
# Política de auditoría de dependencias para CI.
#
# Corre `npm audit --omit=dev` (SOLO dependencias de PRODUCCIÓN; las devDeps NO
# bloquean) en las apps Node y FALLA únicamente ante vulnerabilidades HIGH o
# CRITICAL en un paquete que NO esté en el allowlist de deuda conocida.
#
# El allowlist es por NOMBRE DE PAQUETE (no por GHSA, que rota con cada nuevo
# advisory). Un paquete de producción NUEVO con HIGH/CRITICAL, fuera del
# allowlist, rompe CI. Los paquetes allowlisteados son deuda técnica a remediar
# (ver docs/audits/AUDIT_DEVOPS.md), no una vía para ignorar riesgo nuevo.
#
# Uso: scripts/check-npm-audit.sh [app_dir ...]   (default: apps/api apps/web)
set -uo pipefail

APPS=("$@")
[ "${#APPS[@]}" -gt 0 ] || APPS=(apps/api apps/web)

# ── Allowlist de deuda conocida (prod HIGH/CRITICAL pre-existentes) ────────────
# Detectados el 2026-09-06 en apps/web (transitivos). Remediar con actualización
# planificada; mientras tanto no bloquean CI, pero cualquier OTRO paquete sí.
ALLOWLIST="axios form-data"

is_allowed() {
  local pkg="$1"
  for a in $ALLOWLIST; do [ "$pkg" = "$a" ] && return 0; done
  return 1
}

overall=0
for app in "${APPS[@]}"; do
  echo "== $app"
  json="$(cd "$app" && npm audit --omit=dev --json 2>/dev/null || true)"
  [ -n "$json" ] || { echo "   WARN: npm audit no devolvió JSON en $app (¿sin package-lock?)"; continue; }

  result="$(printf '%s' "$json" | ALLOWLIST="$ALLOWLIST" python3 -c '
import json, os, sys
allow = set(os.environ.get("ALLOWLIST", "").split())
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("PARSE_ERROR " + str(e)); sys.exit(0)
vulns = d.get("vulnerabilities", {})
blocking, known = [], []
for name, v in vulns.items():
    if v.get("severity") in ("high", "critical"):
        (known if name in allow else blocking).append((name, v.get("severity")))
for name, sev in sorted(set(known)):
    print("KNOWN %s %s" % (sev, name))
for name, sev in sorted(set(blocking)):
    print("BLOCK %s %s" % (sev, name))
')"

  if printf '%s\n' "$result" | grep -q '^PARSE_ERROR'; then
    echo "   WARN: no se pudo parsear npm audit --json ($(printf '%s' "$result"))"
    continue
  fi
  printf '%s\n' "$result" | grep '^KNOWN' | while read -r _ sev pkg; do
    echo "   • (allowlist/deuda) $sev en $pkg — no bloquea, remediar"
  done
  blk="$(printf '%s\n' "$result" | grep '^BLOCK' || true)"
  if [ -n "$blk" ]; then
    overall=1
    printf '%s\n' "$blk" | while read -r _ sev pkg; do
      echo "   ❌ $sev en $pkg (dependencia de PRODUCCIÓN, fuera del allowlist)"
    done
  else
    echo "   ✅ sin HIGH/CRITICAL prod fuera del allowlist"
  fi
done

if [ "$overall" -ne 0 ]; then
  echo ""
  echo "❌ Vulnerabilidades HIGH/CRITICAL nuevas en dependencias de PRODUCCIÓN."
  echo "   Política: dev-only no bloquea; low/moderate no bloquean; allowlist en este script."
  exit 1
fi
echo "✅ Política de audit de producción OK (allowlist: ${ALLOWLIST})"
