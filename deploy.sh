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
# NO silenciar ni tragar el error: si una migración falla, abortar el deploy con
# código ≠0 (igual que scripts/deploy.sh:103). Una migración a medias sobre datos
# de producción compromete la integridad de metadatos de grabaciones (invariante 1)
# y no debe quedar oculta tras `2>/dev/null || true`.
if ! docker compose exec -T api npx prisma migrate deploy; then
  echo "ERROR: las migraciones fallaron — se aborta el deploy. Revisá la DB antes de reintentar." >&2
  exit 1
fi

echo "=== Deploy completado ==="
docker compose ps
