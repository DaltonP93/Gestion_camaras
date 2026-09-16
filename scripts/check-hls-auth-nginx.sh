#!/usr/bin/env bash
# scripts/check-hls-auth-nginx.sh [<archivo_nginx.conf>]
#
# Guard del cableado de auth_request del HLS (incidente resuelto). Valida SÓLO
# DIRECTIVAS ACTIVAS (ignora comentarios y números de línea): se puede correr sobre
# la nginx.conf del repo, un backup, la config extraída de origin/main o la config
# ACTIVA volcada por `nginx -T`.
#
# Incidente: `X-Original-URI $uri` en /internal/hls-auth pasaba la URI del subrequest
# (`/internal/hls-auth`) → el API respondía BAD_PATH/403. Fix: capturar en /hls/ el
# `$uri` PADRE en `$hls_original_uri` (set antes de auth_request) y enviar esa variable.
#
# Contrato exigido (sobre líneas ACTIVAS):
#   - exactamente 1 `set $hls_original_uri $uri;`  y está dentro de /hls/
#   - exactamente 1 `proxy_set_header X-Original-URI $hls_original_uri;` en /internal/hls-auth
#   - `set` precede a `auth_request` dentro de /hls/
#   - >=1 `auth_request /internal/hls-auth;` en /hls/ (no desactivado)
#   - 0 `proxy_set_header X-Original-URI $uri;` (variante rota) activas
#   - /internal/hls-auth es `internal;`
#   - nginx no expone puertos de MediaMTX (listen 8888/8889) y /hls/ usa mediamtx_hls
#   - NO hay `set $hls_original_uri` fuera de /hls/ (evita clobber en el subrequest)
#
# Sale != 0 ante cualquier violación.
set -uo pipefail

CONF="${1:-infra/nginx/nginx.conf}"
[ -f "$CONF" ] || { echo "  ❌ no existe el archivo: $CONF"; exit 1; }

# Vista ACTIVA: quita comentarios (todo desde el primer '#' de cada línea). La config
# de este proyecto no usa '#' dentro de valores/strings, así que es seguro.
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

echo "== Guard auth_request HLS (líneas activas) — archivo: $CONF"

HLS="$(block 'location[[:space:]]+/hls/')"
INT="$(block 'location[[:space:]]*=[[:space:]]*/internal/hls-auth')"
[ -n "$HLS" ] || err "no se encontró el bloque location /hls/"
[ -n "$INT" ] || err "no se encontró el bloque location = /internal/hls-auth"

# Conteos ACTIVOS globales.
n_set=$(grep -cE '^[[:space:]]*set[[:space:]]+\$hls_original_uri[[:space:]]+\$uri;[[:space:]]*$' "$ACT" || true)
n_hdr=$(grep -cE '^[[:space:]]*proxy_set_header[[:space:]]+X-Original-URI[[:space:]]+\$hls_original_uri;[[:space:]]*$' "$ACT" || true)
n_bad=$(grep -cE '^[[:space:]]*proxy_set_header[[:space:]]+X-Original-URI[[:space:]]+\$uri;[[:space:]]*$' "$ACT" || true)
n_auth=$(grep -cE '^[[:space:]]*auth_request[[:space:]]+/internal/hls-auth;[[:space:]]*$' "$ACT" || true)

[ "$n_set" = "1" ] && ok "exactamente 1 'set \$hls_original_uri \$uri;' activo" \
  || err "se esperaba EXACTAMENTE 1 'set \$hls_original_uri \$uri;' activo (hay $n_set)"
[ "$n_hdr" = "1" ] && ok "exactamente 1 'X-Original-URI \$hls_original_uri;' activo" \
  || err "se esperaba EXACTAMENTE 1 'X-Original-URI \$hls_original_uri;' activo (hay $n_hdr)"
[ "$n_bad" = "0" ] && ok "0 'X-Original-URI \$uri;' activos (variante rota ausente)" \
  || err "hay $n_bad 'X-Original-URI \$uri;' activos (variante rota)"
[ "$n_auth" -ge 1 ] && ok "auth_request activo ($n_auth)" \
  || err "falta 'auth_request /internal/hls-auth;' activo (no desactivar)"

# Membresía por location (sobre líneas activas del bloque).
printf '%s\n' "$HLS" | grep -qE '^[[:space:]]*set[[:space:]]+\$hls_original_uri[[:space:]]+\$uri;' \
  && ok "/hls/: contiene el set del padre" || err "/hls/: falta 'set \$hls_original_uri \$uri;'"
printf '%s\n' "$HLS" | grep -qE '^[[:space:]]*auth_request[[:space:]]+/internal/hls-auth;' \
  && ok "/hls/: contiene auth_request" || err "/hls/: falta auth_request"
printf '%s\n' "$INT" | grep -qE '^[[:space:]]*proxy_set_header[[:space:]]+X-Original-URI[[:space:]]+\$hls_original_uri;' \
  && ok "/internal/hls-auth: envía \$hls_original_uri" || err "/internal/hls-auth: falta 'X-Original-URI \$hls_original_uri;'"

# Orden: el set precede a auth_request dentro de /hls/.
sl=$(printf '%s\n' "$HLS" | grep -nE '^[[:space:]]*set[[:space:]]+\$hls_original_uri' | head -1 | cut -d: -f1)
al=$(printf '%s\n' "$HLS" | grep -nE '^[[:space:]]*auth_request[[:space:]]+/internal/hls-auth;' | head -1 | cut -d: -f1)
if [ -n "$sl" ] && [ -n "$al" ] && [ "$sl" -lt "$al" ]; then ok "/hls/: set precede a auth_request"
else err "/hls/: 'set \$hls_original_uri' debe ir ANTES de auth_request"; fi

# No 'set $hls_original_uri' fuera de /hls/ (se re-ejecutaría en el subrequest).
total_set=$(grep -cE '^[[:space:]]*set[[:space:]]+\$hls_original_uri' "$ACT" || true)
hls_set=$(printf '%s\n' "$HLS" | grep -cE '^[[:space:]]*set[[:space:]]+\$hls_original_uri' || true)
[ "$total_set" = "$hls_set" ] && [ "$total_set" = "1" ] \
  && ok "sin 'set \$hls_original_uri' fuera de /hls/" \
  || err "'set \$hls_original_uri' fuera de /hls/ (total=$total_set, en /hls/=$hls_set)"

# /internal/hls-auth interno + MediaMTX no expuesto por nginx.
printf '%s\n' "$INT" | grep -qE '^[[:space:]]*internal;' \
  && ok "/internal/hls-auth: internal;" || err "/internal/hls-auth debe ser 'internal;'"
if grep -qE '^[[:space:]]*listen[[:space:]]+.*(8888|8889)' "$ACT"; then
  err "nginx expone un puerto de MediaMTX (8888/8889)"
else ok "nginx no expone puertos de MediaMTX"; fi
printf '%s\n' "$HLS" | grep -qE 'proxy_pass[[:space:]]+http://mediamtx_hls/;' \
  && ok "/hls/ proxya al upstream interno mediamtx_hls" || err "/hls/ debe proxyar a http://mediamtx_hls/"

echo ""
if [ "$fail" -ne 0 ]; then
  echo "❌ Cableado auth_request HLS inconsistente en $CONF."
  exit 1
fi
echo "✅ Cableado auth_request HLS correcto en $CONF (líneas activas)."
