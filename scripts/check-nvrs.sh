#!/usr/bin/env bash
# check-nvrs.sh — Verifica estado HTTP de todos los NVRs configurados en la DB
# Uso: bash scripts/check-nvrs.sh [--json]
set -euo pipefail

JSON=${1:-}
API_URL="${API_URL:-http://localhost:3000}"
TOKEN_FILE="${HOME}/.visioncore_token"

# Colores
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log() { echo -e "$1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

# Obtener token (desde archivo o variable de entorno)
get_token() {
  if [ -n "${VISIONCORE_TOKEN:-}" ]; then
    echo "$VISIONCORE_TOKEN"
  elif [ -f "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
  else
    # Intentar login con credenciales por defecto del .env
    if [ -f ".env" ]; then
      source .env 2>/dev/null || true
    fi
    if [ -f "apps/api/.env" ]; then
      source apps/api/.env 2>/dev/null || true
    fi
    warn "No se encontró token. Usa: export VISIONCORE_TOKEN=<token>"
    warn "O guarda el token en $TOKEN_FILE"
    exit 1
  fi
}

check_nvr_http() {
  local ip=$1 port=$2 name=$3
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${ip}:${port}/ISAPI/System/status" 2>/dev/null || echo "000")
  case $code in
    200|401) ok "${name} (${ip}:${port}) — HTTP ${code}" ;;
    000)     fail "${name} (${ip}:${port}) — Sin respuesta" ;;
    *)       warn "${name} (${ip}:${port}) — HTTP ${code}" ;;
  esac
}

main() {
  log "\n=== VisionCore — Estado de NVRs ==="
  log "Fecha: $(date '+%Y-%m-%d %H:%M:%S')\n"

  TOKEN=$(get_token)

  # Obtener lista de NVRs desde la API
  NVRS=$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${API_URL}/api/nvrs" 2>/dev/null || echo "[]")

  if [ "$NVRS" = "[]" ] || [ -z "$NVRS" ]; then
    warn "No se pudo obtener NVRs desde la API o no hay NVRs configurados."
    warn "Verificar que el servicio esté corriendo en ${API_URL}"
    exit 1
  fi

  # Parsear con python3 si está disponible, sino con jq
  if command -v python3 &>/dev/null; then
    echo "$NVRS" | python3 -c "
import sys, json
nvrs = json.load(sys.stdin)
for n in nvrs:
    print(f\"{n['id']}|{n['name']}|{n['ipAddress']}|{n['port']}|{n.get('online','?')}\")
"
  elif command -v jq &>/dev/null; then
    echo "$NVRS" | jq -r '.[] | "\(.id)|\(.name)|\(.ipAddress)|\(.port)|\(.online)"'
  else
    warn "Instala python3 o jq para parsear la respuesta JSON"
    exit 1
  fi | while IFS='|' read -r id name ip port online; do
    log "\n--- ${name} ---"
    # Estado en DB
    if [ "$online" = "True" ] || [ "$online" = "true" ]; then
      ok "DB: Online"
    else
      fail "DB: Offline"
    fi
    # Verificar conectividad HTTP directa
    check_nvr_http "$ip" "$port" "HTTP directo"

    # Verificar via API
    STATUS=$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${API_URL}/api/nvrs/${id}/status" 2>/dev/null || echo '{"online":false}')
    if command -v python3 &>/dev/null; then
      echo "$STATUS" | python3 -c "
import sys, json
s = json.load(sys.stdin)
online = s.get('online', False)
disk = s.get('diskUsage', '?')
fw = s.get('firmware', '?')
print(f\"online={online} disk={disk}% firmware={fw}\")
"
    fi
  done

  log "\n=== Verificación completa ===\n"
}

main "$@"
