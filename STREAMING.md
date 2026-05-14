# STREAMING.md — Arquitectura de Streaming VisionCore

## Arquitectura general

```
NVR Hikvision
  └─ RTSP (puerto 554)
       └─ MediaMTX (contenedor)
            ├─ HLS  → nginx /hls/ → browser (HLS.js)
            └─ WebRTC → nginx /webrtc/ → browser (WHEP)
```

## Main stream vs Substream

| Stream | Path RTSP | Uso recomendado | Codec típico | Resolución típica |
|--------|-----------|-----------------|--------------|-------------------|
| Main   | `/Streaming/Channels/{ch}01` | 1×1 / pantalla completa | H.264 / H.265 | 1080p / 4K |
| Sub    | `/Streaming/Channels/{ch}02` | 2×2, 3×3, 4×4 | H.264 | 640×360 / 480p |

**Regla:** layouts 3×3 y 4×4 siempre usan substream. HLS.js en browser **no soporta H.265**, por lo que las cámaras con main stream H.265 SOLO pueden reproducirse en sub (si está en H.264).

Ejemplos de paths:
```
Canal 1  main: rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/101
Canal 1  sub:  rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/102
Canal 10 main: rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/1001
Canal 10 sub:  rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/1002
```

## MediaMTX

### Configuración clave (`infra/mediamtx/mediamtx.yml`)
```yaml
hls:
  hlsCookies: no   # CRÍTICO: evita 401 con JWT Bearer auth
  allow: yes

paths:
  "~.*":
    source: publisher
    sourceOnDemand: yes
    sourceOnDemandStartTimeout: 8s
    sourceOnDemandCloseAfter: 60s
```

### API de MediaMTX (puerto 9997)
```bash
# Listar rutas activas
curl http://localhost:9997/v3/paths/list | python3 -m json.tool

# Estado de una ruta específica
curl http://localhost:9997/v3/paths/get/nvr_abc123_ch01

# Agregar ruta manualmente
curl -X POST http://localhost:9997/v3/config/paths/add/test-path \
  -H "Content-Type: application/json" \
  -d '{"source":"rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/101"}'
```

## Streams bajo demanda

MediaMTX con `sourceOnDemand: yes` conecta el RTSP al NVR **solo cuando hay un cliente HLS activo**. Cuando el último cliente se va, el RTSP se cierra tras `sourceOnDemandCloseAfter` (60s por defecto).

El `StreamManager` en API trackea sesiones de viewers:
- `POST /api/cameras/:id/start-stream` — registra sesión, publica ruta
- `POST /api/cameras/:id/stop-stream` — borra sesión
- `POST /api/cameras/:id/touch-stream` — heartbeat (evitar timeout)
- Límites: `MAX_STREAMS_PER_USER=16`, `MAX_STREAMS_GLOBAL=50`

## Validar RTSP con ffprobe

```bash
# Desde el servidor (o contenedor api que tiene ffprobe)
ffprobe -rtsp_transport tcp \
  -v quiet -print_format json -show_streams \
  "rtsp://admin:PASS@192.168.1.110:554/Streaming/Channels/102"

# Usando el script de diagnóstico
bash scripts/probe-camera.sh 192.168.1.110 1 admin MiClave 554
```

## Diagnóstico de streams

```bash
# Ver todas las rutas en MediaMTX
bash scripts/check-mediamtx.sh

# Ver logs de MediaMTX en tiempo real
docker compose logs -f mediamtx

# Re-sincronizar streams de un NVR (via API)
curl -X POST http://localhost:3000/api/nvrs/<id>/sync-streams \
  -H "Authorization: Bearer <token>"
```

## Errores comunes

| Error | Causa | Solución |
|-------|-------|----------|
| HLS 401 | `hlsCookies: yes` en mediamtx | Cambiar a `hlsCookies: no` y reiniciar |
| HLS 404 | Ruta no registrada en MediaMTX | Hacer sync del NVR |
| Sin frames | RTSP timeout, H.265 en browser | Verificar codec con ffprobe |
| Stream no inicia | NVR offline o credenciales | Usar diagnóstico `/api/cameras/:id/diagnostics` |
