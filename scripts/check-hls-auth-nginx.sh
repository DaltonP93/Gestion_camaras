#!/usr/bin/env bash
# scripts/check-hls-auth-nginx.sh
# Guard de CI del cableado de auth_request del HLS (incidente resuelto).
#
# Incidente: en /internal/hls-auth se enviaba `X-Original-URI $uri`. Durante
# auth_request, `$uri` es la URI del SUBREQUEST (`/internal/hls-auth`), NO la del
# request HLS padre. El API recibía una ruta inválida → BAD_PATH/403 y MediaMTX
# cerraba los streams on-demand por falta de lectores.
#
# Fix permanente (validado en prod): capturar en /hls/ el `$uri` PADRE en la
# variable `$hls_original_uri` ANTES de `auth_request`, y enviar esa variable en el
# subrequest. Este guard fija ese contrato (no se puede correr nginx en CI):
#   1. /hls/ setea `set $hls_original_uri $uri;` ANTES de `auth_request`.
#   2. /internal/hls-auth envía `X-Original-URI $hls_original_uri;`.
#   3. NO se usa `$uri` ni `$request_uri` como X-Original-URI en el bloque interno.
#   4. NO hay `set $hls_original_uri` a nivel server (se re-ejecutaría en el
#      subrequest y borraría el valor capturado — las subrequests comparten variables).
#   5. auth_request sigue activo (no comentado/eliminado).
#   6. /internal/hls-auth es `internal;` y MediaMTX no queda expuesto por nginx.
#
# Uso: scripts/check-hls-auth-nginx.sh   (desde la raíz del repo). Sale ≠0 si falla.
set -uo pipefail

CONF="infra/nginx/nginx.conf"
fail=0
err() { echo "  ❌ $1"; fail=1; }
ok()  { echo "  ✅ $1"; }

echo "== Guard de auth_request HLS (X-Original-URI = URI del request padre)"

# Extrae el bloque de una location por su encabezado hasta su cierre `}` de 1er nivel.
block() { # $1 = patrón de encabezado (regex ERE)
  awk -v pat="$1" '
    $0 ~ pat && /\{/ { depth=1; print; next }
    depth>0 {
      print
      n=gsub(/\{/,"{"); m=gsub(/\}/,"}"); depth+=n-m
      if (depth<=0) exit
    }' "$CONF"
}

HLS="$(block 'location[[:space:]]+/hls/')"
INT="$(block 'location[[:space:]]*=[[:space:]]*/internal/hls-auth')"

[ -n "$HLS" ] || err "no encontré el bloque location /hls/"
[ -n "$INT" ] || err "no encontré el bloque location = /internal/hls-auth"

# 1) /hls/ captura la URI del padre en $hls_original_uri.
printf '%s\n' "$HLS" | grep -Eq '^[[:space:]]*set[[:space:]]+\$hls_original_uri[[:space:]]+\$uri;' \
  && ok "/hls/ captura: set \$hls_original_uri \$uri;" \
  || err "/hls/ debe contener 'set \$hls_original_uri \$uri;' (captura del padre)"

# 1b) …y lo hace ANTES de auth_request (orden importa: rewrite antes que access).
set_line=$(printf '%s\n' "$HLS" | grep -nE '^[[:space:]]*set[[:space:]]+\$hls_original_uri' | head -1 | cut -d: -f1)
auth_line=$(printf '%s\n' "$HLS" | grep -nE '^[[:space:]]*auth_request[[:space:]]+/internal/hls-auth;' | head -1 | cut -d: -f1)
if [ -n "$set_line" ] && [ -n "$auth_line" ] && [ "$set_line" -lt "$auth_line" ]; then
  ok "/hls/: el set precede a auth_request"
else
  err "/hls/: 'set \$hls_original_uri' debe ir ANTES de 'auth_request'"
fi

# 2) auth_request sigue activo en /hls/ (no desactivado).
[ -n "$auth_line" ] && ok "/hls/: auth_request /internal/hls-auth; activo" \
  || err "/hls/: falta 'auth_request /internal/hls-auth;' (no desactivar)"

# 3) /internal/hls-auth envía la variable capturada, NO \$uri ni \$request_uri.
printf '%s\n' "$INT" | grep -Eq '^[[:space:]]*proxy_set_header[[:space:]]+X-Original-URI[[:space:]]+\$hls_original_uri;' \
  && ok "/internal/hls-auth: X-Original-URI \$hls_original_uri" \
  || err "/internal/hls-auth debe enviar 'proxy_set_header X-Original-URI \$hls_original_uri;'"
if printf '%s\n' "$INT" | grep -Eq 'X-Original-URI[[:space:]]+\$uri;'; then
  err "/internal/hls-auth usa \$uri (URI del subrequest) — reintroduce el incidente"
else ok "/internal/hls-auth: no usa \$uri"; fi
if printf '%s\n' "$INT" | grep -Eq 'X-Original-URI[[:space:]]+\$request_uri'; then
  err "/internal/hls-auth usa \$request_uri (crudo) — rompe la normalización anti-traversal"
else ok "/internal/hls-auth: no usa \$request_uri"; fi

# 4) NO debe existir 'set $hls_original_uri' a nivel server (fuera de /hls/).
# Cuenta total de asignaciones vs. las que están dentro de /hls/: deben coincidir (todas dentro).
total_set=$(grep -cE '^[[:space:]]*set[[:space:]]+\$hls_original_uri' "$CONF")
hls_set=$(printf '%s\n' "$HLS" | grep -cE '^[[:space:]]*set[[:space:]]+\$hls_original_uri')
if [ "$total_set" = "$hls_set" ] && [ "$total_set" = "1" ]; then
  ok "sin 'set \$hls_original_uri' fuera de /hls/ (evita clobber en el subrequest)"
else
  err "hay 'set \$hls_original_uri' fuera de /hls/ (total=$total_set, en /hls/=$hls_set): se re-ejecutaría en el subrequest y borraría el valor"
fi

# 5) /internal/hls-auth es internal; y MediaMTX no se expone por nginx.
printf '%s\n' "$INT" | grep -Eq '^[[:space:]]*internal;' \
  && ok "/internal/hls-auth: internal; (no accesible desde afuera)" \
  || err "/internal/hls-auth debe ser 'internal;'"
if grep -Eq '^[[:space:]]*listen[[:space:]]+.*(8888|8889)' "$CONF"; then
  err "nginx expone un puerto de MediaMTX (8888/8889) con listen — MediaMTX debe quedar interno"
else ok "nginx no expone puertos de MediaMTX (listen)"; fi
printf '%s\n' "$HLS" | grep -Eq 'proxy_pass[[:space:]]+http://mediamtx_hls/;' \
  && ok "/hls/ proxya al upstream interno mediamtx_hls" \
  || err "/hls/ debe proxyar a http://mediamtx_hls/ (upstream interno)"

echo ""
if [ "$fail" -ne 0 ]; then
  echo "❌ Cableado de auth_request HLS inconsistente. No reintroducir el incidente."
  exit 1
fi
echo "✅ auth_request HLS correcto: el API recibe la URI del request padre, fail-closed y MediaMTX aislado."
