#!/bin/bash
# deploy.sh — Script de despliegue rápido VisionCore
set -e

echo "=== VisionCore Deploy ==="
echo "Actualizando código..."
git fetch origin
git pull origin $(git branch --show-current)

echo "Rebuildeando contenedores modificados..."
docker compose build web api

echo "Reiniciando servicios..."
docker compose up -d web api

echo "Aplicando migraciones..."
docker compose exec -T api npx prisma migrate deploy 2>/dev/null || true

echo "=== Deploy completado ==="
docker compose ps
