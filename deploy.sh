#!/bin/bash
# deploy.sh — Script de despliegue rápido VisionCore
set -e

echo "=== VisionCore Deploy ==="
echo "Actualizando código..."
git fetch origin
git pull origin $(git branch --show-current)

# Antes de build/up: el API ya no arranca con un JWT_SECRET de valor público
# (default o ejemplo publicado) y docker-compose.yml exige JWT_SECRET. Si JWT_SECRET
# no cumple, set -e aborta aquí y los contenedores quedan como estaban (las demás
# variables con valor público sólo se informan). No imprime valores; el entorno
# pisa al .env, como en la interpolación de compose.
echo "Verificando secretos (valores públicos conocidos)..."
if [ -f .env ]; then
  bash scripts/check-public-secrets.sh --env-file .env --process-env
else
  bash scripts/check-public-secrets.sh --process-env
fi

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
