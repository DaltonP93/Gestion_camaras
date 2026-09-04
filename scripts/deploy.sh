#!/usr/bin/env bash
# deploy.sh — Script de despliegue de VisionCore VMS
# Uso: bash scripts/deploy.sh [branch]
set -euo pipefail

BRANCH="${1:-main}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()    { echo -e "${GREEN}✓${NC} $1"; }
fail()  { echo -e "${RED}✗ FALLO: $1${NC}"; exit 1; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
info()  { echo -e "${CYAN}▶${NC} $1"; }
step()  { echo -e "\n${BOLD}${CYAN}══ $1 ══${NC}"; }

cd "$PROJECT_DIR"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║    VisionCore VMS — Deploy Script    ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
echo "Directorio: $PROJECT_DIR"
echo "Rama:       $BRANCH"
echo "Fecha:      $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ── 1. Verificar prerequisitos ──────────────────────────────
step "Verificando prerequisitos"

command -v docker   &>/dev/null || fail "docker no está instalado"
command -v git      &>/dev/null || fail "git no está instalado"
ok "docker y git disponibles"

docker compose version &>/dev/null || fail "docker compose v2 no disponible"
ok "docker compose v2 disponible"

[ -f ".env" ] || fail "Archivo .env no encontrado. Copia .env.example a .env y configura las variables."
ok ".env encontrado"

# ── 2. Git pull ──────────────────────────────────────────────
step "Actualizando código"

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
info "Rama actual: $CURRENT_BRANCH → destino: $BRANCH"

git fetch origin "$BRANCH" || fail "No se pudo hacer fetch de origin/$BRANCH"
git checkout "$BRANCH" || fail "No se pudo cambiar a rama $BRANCH"
git pull origin "$BRANCH" || fail "No se pudo hacer pull de origin/$BRANCH"

COMMIT=$(git rev-parse --short HEAD)
ok "Código actualizado. Commit: $COMMIT"

# ── 3. Backup de DB (opcional) ──────────────────────────────
step "Backup de base de datos"

if docker compose ps postgres 2>/dev/null | grep -q "running\|Up"; then
  BACKUP_FILE="backups/db_backup_$(date +%Y%m%d_%H%M%S).sql"
  mkdir -p backups
  # La base es visioncore_db (usuario visioncore); NO silenciar el error: si el
  # backup falla mientras hay datos, abortar el deploy (el rollback depende de él).
  if docker compose exec -T postgres pg_dump -U visioncore visioncore_db > "$BACKUP_FILE"; then
    ok "Backup guardado en $BACKUP_FILE"
  else
    rm -f "$BACKUP_FILE"
    fail "El backup de la base de datos falló — se aborta el deploy. Revisá PostgreSQL antes de reintentar."
  fi
else
  warn "PostgreSQL no está corriendo — se omite backup (primera instalación)"
fi

# ── 4. Build ─────────────────────────────────────────────────
step "Building Docker images"

info "Building api..."
docker compose build --no-cache api || fail "Build de api falló"
ok "api built"

info "Building web..."
docker compose build --no-cache web || fail "Build de web falló"
ok "web built"

# ── 5. Deploy ────────────────────────────────────────────────
step "Desplegando servicios"

info "Levantando servicios..."
docker compose up -d || fail "docker compose up falló"

# Esperar que postgres esté listo
info "Esperando PostgreSQL..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U visioncore &>/dev/null 2>&1; then
    ok "PostgreSQL listo"
    break
  fi
  if [ "$i" -eq 30 ]; then fail "PostgreSQL no respondió en 30s"; fi
  sleep 1
done

# ── 6. Migraciones ───────────────────────────────────────────
step "Aplicando migraciones"

docker compose exec -T api npx prisma migrate deploy || fail "Migraciones fallaron"
ok "Migraciones aplicadas"

# ── 7. Verificación ──────────────────────────────────────────
step "Verificando servicios"

sleep 5

SERVICES=("postgres" "redis" "mediamtx" "api" "web" "nginx")
ALL_OK=true

for svc in "${SERVICES[@]}"; do
  STATUS=$(docker compose ps "$svc" 2>/dev/null | tail -1)
  if echo "$STATUS" | grep -q "running\|Up\|healthy"; then
    ok "$svc: running"
  else
    fail_msg="$svc: no está corriendo"
    warn "$fail_msg"
    ALL_OK=false
  fi
done

# Verificar API
sleep 3
if curl -sf http://localhost:3000/api/health &>/dev/null 2>&1 || \
   curl -sf http://localhost/api/health &>/dev/null 2>&1; then
  ok "API responde"
else
  warn "API aún no responde — puede estar iniciando (revisar: docker compose logs api)"
fi

echo ""
echo -e "${BOLD}══ Resumen ══${NC}"
echo "Commit desplegado: $COMMIT"
echo "Rama: $BRANCH"

if $ALL_OK; then
  echo -e "${GREEN}✓ Deploy completado exitosamente${NC}"
else
  echo -e "${YELLOW}! Deploy completado con advertencias — verificar logs${NC}"
fi

echo ""
echo "Comandos útiles:"
echo "  docker compose logs -f api        # Logs del API"
echo "  docker compose logs -f mediamtx   # Logs de MediaMTX"
echo "  docker compose ps                 # Estado de servicios"
echo "  bash scripts/check-nvrs.sh        # Verificar NVRs"
echo ""
