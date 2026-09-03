#!/bin/bash
# setup.sh — Instalación completa de VisionCore
# Uso: chmod +x setup.sh && ./setup.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[VisionCore]${NC} $1"; }
warn() { echo -e "${YELLOW}[AVISO]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║        VisionCore VMS — Setup             ║"
echo "║   Sistema de Gestión NVR Hikvision        ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# ─── Verificar prerrequisitos ──────────────────────────────────
log "Verificando prerrequisitos..."

if ! command -v docker &>/dev/null; then
  err "Docker no está instalado. Instálalo desde https://docs.docker.com/get-docker/"
fi

if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null; then
  err "Docker Compose no está instalado."
fi

DOCKER_V=$(docker --version | grep -oP '\d+' | head -1)
if [ "$DOCKER_V" -lt 24 ]; then
  warn "Se recomienda Docker >= 24.0 (tienes v$DOCKER_V)"
fi

log "Docker OK ✓"

# ─── Configurar .env ──────────────────────────────────────────
if [ ! -f ".env" ]; then
  log "Creando archivo .env desde .env.example..."
  cp .env.example .env

  # Generar secrets aleatorios. Reemplazo por línea (^VAR=) para no depender de
  # un texto de placeholder concreto; se usa | como delimitador de sed.
  if command -v openssl &>/dev/null; then
    JWT_SECRET=$(openssl rand -hex 32)
    JWT_REFRESH=$(openssl rand -hex 32)
    NVR_KEY=$(openssl rand -hex 32)

    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
    # JWT_REFRESH_SECRET: reemplazar si existe la línea, si no, añadirla.
    if grep -q "^JWT_REFRESH_SECRET=" .env; then
      sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$JWT_REFRESH|" .env
    else
      echo "JWT_REFRESH_SECRET=$JWT_REFRESH" >> .env
    fi
    # NVR_CREDENTIAL_KEY: rellenar solo si el placeholder existe y está vacío.
    if grep -q "^NVR_CREDENTIAL_KEY=$" .env; then
      sed -i "s|^NVR_CREDENTIAL_KEY=$|NVR_CREDENTIAL_KEY=$NVR_KEY|" .env
    fi

    # Verificar que el reemplazo de JWT_SECRET tuvo efecto.
    if grep -q "^JWT_SECRET=$JWT_SECRET$" .env; then
      log "Secrets generados aleatoriamente (JWT_SECRET, JWT_REFRESH_SECRET, NVR_CREDENTIAL_KEY) ✓"
    else
      warn "No se pudo escribir JWT_SECRET en .env — revísalo manualmente"
    fi
  else
    warn "openssl no disponible — cambia JWT_SECRET y NVR_CREDENTIAL_KEY manualmente en .env"
  fi

  echo ""
  warn "⚠️  Edita el archivo .env con las IPs y contraseñas de tus NVRs antes de continuar"
  echo ""
  echo "  Variables a configurar:"
  echo "    NVR_UTI_IP=<ip de NVR UTI>"
  echo "    NVR_UTI_PASS=<contraseña>"
  echo "    NVR_SAA_2023_IP=<ip>"
  echo "    NVR_SAA_2023_PASS=<contraseña>"
  echo "    NVR_TORRE_VIEJA_IP=<ip>"
  echo "    NVR_TORRE_VIEJA_PASS=<contraseña>"
  echo "    NVR_NUEVA_TORRE_IP=<ip>"
  echo "    NVR_NUEVA_TORRE_PASS=<contraseña>"
  echo ""
  read -p "¿Continuar sin configurar NVRs ahora? (puedes configurarlos desde la UI) [s/N]: " confirm
  if [[ "$confirm" != "s" && "$confirm" != "S" ]]; then
    info "Edita .env y vuelve a ejecutar ./setup.sh"
    exit 0
  fi
else
  log "Archivo .env encontrado ✓"
fi

# ─── Construir e iniciar servicios ────────────────────────────
log "Construyendo contenedores Docker..."
docker compose build --no-cache

log "Iniciando servicios..."
docker compose up -d

# ─── Esperar a que PostgreSQL esté listo ──────────────────────
log "Esperando a PostgreSQL..."
MAX_RETRIES=30
RETRY=0
until docker compose exec -T postgres pg_isready -U visioncore -d visioncore_db &>/dev/null; do
  RETRY=$((RETRY + 1))
  if [ $RETRY -ge $MAX_RETRIES ]; then
    err "PostgreSQL no respondió después de ${MAX_RETRIES}s"
  fi
  sleep 1
done
log "PostgreSQL listo ✓"

# ─── Ejecutar migraciones ─────────────────────────────────────
log "Aplicando migraciones de base de datos..."
docker compose exec -T api npx prisma migrate deploy

# ─── Seed inicial ─────────────────────────────────────────────
log "Poblando datos iniciales (NVRs y usuarios demo)..."
docker compose exec -T api npx tsx src/seed.ts

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║         ✅ Instalación completa!           ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
log "VisionCore está corriendo en:"
echo ""
echo "   🌐 Web App:   http://localhost"
echo "   🔌 API:       http://localhost/api"
echo "   📹 Streams:   http://localhost:8888"
echo "   🛠️  API Admin: http://localhost:9997"
echo ""
log "Credenciales de acceso:"
echo "   admin      / Admin123!  (Administrador total)"
echo "   supervisor / Super123!  (Ver todo + grabaciones)"
echo "   operador1  / Oper123!   (Solo cámaras en vivo)"
echo "   auditor    / Audit123!  (Solo grabaciones)"
echo ""
warn "⚠️  Cambia las contraseñas por defecto en producción"
echo ""
info "Comandos útiles:"
echo "   docker compose logs -f api       → Ver logs del backend"
echo "   docker compose logs -f mediamtx  → Ver logs de streams"
echo "   docker compose down              → Detener todo"
echo "   docker compose restart api       → Reiniciar backend"
echo ""
