#!/usr/bin/env bash
# rollback.sh — Rollback de VisionCore VMS a commit anterior
# Uso: bash scripts/rollback.sh [commit_hash]
# Si no se especifica commit, muestra los últimos 10 commits para elegir.
set -euo pipefail

TARGET="${1:-}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗ FALLO: $1${NC}"; exit 1; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
info() { echo -e "${CYAN}▶${NC} $1"; }

cd "$PROJECT_DIR"

echo ""
echo -e "${BOLD}VisionCore VMS — Rollback${NC}"
echo ""

CURRENT=$(git rev-parse --short HEAD)
echo "Commit actual: $CURRENT"
echo ""

if [ -z "$TARGET" ]; then
  echo "Últimos 10 commits:"
  git log --oneline -10
  echo ""
  echo "Uso: $0 <commit_hash>"
  echo "Ejemplo: $0 abc1234"
  exit 0
fi

# Confirmar rollback
warn "Se va a hacer rollback a commit: $TARGET"
warn "El commit actual ($CURRENT) se perderá del HEAD de la rama."
echo -n "¿Confirmas? (s/N): "
read -r CONFIRM
if [ "${CONFIRM,,}" != "s" ]; then
  echo "Rollback cancelado."
  exit 0
fi

# Verificar que el commit existe
git rev-parse --verify "$TARGET" &>/dev/null || fail "Commit $TARGET no encontrado"

# Hacer rollback
info "Haciendo rollback a $TARGET..."
git checkout "$TARGET" -- . || fail "Checkout falló"
git add -A
git commit -m "rollback: revert to $TARGET at $(date '+%Y-%m-%d %H:%M:%S')" || true

ok "Código revertido a $TARGET"

# Rebuild y deploy
echo ""
info "Rebuilding y desplegando..."

docker compose build --no-cache api web || fail "Build falló"
docker compose up -d || fail "Deploy falló"

sleep 5
docker compose exec -T api npx prisma migrate deploy || warn "Migraciones - puede requerir migración manual"

echo ""
ok "Rollback completado. Verificar: docker compose ps"
echo ""
