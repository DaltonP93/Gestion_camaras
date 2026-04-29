#!/bin/bash
# git-init.sh — Inicializar repositorio y hacer push a GitHub
# Ejecutar desde la raíz del proyecto: bash git-init.sh

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[git]${NC} $1"; }
warn() { echo -e "${YELLOW}[aviso]${NC} $1"; }

REPO_URL="https://github.com/DaltonP93/Gestion_camaras.git"

log "Inicializando repositorio Git..."
git init

log "Configurando rama principal como 'main'..."
git branch -M main

log "Agregando remote origin..."
git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"

log "Agregando todos los archivos al staging..."
git add .

log "Verificando archivos a commitear..."
git status --short

log "Creando commit inicial..."
git commit -m "feat: VisionCore VMS — sistema completo de gestión NVR Hikvision

Stack:
- Backend: Node.js + Fastify + Prisma + PostgreSQL + Redis
- Frontend: React 18 + Vite + TypeScript + Tailwind CSS
- Streaming: MediaMTX (RTSP → HLS/WebRTC)
- Proxy: Nginx reverse proxy
- Contenedores: Docker Compose

Funcionalidades:
- Autenticación JWT con refresh tokens
- 4 roles: Admin, Supervisor, Operador, Auditor
- Vista en vivo con grillas (1/4/9/16/25 cámaras)
- Streaming HLS desde NVRs Hikvision vía ISAPI
- Búsqueda y reproducción de grabaciones
- Control PTZ de cámaras
- Gestión de usuarios y permisos granulares
- Alertas en tiempo real vía WebSocket
- Health check automático de NVRs y cámaras
- Log de auditoría completo
- 4 NVRs Hikvision pre-configurados:
  * NVR UTI (DS-7616NI-K2/16P, 16ch)
  * NVR_32_SAA_2023 (DS-7732NI-K4, 32ch)
  * NVR Torre Vieja (DS-7732NI-K4, 31ch)
  * NVR SAA Nueva Torre (DS-9664NI-I8, 62ch)"

log "Haciendo push a GitHub..."
git push -u origin main

echo ""
echo "✅ Repositorio publicado en: $REPO_URL"
echo ""
warn "Próximo paso: clona en tu servidor y ejecuta ./setup.sh"
