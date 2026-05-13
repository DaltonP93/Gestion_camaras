#!/usr/bin/env bash
# probe-camera.sh — Prueba RTSP de una cámara específica con ffprobe
# Uso: bash scripts/probe-camera.sh <ip_nvr> <canal> <usuario> <contraseña> [rtsp_port]
# Ejemplo: bash scripts/probe-camera.sh 192.168.1.10 1 admin Password123 554
set -euo pipefail

NVR_IP=${1:-}
CHANNEL=${2:-1}
USER=${3:-admin}
PASS=${4:-}
RTSP_PORT=${5:-554}

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
info() { echo -e "${CYAN}ℹ${NC} $1"; }

if [ -z "$NVR_IP" ] || [ -z "$PASS" ]; then
  echo "Uso: $0 <ip_nvr> <canal> <usuario> <contraseña> [rtsp_port]"
  echo "Ejemplo: $0 192.168.1.10 1 admin MiClave123 554"
  exit 1
fi

if ! command -v ffprobe &>/dev/null; then
  warn "ffprobe no está instalado. Instala ffmpeg: apk add ffmpeg / apt install ffmpeg"
  exit 1
fi

probe_stream() {
  local url=$1 label=$2
  local masked_url="rtsp://${USER}:***@${NVR_IP}:${RTSP_PORT}/${url#rtsp://*/}"
  info "Probando ${label}: ${masked_url}"

  local output
  local start_ts end_ts latency
  start_ts=$(date +%s%3N)

  output=$(timeout 15 ffprobe \
    -v quiet \
    -print_format json \
    -show_streams \
    -rtsp_transport tcp \
    "$url" 2>&1) && rc=0 || rc=$?

  end_ts=$(date +%s%3N)
  latency=$((end_ts - start_ts))

  if [ $rc -ne 0 ]; then
    # Detectar tipo de error
    if echo "$output" | grep -qi "401\|Unauthorized\|authentication"; then
      fail "${label}: Error de autenticación (401) — verifica usuario/contraseña"
    elif echo "$output" | grep -qi "Connection refused\|ECONNREFUSED"; then
      fail "${label}: Conexión rechazada — puerto RTSP cerrado o NVR offline"
    elif echo "$output" | grep -qi "timeout\|timed out"; then
      fail "${label}: Timeout — NVR no responde en RTSP"
    elif echo "$output" | grep -qi "No such file\|404\|not found"; then
      fail "${label}: Canal no encontrado (404) — verifica número de canal"
    else
      fail "${label}: Error — $(echo "$output" | tail -1)"
    fi
    return 1
  fi

  ok "${label}: Stream accesible (latencia: ${latency}ms)"

  # Parsear info del stream
  if command -v python3 &>/dev/null; then
    echo "$output" | python3 -c "
import sys, json
data = json.load(sys.stdin)
streams = data.get('streams', [])
for s in streams:
    codec = s.get('codec_name', '?')
    w = s.get('width', '?')
    h = s.get('height', '?')
    fps_str = s.get('r_frame_rate', '0/1')
    try:
        num, den = fps_str.split('/')
        fps = round(int(num)/int(den), 1) if int(den) > 0 else '?'
    except:
        fps = '?'
    br = s.get('bit_rate', '?')
    if br != '?':
        br = f'{int(br)//1000} kbps'
    codec_type = s.get('codec_type', '')
    if codec_type == 'video':
        print(f'  Codec: {codec} | Resolución: {w}x{h} | FPS: {fps} | Bitrate: {br}')
" 2>/dev/null || true
  fi
}

echo ""
echo "=== Diagnóstico RTSP: ${NVR_IP} Canal ${CHANNEL} ==="
echo ""

# Primero verificar que el NVR responda HTTP
info "Verificando conectividad HTTP al NVR..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${NVR_IP}:80/ISAPI/System/status" 2>/dev/null || echo "000")
case $HTTP_CODE in
  200|401) ok "NVR responde HTTP (código ${HTTP_CODE})" ;;
  000)     fail "NVR no responde en HTTP — verificar IP y conectividad de red" ;;
  *)       warn "NVR responde con código HTTP ${HTTP_CODE}" ;;
esac

echo ""

# Verificar puerto RTSP
info "Verificando puerto RTSP ${RTSP_PORT}..."
if timeout 5 bash -c "echo >/dev/tcp/${NVR_IP}/${RTSP_PORT}" 2>/dev/null; then
  ok "Puerto RTSP ${RTSP_PORT} abierto"
else
  fail "Puerto RTSP ${RTSP_PORT} cerrado o bloqueado por firewall"
fi

echo ""

# Probar stream principal
MAIN_URL="rtsp://${USER}:${PASS}@${NVR_IP}:${RTSP_PORT}/Streaming/Channels/${CHANNEL}01"
probe_stream "$MAIN_URL" "Stream principal (main)"

echo ""

# Probar stream secundario
SUB_URL="rtsp://${USER}:${PASS}@${NVR_IP}:${RTSP_PORT}/Streaming/Channels/${CHANNEL}02"
probe_stream "$SUB_URL" "Stream secundario (sub)"

echo ""
echo "=== Diagnóstico completo ==="
echo ""
