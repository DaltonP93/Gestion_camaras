#!/usr/bin/env bash
# scripts/check-cert-lineage.sh
# Guard de CI: el certificado TLS de producción debe usar SIEMPRE el linaje canónico
# `camaras-le`, de forma consistente en nginx, los scripts de certbot y el compose.
#
# Contexto (incidente resuelto): el linaje viejo homónimo del dominio
# `camaras.saa.com.py` contenía un cert de CA privada y su renewal config quedó
# inválida. nginx debe servir `/etc/letsencrypt/live/camaras-le/...`, init-ssl.sh
# debe EMITIR con `--cert-name camaras-le`, y el contenedor certbot debe RENOVAR
# sólo ese linaje. Este guard falla si alguien reintroduce la ruta vieja o rompe
# la consistencia del nombre de linaje.
#
# También impide que se comiten certificados/llaves reales al repo.
#
# Uso: scripts/check-cert-lineage.sh   (desde la raíz del repo)
# Sale ≠0 ante cualquier inconsistencia.
set -euo pipefail

CERT_NAME="camaras-le"
OLD_LINEAGE="camaras.saa.com.py"           # linaje viejo inválido (NO como path de cert)
NGINX_CONF="infra/nginx/nginx.conf"
INIT_SSL="infra/certbot/init-ssl.sh"
UPGRADE="infra/certbot/upgrade-to-https.sh"
COMPOSE="docker-compose.yml"

fail=0
err() { echo "  ❌ $1"; fail=1; }
ok()  { echo "  ✅ $1"; }

echo "== Guard de linaje de certificado (canónico: ${CERT_NAME})"

# 1) nginx: ssl_certificate(_key) apuntan SÓLO a live/camaras-le/…
if grep -Eq "ssl_certificate(_key)?\s+/etc/letsencrypt/live/${CERT_NAME}/" "$NGINX_CONF"; then
  ok "${NGINX_CONF}: ssl_certificate(_key) → live/${CERT_NAME}/"
else
  err "${NGINX_CONF}: no encontré ssl_certificate(_key) apuntando a live/${CERT_NAME}/"
fi
# Ninguna directiva ssl_certificate debe apuntar al linaje viejo.
if grep -Eq "ssl_certificate(_key)?\s+/etc/letsencrypt/live/${OLD_LINEAGE}/" "$NGINX_CONF"; then
  err "${NGINX_CONF}: hay una directiva ssl_certificate apuntando al linaje viejo live/${OLD_LINEAGE}/"
else
  ok "${NGINX_CONF}: sin referencias de cert al linaje viejo"
fi

# 2) init-ssl.sh: define CERT_NAME=camaras-le y emite con --cert-name.
if grep -Eq "^CERT_NAME=\"${CERT_NAME}\"" "$INIT_SSL"; then ok "${INIT_SSL}: CERT_NAME=${CERT_NAME}"; else err "${INIT_SSL}: falta CERT_NAME=\"${CERT_NAME}\""; fi
if grep -Eq -- "--cert-name" "$INIT_SSL"; then ok "${INIT_SSL}: usa --cert-name al emitir"; else err "${INIT_SSL}: certonly sin --cert-name (el linaje quedaría con el nombre del dominio)"; fi

# 3) upgrade-to-https.sh: verifica el linaje canónico.
if grep -Eq "^CERT_NAME=\"${CERT_NAME}\"" "$UPGRADE"; then ok "${UPGRADE}: CERT_NAME=${CERT_NAME}"; else err "${UPGRADE}: falta CERT_NAME=\"${CERT_NAME}\""; fi

# 4) compose: certbot renew acotado a --cert-name camaras-le.
if grep -Eq "certbot renew[^\"']*--cert-name ${CERT_NAME}" "$COMPOSE"; then
  ok "${COMPOSE}: certbot renew --cert-name ${CERT_NAME} (no procesa configs residuales)"
else
  err "${COMPOSE}: el loop de certbot debe usar 'certbot renew --cert-name ${CERT_NAME}'"
fi

# 5) Higiene: no comitear certificados/llaves reales al repo.
#    (dummy en runtime va al volumen certbot_conf, nunca al árbol de git).
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
