#!/bin/bash
# init-ssl.sh — Obtener certificado Let's Encrypt por primera vez
# Ejecutar desde el directorio raíz del proyecto: bash infra/certbot/init-ssl.sh
set -e

DOMAIN="camaras.saa.com.py"
EMAIL="${LETS_ENCRYPT_EMAIL:-sistemas@saa.com.py}"

CERT_PATH="$(docker volume inspect visioncore_certbot_conf --format '{{.Mountpoint}}' 2>/dev/null || echo '')"
if [ -z "$CERT_PATH" ]; then
  echo "⚠️  Corriendo docker compose para crear volúmenes..."
  docker compose up --no-start nginx certbot 2>/dev/null || true
  CERT_PATH="$(docker volume inspect visioncore_certbot_conf --format '{{.Mountpoint}}' 2>/dev/null || echo '')"
fi

# Si ya existe un certificado real, salir
if docker compose run --rm --entrypoint "" certbot \
    test -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" 2>/dev/null; then
  echo "✅ El certificado ya existe para ${DOMAIN}"
  echo "   Para renovar: docker compose exec certbot certbot renew"
  exit 0
fi

echo "📦 Creando certificado temporal (dummy) para arrancar nginx..."
docker compose run --rm --entrypoint "" certbot sh -c "
  mkdir -p /etc/letsencrypt/live/${DOMAIN}
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout /etc/letsencrypt/live/${DOMAIN}/privkey.pem \
    -out    /etc/letsencrypt/live/${DOMAIN}/fullchain.pem \
    -subj '/CN=${DOMAIN}' 2>/dev/null
  cp /etc/letsencrypt/live/${DOMAIN}/fullchain.pem /etc/letsencrypt/live/${DOMAIN}/chain.pem
"

echo "🚀 Arrancando nginx con certificado dummy..."
docker compose up -d nginx

echo "⏳ Esperando que nginx esté listo..."
sleep 5

echo "🔐 Obteniendo certificado real de Let's Encrypt para ${DOMAIN}..."
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "${EMAIL}" \
  --agree-tos \
  --no-eff-email \
  --force-renewal \
  -d "${DOMAIN}"

echo "🔄 Recargando nginx con el certificado real..."
docker compose exec nginx nginx -s reload

echo ""
echo "✅ SSL configurado correctamente para https://${DOMAIN}"
echo "   La renovación automática corre cada 12h via el contenedor certbot."
