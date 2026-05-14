#!/usr/bin/env bash
# check-smtp.sh — Verifica configuración SMTP y envía email de prueba
# Uso: bash scripts/check-smtp.sh [email_destino]
set -euo pipefail

DEST_EMAIL="${1:-}"
API_URL="${API_URL:-http://localhost:3000}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
info() { echo -e "${CYAN}ℹ${NC} $1"; }

get_token() {
  if [ -n "${VISIONCORE_TOKEN:-}" ]; then echo "$VISIONCORE_TOKEN"
  elif [ -f "$HOME/.visioncore_token" ]; then cat "$HOME/.visioncore_token"
  else warn "Configura: export VISIONCORE_TOKEN=<token>"; exit 1
  fi
}

echo ""
echo "=== VisionCore — Diagnóstico SMTP ==="
echo ""

TOKEN=$(get_token)

# Obtener configuración SMTP
info "Obteniendo configuración SMTP..."
SETTINGS=$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${API_URL}/api/alerts/settings" 2>/dev/null || echo '{}')

if command -v python3 &>/dev/null; then
  echo "$SETTINGS" | python3 -c "
import sys, json
s = json.load(sys.stdin)
email_enabled = s.get('emailEnabled', False)
smtp_host = s.get('smtpHost', '')
smtp_port = s.get('smtpPort', 587)
smtp_user = s.get('smtpUser', '')
smtp_from = s.get('smtpFromEmail', '')
recipients = s.get('recipientEmails', '')
min_sev = s.get('minSeverity', 'HIGH')
alert_types = s.get('alertTypes', {})

print(f'Email habilitado: {email_enabled}')
print(f'SMTP Host: {smtp_host}:{smtp_port}')
print(f'SMTP User: {smtp_user}')
print(f'From: {smtp_from}')
print(f'Destinatarios: {recipients}')
print(f'Severidad mínima: {min_sev}')
print(f'Tipos activos: {[k for k,v in alert_types.items() if v]}')

issues = []
if not email_enabled: issues.append('Email deshabilitado')
if not smtp_host: issues.append('SMTP host vacío')
if not smtp_from: issues.append('From email vacío')
if not recipients: issues.append('Sin destinatarios configurados')

if issues:
    print(f'')
    print(f'PROBLEMAS ENCONTRADOS:')
    for i in issues:
        print(f'  - {i}')
else:
    print(f'')
    print(f'Configuración SMTP parece correcta.')
" 2>/dev/null || warn "python3 no disponible para parsear respuesta"
fi

echo ""

# Enviar email de prueba si hay destinatario
if [ -n "$DEST_EMAIL" ]; then
  info "Enviando email de prueba a: ${DEST_EMAIL}..."
  RESULT=$(curl -sf -X POST \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"testEmail\":\"${DEST_EMAIL}\"}" \
    "${API_URL}/api/alerts/settings/test-email" 2>/dev/null || echo '{"success":false}')

  if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" 2>/dev/null; then
    ok "Email de prueba enviado exitosamente"
  else
    fail "Error al enviar email de prueba"
    echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
  fi
else
  warn "Para enviar email de prueba: $0 <email_destino>"
fi

# Verificar historial de deliveries
echo ""
info "Últimas notificaciones enviadas..."
DELIVERIES=$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${API_URL}/api/alerts/settings/deliveries?limit=5" 2>/dev/null || echo '{"deliveries":[]}')

if command -v python3 &>/dev/null; then
  echo "$DELIVERIES" | python3 -c "
import sys, json
data = json.load(sys.stdin)
deliveries = data.get('deliveries', [])
total = data.get('total', 0)
print(f'Total de notificaciones: {total}')
if deliveries:
    print('Últimas 5:')
    for d in deliveries:
        status = d.get('status', '?')
        channel = d.get('channel', '?')
        created = d.get('createdAt', '?')[:16]
        error = d.get('error', '')
        print(f'  [{created}] {channel} → {status}{\" | \" + error if error else \"\"}')
else:
    print('Sin notificaciones registradas aún.')
" 2>/dev/null || true
fi

echo ""
echo "=== Verificación SMTP completa ==="
echo ""
