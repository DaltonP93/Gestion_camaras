# VisionCore VMS — Arquitectura de Streaming

## Flujo de datos

```
NVR Hikvision (RTSP puerto 554)
  └─ MediaMTX — pull on-demand (sourceOnDemand: true)
       ├─ HLS  (puerto 8888) → nginx /hls/ → Navegador (hls.js)   ~6s latencia
       └─ WebRTC (puerto 8889) → nginx /webrtc/ → Navegador       ~500ms latencia
```

MediaMTX se conecta al NVR solo cuando hay un viewer activo y corta la conexión RTSP tras 30 segundos sin viewers (`sourceOnDemandCloseAfter: 30s`).

---

## NVRs en producción

| IP | Canales | Descripción |
|---|---|---|
| 192.168.1.10 | 62 | NVR principal |
| 192.168.1.110 | 16 | NVR secundario A |
| 192.168.1.111 | 32 | NVR secundario B |
| 192.168.1.112 | 31 | NVR secundario C |

---

## Formato de URLs RTSP

```
# Stream principal (main) — alta resolución, H.264 o H.265
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/<canal>01

# Substream (sub) — resolución reducida, recomendado para web
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/<canal>02
```

**Ejemplo — Canal 3 del NVR 192.168.1.10:**
```
rtsp://admin:Password@192.168.1.10:554/Streaming/Channels/301   # main
rtsp://admin:Password@192.168.1.10:554/Streaming/Channels/302   # sub
```

> VisionCore usa el substream (`sub`) por defecto para cada cámara. Se puede cambiar individualmente en la UI.

---

## Nombres de path en MediaMTX

Los streams se registran con el patrón `nvr_<cameraId>` (ID de la cámara en la DB):

```
nvr_clxyz123abc  →  HLS: /hls/nvr_clxyz123abc/index.m3u8
                 →  WebRTC: /webrtc/nvr_clxyz123abc/
```

El bloque `~^nvr_.*` en `mediamtx.yml` aplica la configuración on-demand a todos los streams de cámaras.

---

## Flujo de inicio de un stream (on-demand)

1. El frontend solicita abrir stream: `POST /api/streams/start` con el `cameraId`
2. La API descifra la contraseña AES del NVR y llama a `POST /v3/config/paths/add/nvr_<id>` en MediaMTX con la URL RTSP
3. MediaMTX registra el path con `sourceOnDemand: true` pero aún no conecta al NVR
4. El frontend carga `index.m3u8` → MediaMTX conecta al NVR por RTSP y comienza a generar segmentos HLS
5. Sin viewers por 30s → MediaMTX corta la conexión RTSP automáticamente

---

## Límites de concurrencia

Configurables en el contenedor `api` via variables de entorno:

| Variable | Default | Descripción |
|---|---|---|
| `MAX_STREAMS_PER_USER` | 16 | Streams simultáneos por usuario |
| `MAX_STREAMS_GLOBAL` | 50 | Streams simultáneos en total |
| `STREAM_IDLE_TIMEOUT` | 90s | Tiempo sin actividad antes de liberar sesión |

Las sesiones se almacenan en memoria; se pierden al reiniciar el API (intencional: el frontend reconecta).

---

## Configuración MediaMTX relevante

```yaml
# infra/mediamtx/mediamtx.yml
hlsVariant: mpegts          # Compatibilidad máxima con hls.js
hlsSegmentCount: 3          # Buffer de 3 segmentos
hlsSegmentDuration: 2s      # Latencia total ~6s
hlsCookies: no              # Sin cookie auth en HLS (nginx controla acceso)
hlsAlwaysRemux: yes         # Genera HLS aunque no haya viewers activos
hlsAllowOrigin: "*"         # CORS abierto (el acceso real lo gestiona la API)

paths:
  ~^nvr_.*:
    sourceOnDemandStartTimeout: 15s   # Tiempo máx. para que el NVR responda
    sourceOnDemandCloseAfter: 30s     # Cierra RTSP tras 30s sin viewers
```

---

## API REST de MediaMTX

Base URL interna: `http://mediamtx:9997` | Externa (dev): `http://localhost:9997`

```bash
# Listar todos los streams/paths activos
curl http://localhost:9997/v3/paths/list

# Ver detalle de un stream específico
curl http://localhost:9997/v3/paths/get/nvr_<cameraId>

# Registrar stream on-demand manualmente
curl -X POST http://localhost:9997/v3/config/paths/add/nvr_test \
  -H "Content-Type: application/json" \
  -d '{"source":"rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/101","sourceOnDemand":true}'

# Eliminar un stream
curl -X DELETE http://localhost:9997/v3/config/paths/delete/nvr_test
```

---

## Diagnóstico con ffprobe

```bash
# Script completo (prueba main + sub, muestra codec, resolución, FPS)
bash scripts/probe-camera.sh <ip_nvr> <canal> <usuario> <contraseña>

# Ejemplo: canal 5 del NVR principal
bash scripts/probe-camera.sh 192.168.1.10 5 admin MiClave123

# Prueba manual directa
ffprobe -v quiet -print_format json -show_streams \
  -rtsp_transport tcp \
  "rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/501"
```

La salida indica el codec (`h264` o `hevc`), resolución, FPS y bitrate de cada stream.

---

## HLS vs WebRTC

| | HLS | WebRTC |
|---|---|---|
| Latencia | ~6s (3 × 2s) | ~500ms |
| Compatibilidad | Universal (hls.js polyfill) | Navegadores modernos |
| Uso recomendado | Monitoreo general y multiview | PTZ y operación en tiempo real |
| ICE externo | No requerido | No requerido (red local) |

El frontend usa HLS por defecto. WebRTC se puede activar manualmente por stream desde la UI.
