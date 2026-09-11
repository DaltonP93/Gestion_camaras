#!/usr/bin/env bash
# scripts/check-cert-lineage.sh
# Guard de CI: el certificado TLS de producción debe usar SIEMPRE el linaje canónico
# `camaras-le`, de forma consistente en nginx, los scripts de certbot y el compose.
#
# Contexto (incidente resuelto): el linaje viejo homónimo del dominio
# `camaras.saa.com.py` contenía un cert de CA privada y su renewal config quedó
# inválida. nginx debe servir `/etc/letsencrypt/live/camaras-le/...`, init-ssl.sh
# debe EMITIR con `--cert-name camaras-le` (y sin heredar el loop de `renew`), y el
# contenedor certbot debe RENOVAR sólo ese linaje. Este guard falla si alguien
# reintroduce la ruta vieja o rompe la consistencia del nombre de linaje.
#
# También impide comitear certificados/llaves reales al repo.
#
# Uso: scripts/check-cert-lineage.sh   (desde la raíz del repo)
# Sale ≠0 ante cualquier inconsistencia.
set -uo pipefail

CERT_NAME="camaras-le"
OLD_LINEAGE="camaras.saa.com.py"           # linaje viejo inválido (como PATH de cert)
NGINX_CONF="infra/nginx/nginx.conf"
INIT_SSL="infra/certbot/init-ssl.sh"
UPGRADE="infra/certbot/upgrade-to-https.sh"
COMPOSE="docker-compose.yml"

fail=0
err() { echo "  ❌ $1"; fail=1; }
ok()  { echo "  ✅ $1"; }

echo "== Guard de linaje de certificado (canónico: ${CERT_NAME})"

# ── 1) nginx: EXACTAMENTE una ssl_certificate y una ssl_certificate_key, ambas
#        bajo live/camaras-le, y ninguna directiva de cert al linaje viejo. ──
# Sólo directivas efectivas (ignora comentarios `#`).
eff() { grep -E "^[[:space:]]*$1[[:space:]]" "$NGINX_CONF" | grep -v '^[[:space:]]*#'; }

n_fullchain=$(eff 'ssl_certificate'     | grep -c "/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem;" || true)
n_privkey=$(  eff 'ssl_certificate_key' | grep -c "/etc/letsencrypt/live/${CERT_NAME}/privkey.pem;"   || true)
n_cert_total=$(eff 'ssl_certificate'     | wc -l | tr -d ' ')
n_key_total=$( eff 'ssl_certificate_key' | wc -l | tr -d ' ')

[ "$n_fullchain" = "1" ] && ok "nginx: exactamente 1 ssl_certificate → live/${CERT_NAME}/fullchain.pem" \
  || err "nginx: se esperaba EXACTAMENTE 1 ssl_certificate a live/${CERT_NAME}/fullchain.pem (hay ${n_fullchain})"
[ "$n_privkey" = "1" ] && ok "nginx: exactamente 1 ssl_certificate_key → live/${CERT_NAME}/privkey.pem" \
  || err "nginx: se esperaba EXACTAMENTE 1 ssl_certificate_key a live/${CERT_NAME}/privkey.pem (hay ${n_privkey})"
# Toda directiva ssl_certificate(_key) debe apuntar al linaje canónico (no más, no otras rutas).
[ "$n_cert_total" = "1" ] && ok "nginx: no hay ssl_certificate extra fuera del linaje canónico" \
  || err "nginx: hay ${n_cert_total} directivas ssl_certificate (se esperaba 1) — ¿otra ruta de cert?"
[ "$n_key_total" = "1" ] && ok "nginx: no hay ssl_certificate_key extra fuera del linaje canónico" \
  || err "nginx: hay ${n_key_total} directivas ssl_certificate_key (se esperaba 1)"
if eff 'ssl_certificate'     | grep -q "/etc/letsencrypt/live/${OLD_LINEAGE}/" \
 || eff 'ssl_certificate_key' | grep -q "/etc/letsencrypt/live/${OLD_LINEAGE}/"; then
  err "nginx: hay una directiva de cert apuntando al linaje viejo live/${OLD_LINEAGE}/"
else
  ok "nginx: sin directivas de cert al linaje viejo"
fi

# ── 2) init-ssl.sh: CERT_NAME canónico + emisión que (a) fija --cert-name y
#        (b) NO hereda el loop de renew (usa el binario certbot como entrypoint). ──
grep -Eq "^CERT_NAME=\"${CERT_NAME}\"" "$INIT_SSL" \
  && ok "${INIT_SSL}: CERT_NAME=${CERT_NAME}" \
  || err "${INIT_SSL}: falta CERT_NAME=\"${CERT_NAME}\""

# El helper de emisión debe correr el BINARIO certbot (entrypoint explícito), no el
# entrypoint por defecto del servicio (que es el loop `certbot renew …`).
grep -Eq 'docker compose run --rm --entrypoint certbot certbot' "$INIT_SSL" \
  && ok "${INIT_SSL}: la emisión usa --entrypoint certbot (no hereda el loop de renew)" \
  || err "${INIT_SSL}: la emisión debe usar 'docker compose run --rm --entrypoint certbot certbot' (si no, certonly no se ejecuta)"

# El COMANDO EJECUTABLE de emisión (línea lógica de certonly, uniendo continuaciones
# con '\') debe contener realmente --cert-name. Así un `certonly` sin --cert-name
# (que crearía el linaje con el nombre del dominio) rompe CI.
issue_cmd="$(awk '
  /certonly/ { collecting=1 }
  collecting {
    line=$0; sub(/[[:space:]]*#.*/,"",line); gsub(/\\[[:space:]]*$/,"",line);
    printf "%s ", line;
    if ($0 !~ /\\[[:space:]]*$/) { collecting=0; print "" }
  }' "$INIT_SSL")"
# El valor puede ser el literal `camaras-le` o la variable `"${CERT_NAME}"` (que ya
# se verificó =camaras-le arriba). Ambos son aceptables y canónicos.
if printf '%s' "$issue_cmd" | grep -Eq 'certonly' \
   && printf '%s' "$issue_cmd" | grep -Eq -- '--cert-name[[:space:]]+"?(\$\{?CERT_NAME\}?|'"${CERT_NAME}"')"?'; then
  ok "${INIT_SSL}: el comando certonly incluye --cert-name (${CERT_NAME})"
else
  err "${INIT_SSL}: el comando certonly NO incluye --cert-name ${CERT_NAME}"
fi

# ── 3) upgrade-to-https.sh: verifica el linaje canónico. ──
grep -Eq "^CERT_NAME=\"${CERT_NAME}\"" "$UPGRADE" \
  && ok "${UPGRADE}: CERT_NAME=${CERT_NAME}" \
  || err "${UPGRADE}: falta CERT_NAME=\"${CERT_NAME}\""

# ── 4) compose: certbot renew acotado a --cert-name camaras-le. ──
if grep -Eq "certbot renew[^\"']*--cert-name ${CERT_NAME}" "$COMPOSE"; then
  ok "${COMPOSE}: certbot renew --cert-name ${CERT_NAME} (no procesa configs residuales)"
else
  err "${COMPOSE}: el loop de certbot debe usar 'certbot renew --cert-name ${CERT_NAME}'"
fi

# ── 5) Higiene: no comitear certificados/llaves reales al repo. ──
tracked_pem="$(git ls-files -- '*.pem' '*privkey*' '*fullchain*' 2>/dev/null || true)"
if [ -n "$tracked_pem" ]; then
  err "hay material de certificado versionado (no debe estar en git):"
  echo "$tracked_pem" | sed 's/^/      /'
else
  ok "sin certificados/llaves versionados"
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "❌ Inconsistencia de linaje de certificado. Corregí a '${CERT_NAME}' antes de mergear."
  exit 1
fi
echo "✅ Linaje de certificado consistente (${CERT_NAME}) en nginx, certbot y compose."
