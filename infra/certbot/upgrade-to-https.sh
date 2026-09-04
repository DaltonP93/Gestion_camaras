#!/bin/bash
# upgrade-to-https.sh — Activar/confirmar HTTPS en nginx luego de obtener el cert.
# Ejecutar DESPUÉS de haber corrido init-ssl.sh exitosamente.
#
# ENDURECIMIENTO (auditoría de robustez, hallazgo P1): este script YA NO regenera
# infra/nginx/nginx.conf mediante heredoc. La config versionada
# (infra/nginx/nginx.conf) ES la config HTTPS endurecida y es la única fuente de
# verdad, con:
#   - logs SIN querystring/JWT ('$request_method $uri', nunca '$request'),
#   - SIN CORS '*' (proxy_hide_header Access-Control-Allow-Origin en /hls/),
#   - proxy_buffering off en el preview fMP4 y en HLS,
#   - bloqueo de dotfiles / paths de ataque y cabeceras de seguridad (HSTS, etc.).
#
# La versión anterior sobrescribía ese archivo con un heredoc regresivo que, justo
# en el cutover a producción, reintroducía la fuga de JWT en el access log
# ('$request' con '?token=<JWT>'), reañadía 'Access-Control-Allow-Origin: *' y
# perdía 'proxy_buffering off'. Ahora sólo se valida y se recarga la config
# versionada — el bloque TLS proviene de la nginx.conf endurecida, no de un template.
set -e

DOMAIN="camaras.saa.com.py"
NGINX_CONF="infra/nginx/nginx.conf"

# 1) Verificar que el certificado existe.
if ! docker compose run --rm --entrypoint "" certbot \
    test -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" 2>/dev/null; then
  echo "❌ No existe el certificado. Primero ejecutar: bash infra/certbot/init-ssl.sh"
  exit 1
fi

# 2) Sanity check: la config versionada debe contener el server{} en 443 (HTTPS).
#    Si no, quedó en un estado inesperado; abortar antes de recargar para no dejar
#    nginx sirviendo una config sin TLS o sin endurecer.
if ! grep -q "listen 443" "${NGINX_CONF}"; then
  echo "❌ ${NGINX_CONF} no contiene un server{} en 443."
  echo "   Se esperaba la config HTTPS endurecida versionada. Restaurala desde el"
  echo "   repositorio (git checkout -- ${NGINX_CONF}) antes de continuar."
  exit 1
fi

# 3) Validar la configuración DENTRO del contenedor y recargar (sin regenerar nada).
echo "🔎 Validando la configuración de nginx (nginx -t)..."
docker compose exec nginx nginx -t

echo "🔄 Recargando nginx con la config HTTPS endurecida versionada..."
docker compose exec nginx nginx -s reload

echo ""
echo "✅ HTTPS activo para https://${DOMAIN} usando infra/nginx/nginx.conf (endurecida)."
echo "   La renovación de certificados corre en el contenedor certbot; nginx además"
echo "   recarga solo cada 6h para tomar el cert renovado (ver 'command' de nginx en"
echo "   docker-compose.yml), por lo que no hace falta un reload manual tras renovar."
