#!/bin/bash
# upgrade-to-https.sh — Activar HTTPS en nginx luego de obtener el cert
# Ejecutar DESPUÉS de haber corrido init-ssl.sh exitosamente
set -e

DOMAIN="camaras.saa.com.py"
NGINX_CONF="infra/nginx/nginx.conf"

# Verificar que el cert existe
if ! docker compose run --rm --entrypoint "" certbot \
    test -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" 2>/dev/null; then
  echo "❌ No existe el certificado. Primero ejecutar: bash infra/certbot/init-ssl.sh"
  exit 1
fi

echo "📝 Actualizando nginx.conf para HTTPS..."
cat > "${NGINX_CONF}" << 'NGINXEOF'
# infra/nginx/nginx.conf — HTTPS activado con Let's Encrypt

worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
    use epoll;
    multi_accept on;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    log_format main '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent"';
    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    client_max_body_size 100M;

    upstream api          { server api:4000;      keepalive 32; }
    upstream web          { server web:80;        keepalive 16; }
    upstream mediamtx_hls { server mediamtx:8888; keepalive 16; }

    server {
        listen 80;
        server_name camaras.saa.com.py;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        location / { return 301 https://$host$request_uri; }
    }

    server {
        listen 443 ssl http2;
        server_name camaras.saa.com.py;

        ssl_certificate     /etc/letsencrypt/live/camaras.saa.com.py/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/camaras.saa.com.py/privkey.pem;
        ssl_session_timeout  1d;
        ssl_session_cache    shared:SSL:10m;
        ssl_session_tickets  off;
        ssl_protocols        TLSv1.2 TLSv1.3;
        ssl_ciphers          ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256;
        ssl_prefer_server_ciphers off;

        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options SAMEORIGIN always;

        location /api/ {
            proxy_pass http://api;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 60s;
            proxy_connect_timeout 10s;
        }

        location /ws/ {
            proxy_pass http://api;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 3600s;
        }

        location /hls/ {
            proxy_pass http://mediamtx_hls/;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_cache_bypass 1;
            proxy_buffering off;
            add_header Cache-Control "no-cache, no-store, must-revalidate";
            add_header Access-Control-Allow-Origin "*";
            add_header Access-Control-Allow-Methods "GET, OPTIONS";
        }

        location / {
            proxy_pass http://web;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_intercept_errors on;
            error_page 404 = @spa_fallback;
        }

        location @spa_fallback {
            proxy_pass http://web;
            proxy_set_header Host $host;
        }
    }
}
NGINXEOF

echo "🔄 Recargando nginx con configuración HTTPS..."
docker compose exec nginx nginx -s reload

echo ""
echo "✅ HTTPS activado para https://${DOMAIN}"
