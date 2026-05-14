#!/usr/bin/env bash
# check-mediamtx.sh — Verifica estado de MediaMTX y rutas de streaming activas
# Uso: bash scripts/check-mediamtx.sh [mediamtx_api_url]
set -euo pipefail

MEDIAMTX_API="${1:-http://localhost:9997}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
info() { echo -e "${CYAN}ℹ${NC} $1"; }

echo ""
echo "=== VisionCore — Estado de MediaMTX ==="
echo "API: ${MEDIAMTX_API}"
echo "Fecha: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Verificar que MediaMTX responda
info "Conectando a MediaMTX API..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${MEDIAMTX_API}/v3/config/global/get" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "000" ]; then
  fail "MediaMTX API no responde en ${MEDIAMTX_API}"
  warn "Verifica que el contenedor mediamtx esté corriendo: docker compose ps mediamtx"
  exit 1
elif [ "$HTTP_CODE" != "200" ]; then
  warn "MediaMTX API respondió con código ${HTTP_CODE}"
fi

ok "MediaMTX API accesible (HTTP ${HTTP_CODE})"
echo ""

# Obtener lista de paths
info "Obteniendo rutas activas..."
PATHS=$(curl -sf "${MEDIAMTX_API}/v3/paths/list" 2>/dev/null || echo '{"items":[]}')

if command -v python3 &>/dev/null; then
  STATS=$(echo "$PATHS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
total = len(items)
ready = sum(1 for p in items if p.get('ready', False))
readers_total = sum(p.get('readers', 0) for p in items)
print(f'total={total} ready={ready} readers={readers_total}')
")
  eval "$STATS"
  ok "Rutas totales: ${total} | Listas (con source): ${ready} | Viewers activos: ${readers_total}"
  echo ""

  # Mostrar rutas con problemas
  echo "$PATHS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
not_ready = [p for p in items if not p.get('ready', False)]
if not_ready:
    print(f'Rutas sin source activo ({len(not_ready)}):')
    for p in not_ready[:20]:
        print(f'  - {p[\"name\"]}')
    if len(not_ready) > 20:
        print(f'  ... y {len(not_ready)-20} más')
else:
    print('Todas las rutas tienen source activo.')
" 2>/dev/null || true

  echo ""

  # Mostrar rutas con viewers
  echo "$PATHS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
with_viewers = [(p['name'], p.get('readers', 0)) for p in items if p.get('readers', 0) > 0]
if with_viewers:
    print(f'Rutas con viewers activos ({len(with_viewers)}):')
    for name, r in sorted(with_viewers, key=lambda x: -x[1])[:10]:
        print(f'  - {name}: {r} viewer(s)')
else:
    print('No hay viewers activos en este momento.')
" 2>/dev/null || true

elif command -v jq &>/dev/null; then
  TOTAL=$(echo "$PATHS" | jq '.items | length')
  READY=$(echo "$PATHS" | jq '[.items[] | select(.ready == true)] | length')
  ok "Rutas totales: ${TOTAL} | Listas: ${READY}"
else
  warn "Instala python3 o jq para análisis detallado"
  echo "Respuesta raw de MediaMTX:"
  echo "$PATHS" | head -50
fi

echo ""

# Verificar accesibilidad HLS
info "Verificando endpoint HLS..."
HLS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${MEDIAMTX_API%:9997}/hls/" 2>/dev/null || \
           curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:8888/" 2>/dev/null || echo "000")
case $HLS_CODE in
  200|301|302|404) ok "Servidor HLS responde (HTTP ${HLS_CODE})" ;;
  000) warn "No se pudo verificar el servidor HLS directamente" ;;
  *)   warn "Servidor HLS respondió con código ${HLS_CODE}" ;;
esac

echo ""

# Verificar configuración clave
info "Verificando configuración de MediaMTX..."
CONFIG=$(curl -sf "${MEDIAMTX_API}/v3/config/global/get" 2>/dev/null || echo '{}')

if command -v python3 &>/dev/null; then
  echo "$CONFIG" | python3 -c "
import sys, json
c = json.load(sys.stdin)
hls = c.get('hls', {})
cookies = hls.get('hlsCookies', True)
if not cookies:
    print('\033[0;32m✓\033[0m hlsCookies: false (correcto para JWT Bearer auth)')
else:
    print('\033[1;33m!\033[0m hlsCookies: true — puede causar 401 en HLS segments')
    print('  Fix: agrega hlsCookies: no en mediamtx.yml')
" 2>/dev/null || true
fi

echo ""
echo "=== Verificación completa ==="
echo ""
echo "Comandos útiles:"
echo "  Ver logs MediaMTX:  docker compose logs -f mediamtx"
echo "  Reiniciar:          docker compose restart mediamtx"
echo "  Ver rutas activas:  curl -s ${MEDIAMTX_API}/v3/paths/list | python3 -m json.tool"
echo ""
