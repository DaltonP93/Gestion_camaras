#!/bin/bash
# init-ssl.sh — Obtener el certificado Let's Encrypt del linaje canónico por 1ª vez.
# Ejecutar desde el directorio raíz del proyecto: bash infra/certbot/init-ssl.sh
#
# Idempotente y recuperable ante interrupción:
#   - "Linaje ya emitido" se decide por la RENEWAL CONFIG de certbot
#     (/etc/letsencrypt/renewal/<CERT_NAME>.conf), NO por `test -f live/*.pem`
#     (un dummy de un run interrumpido tiene los .pem pero NO es un linaje real).
#   - El cert dummy de arranque se marca con `.dummy` y se ELIMINA antes de emitir,
#     pero SÓLO si NO existe un linaje administrado (nunca se borra uno válido).
#   - La emisión usa `--entrypoint certbot` para NO heredar el loop de `renew` que
#     el servicio define como entrypoint (si no, `run certbot certonly` ejecutaría
#     el loop e ignoraría `certonly`).
set -e

# DOMAIN = SAN del certificado (lo que va en `-d`). CERT_NAME = nombre del LINAJE en
# /etc/letsencrypt/live/<CERT_NAME> (lo que sirve nginx). SEPARADOS a propósito: el
# linaje canónico es `camaras-le`. El linaje viejo homónimo del dominio
# (`camaras.saa.com.py`) quedó con un cert de CA privada y renewal config inválida;
# NO se reutiliza. Emitir con `--cert-name camaras-le` fija el linaje.
DOMAIN="camaras.saa.com.py"
CERT_NAME="camaras-le"
EMAIL="${LETS_ENCRYPT_EMAIL:-sistemas@saa.com.py}"

LE_LIVE="/etc/letsencrypt/live/${CERT_NAME}"
LE_RENEWAL="/etc/letsencrypt/renewal/${CERT_NAME}.conf"
DUMMY_MARKER="${LE_LIVE}/.dummy"

# Helpers: `cb` corre un comando en el contenedor certbot SIN su entrypoint (loop de
# renew); `cb_certbot` corre el BINARIO certbot (entrypoint explícito) para `certonly`.
cb()         { docker compose run --rm --entrypoint "" certbot "$@"; }
cb_certbot() { docker compose run --rm --entrypoint certbot certbot "$@"; }

CERT_PATH="$(docker volume inspect visioncore_certbot_conf --format '{{.Mountpoint}}' 2>/dev/null || echo '')"
if [ -z "$CERT_PATH" ]; then
  echo "⚠️  Corriendo docker compose para crear volúmenes..."
  docker compose up --no-start nginx certbot 2>/dev/null || true
fi

# 1) ¿Ya existe un LINAJE ADMINISTRADO por certbot? La renewal config es la señal de
#    que certbot administra el linaje (un dummy interrumpido NO la tiene). Pero la
#    renewal config sola NO alcanza: el linaje se considera VÁLIDO sólo si además
#    fullchain.pem y privkey.pem existen y NO están vacíos/rotos.
#      - renewal + cert + key OK        → early exit (no re-emitir).
#      - renewal presente pero cert/key ausentes o rotos → ABORTAR fail-closed
#        (NO borrar, NO re-emitir automáticamente: requiere intervención manual).
#      - sin renewal                    → continuar con el bootstrap.
if cb test -f "${LE_RENEWAL}"; then
  if cb sh -c "test -s '${LE_LIVE}/fullchain.pem' && test -s '${LE_LIVE}/privkey.pem'"; then
    echo "✅ Linaje administrado ${CERT_NAME} válido (${DOMAIN}); no se re-emite."
    echo "   Renovar: docker compose exec certbot certbot renew --cert-name ${CERT_NAME}"
    exit 0
  fi
  echo "❌ Linaje ${CERT_NAME} ADMINISTRADO pero ROTO: existe ${LE_RENEWAL} pero"
  echo "   falta o está vacío ${LE_LIVE}/fullchain.pem y/o privkey.pem."
  echo "   NO se borra ni se re-emite automáticamente (fail-closed). Revisá a mano:"
  echo "     /etc/letsencrypt/{renewal/${CERT_NAME}.conf,live/${CERT_NAME},archive/${CERT_NAME}}"
  echo "   (p.ej. 'certbot certificates' dentro del contenedor certbot para diagnosticar)."
  exit 1
fi

# 2) Sin linaje administrado: crear un cert DUMMY (marcado) para que nginx pueda
#    levantar el server{} en 443 y responder el ACME HTTP-01 por /var/www/certbot.
echo "📦 Creando certificado temporal (dummy, marcado) para arrancar nginx..."
cb sh -c "
  set -e
  mkdir -p '${LE_LIVE}'
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout '${LE_LIVE}/privkey.pem' \
    -out    '${LE_LIVE}/fullchain.pem' \
    -subj '/CN=${DOMAIN}' 2>/dev/null
  cp '${LE_LIVE}/fullchain.pem' '${LE_LIVE}/chain.pem'
  touch '${DUMMY_MARKER}'
"

echo "🚀 Arrancando nginx con certificado dummy..."
docker compose up -d nginx

echo "⏳ Esperando que nginx esté listo..."
sleep 5

# 3) Antes de emitir: si el live dir es un DUMMY (marcado) y NO hay linaje
#    administrado, eliminarlo para que certbot cree el linaje limpio. NUNCA se borra
#    un linaje administrado válido (guardado por la renewal config).
echo "🧹 Preparando el linaje para la emisión real..."
cb sh -c "
  set -e
  if [ -f '${LE_RENEWAL}' ]; then
    echo '   linaje administrado presente: NO se toca el live dir.'
  elif [ -f '${DUMMY_MARKER}' ]; then
    echo '   removiendo dummy de bootstrap antes de emitir.'
    rm -rf '${LE_LIVE}'
  fi
"

# 4) Emitir el certificado real. `--entrypoint certbot` es OBLIGATORIO: sin él,
#    `docker compose run certbot certonly …` heredaría el loop de `renew` del
#    servicio y NO ejecutaría certonly. `--cert-name` fija el linaje canónico.
echo "🔐 Obteniendo certificado real de Let's Encrypt para ${DOMAIN} (linaje ${CERT_NAME})..."
cb_certbot certonly \
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
