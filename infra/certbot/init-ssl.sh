#!/bin/bash
# init-ssl.sh — Obtener certificado Let's Encrypt por primera vez
# Ejecutar desde el directorio raíz del proyecto: bash infra/certbot/init-ssl.sh
set -e

# DOMAIN = SAN del certificado (lo que va en `-d`). CERT_NAME = nombre del LINAJE
# en /etc/letsencrypt/live/<CERT_NAME> (lo que sirve nginx). Se mantienen SEPARADOS
# a propósito: el linaje canónico es `camaras-le`. El linaje viejo llamado igual que
# el dominio (`camaras.saa.com.py`) quedó con un cert de CA privada y renewal config
# inválida; NO se reutiliza. Emitir con `--cert-name camaras-le` fija el linaje.
DOMAIN="camaras.saa.com.py"
CERT_NAME="camaras-le"
EMAIL="${LETS_ENCRYPT_EMAIL:-sistemas@saa.com.py}"

CERT_PATH="$(docker volume inspect visioncore_certbot_conf --format '{{.Mountpoint}}' 2>/dev/null || echo '')"
if [ -z "$CERT_PATH" ]; then
  echo "⚠️  Corriendo docker compose para crear volúmenes..."
  docker compose up --no-start nginx certbot 2>/dev/null || true
  CERT_PATH="$(docker volume inspect visioncore_certbot_conf --format '{{.Mountpoint}}' 2>/dev/null || echo '')"
fi

# Si ya existe un certificado real en el linaje canónico, salir
if docker compose run --rm --entrypoint "" certbot \
    test -f "/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem" 2>/dev/null; then
  echo "✅ El certificado ya existe para el linaje ${CERT_NAME} (${DOMAIN})"
  echo "   Para renovar: docker compose exec certbot certbot renew --cert-name ${CERT_NAME}"
  exit 0
fi

echo "📦 Creando certificado temporal (dummy) para arrancar nginx..."
docker compose run --rm --entrypoint "" certbot sh -c "
  mkdir -p /etc/letsencrypt/live/${CERT_NAME}
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout /etc/letsencrypt/live/${CERT_NAME}/privkey.pem \
    -out    /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem \
    -subj '/CN=${DOMAIN}' 2>/dev/null
  cp /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem /etc/letsencrypt/live/${CERT_NAME}/chain.pem
"

echo "🚀 Arrancando nginx con certificado dummy..."
docker compose up -d nginx

echo "⏳ Esperando que nginx esté listo..."
sleep 5

echo "🔐 Obteniendo certificado real de Let's Encrypt para ${DOMAIN} (linaje ${CERT_NAME})..."
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --cert-name "${CERT_NAME}" \
  --email "${EMAIL}" \
  --agree-tos \
  --no-eff-email \
  --force-renewal \
  -d "${DOMAIN}"

echo "🔄 Recargando nginx con el certificado real..."
docker compose exec nginx nginx -s reload

echo ""
echo "✅ SSL configurado correctamente para https://${DOMAIN} (linaje ${CERT_NAME})"
echo "   La renovación automática corre cada 12h vía el contenedor certbot"
echo "   (sólo el linaje ${CERT_NAME}); nginx recarga solo cada ~6h para tomarlo."
