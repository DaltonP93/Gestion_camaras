#!/usr/bin/env bash
# scripts/check-uploads-nginx.sh [<archivo_nginx.conf>]
#
# Guard de las cabeceras de seguridad de `location /uploads/` (defensa en
# profundidad anti-XSS almacenado de branding). Valida SÓLO DIRECTIVAS ACTIVAS
# (ignora comentarios): se puede correr sobre la nginx.conf del repo, un backup
# o la config ACTIVA volcada por `nginx -T`.
#
# Por qué: en nginx, si un `location` declara CUALQUIER `add_header`, NO hereda
# los `add_header` del nivel `server`. /uploads/ ya declara `Cache-Control`, así
# que nosniff/XFO/HSTS deben RE-DECLARARSE ahí, junto con una CSP sandbox que
# neutraliza la ejecución de un asset legado aunque llegara a servirse.
#
# Contrato exigido dentro de `location /uploads/` (líneas activas, con `always`):
#   - add_header X-Content-Type-Options nosniff
#   - add_header X-Frame-Options SAMEORIGIN
#   - add_header Strict-Transport-Security "..."
#   - add_header Content-Security-Policy "..." con `sandbox`, `default-src 'none'`
#     y `frame-ancestors 'self'`, y SIN `allow-scripts`
#
# Sale != 0 ante cualquier violación.
set -uo pipefail

CONF="${1:-infra/nginx/nginx.conf}"
[ -f "$CONF" ] || { echo "  ❌ no existe el archivo: $CONF"; exit 1; }

# Vista ACTIVA: quita comentarios (todo desde el primer '#' de cada línea). La
# config de este proyecto no usa '#' dentro de valores/strings.
ACT="$(mktemp)"; trap 'rm -f "$ACT"' EXIT
sed -E 's/[[:space:]]*#.*$//' "$CONF" > "$ACT"

fail=0
err() { echo "  ❌ $1"; fail=1; }
ok()  { echo "  ✅ $1"; }

# Extrae el cuerpo de una location por su encabezado hasta el cierre de 1er nivel.
block() {
  awk -v pat="$1" '
    $0 ~ pat && /\{/ { depth=1; print; next }
    depth>0 {
      print
      n=gsub(/\{/,"{"); m=gsub(/\}/,"}"); depth+=n-m
      if (depth<=0) exit
    }' "$ACT"
}

echo "== Guard cabeceras de /uploads/ (líneas activas) — archivo: $CONF"

UPL="$(block 'location[[:space:]]+/uploads/')"
if [ -z "$UPL" ]; then
  err "no se encontró el bloque location /uploads/"
  echo ""; echo "❌ Cabeceras de /uploads/ inconsistentes en $CONF."; exit 1
fi

has() { printf '%s\n' "$UPL" | grep -qE "$1"; }

has '^[[:space:]]*add_header[[:space:]]+X-Content-Type-Options[[:space:]]+"?nosniff"?[[:space:]]+always;' \
  && ok "/uploads/: X-Content-Type-Options nosniff" || err "/uploads/: falta 'add_header X-Content-Type-Options nosniff always;'"
has '^[[:space:]]*add_header[[:space:]]+X-Frame-Options[[:space:]]+"?SAMEORIGIN"?[[:space:]]+always;' \
  && ok "/uploads/: X-Frame-Options SAMEORIGIN" || err "/uploads/: falta 'add_header X-Frame-Options SAMEORIGIN always;'"
has '^[[:space:]]*add_header[[:space:]]+Strict-Transport-Security[[:space:]]+"[^"]+"[[:space:]]+always;' \
  && ok "/uploads/: Strict-Transport-Security" || err "/uploads/: falta 'add_header Strict-Transport-Security \"...\" always;'"

csp_lines="$(printf '%s\n' "$UPL" | grep -E '^[[:space:]]*add_header[[:space:]]+Content-Security-Policy[[:space:]]+"[^"]+"[[:space:]]+always;' || true)"
n_csp=$(printf '%s' "$csp_lines" | grep -c . || true)
if [ "$n_csp" = "1" ]; then
  csp="$(printf '%s\n' "$csp_lines" | sed -E 's/^[^"]*"([^"]*)".*$/\1/')"
  ok "/uploads/: 1 Content-Security-Policy activa"
  # Directivas separadas por ';' (sin espacios sobrantes) para comparar exacto.
  dirs="$(printf '%s' "$csp" | tr ';' '\n' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  printf '%s\n' "$dirs" | grep -qxE "sandbox" \
    && ok "CSP: sandbox" || err "CSP de /uploads/ sin directiva 'sandbox' (valor: $csp)"
  printf '%s\n' "$dirs" | grep -qxF "default-src 'none'" \
    && ok "CSP: default-src 'none'" || err "CSP de /uploads/ sin \"default-src 'none'\" (valor: $csp)"
  printf '%s\n' "$dirs" | grep -qxF "frame-ancestors 'self'" \
    && ok "CSP: frame-ancestors 'self'" || err "CSP de /uploads/ sin \"frame-ancestors 'self'\" (valor: $csp)"
  if printf '%s' "$csp" | grep -q 'allow-scripts'; then
    err "CSP de /uploads/ habilita scripts en el sandbox (allow-scripts)"
  else ok "CSP: sandbox sin allow-scripts"; fi
else
  err "/uploads/: se esperaba EXACTAMENTE 1 'add_header Content-Security-Policy \"...\" always;' activa (hay $n_csp)"
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "❌ Cabeceras de /uploads/ inconsistentes en $CONF."
  exit 1
fi
echo "✅ Cabeceras de /uploads/ correctas en $CONF (líneas activas)."
