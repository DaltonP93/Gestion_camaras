# VisionCore Analytics

Microservicio de analítica de video: detección de personas/vehículos,
tracking y zonas de intrusión sobre los substreams RTSP de los NVR.
Publica eventos al API de VisionCore, que los convierte en alertas
(campana + email) y los guarda para búsqueda forense.

## Stack y licencias (todo permisivo, sin AGPL)

| Componente | Rol | Licencia |
|---|---|---|
| [Roboflow Supervision](https://github.com/roboflow/supervision) | tracking (ByteTrack), zonas, anotación | MIT |
| YOLOX (pesos ONNX de Megvii) | detector de objetos COCO | Apache-2.0 |
| ONNX Runtime | inferencia CPU/GPU | MIT |
| OpenCV (headless) | captura RTSP y encoding JPEG | Apache-2.0 |
| FastAPI + Uvicorn | health/status HTTP | MIT / BSD-3 |

**Importante**: NO usar `ultralytics` (YOLOv8/v11) — es AGPL-3.0 y obliga a
liberar el código del sistema o pagar licencia comercial.

## Cómo funciona

1. Cada `REFRESH_INTERVAL_SEC` (60 s) lee del API la lista de cámaras con
   analítica habilitada (`GET /api/analytics/internal/cameras`, autenticado
   con `ANALYTICS_SECRET`).
2. Por cámara habilitada levanta un worker que muestrea el substream RTSP a
   `sampleFps` (2 fps por defecto — suficiente y barato).
3. Detección YOLOX → ByteTrack → filtro de clases/confianza → zonas
   poligonales (normalizadas 0-1, se dibujan en el frontend).
4. Evento nuevo (track nuevo o intrusión en zona, con cooldown por
   clase/zona) → `POST /api/analytics/internal/events` con snapshot JPEG
   anotado (cajas + zonas).

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `API_BASE_URL` | `http://api:4000` | API de VisionCore |
| `ANALYTICS_SECRET` | — | mismo valor que en el API (`openssl rand -hex 32`) |
| `MODEL_PATH` | `/models/yolox_s.onnx` | ruta del modelo (volumen) |
| `MODEL_URL` | release oficial YOLOX-S | se descarga si MODEL_PATH no existe |
| `INPUT_SIZE` | `640` | 640 (s/m) · 416 (tiny/nano) |
| `REFRESH_INTERVAL_SEC` | `60` | relectura de configs |
| `SNAPSHOT_MAX_WIDTH` | `1280` | ancho máx del JPEG enviado |

## ¿CPU o GPU?

**No hace falta GPU para empezar.** Con CPU:

- `yolox_tiny.onnx` (INPUT_SIZE=416): ~4-8 cámaras a 2 fps en 4 núcleos.
- `yolox_s.onnx` (640): ~2-4 cámaras a 2 fps en 4 núcleos, mejor precisión.

Con GPU NVIDIA (a partir de ~8-10 cámaras o más fps):

1. `requirements.txt`: `onnxruntime` → `onnxruntime-gpu` (misma licencia MIT)
2. Instalar `nvidia-container-toolkit` en el host
3. En `docker-compose.yml` agregar al servicio `analytics`:
   ```yaml
   deploy:
     resources:
       reservations:
         devices:
           - driver: nvidia
             count: 1
             capabilities: [gpu]
   ```
   ONNX Runtime detecta CUDA automáticamente (no hay que tocar código).

## Endpoints

- `GET /health` — healthcheck del contenedor
- `GET /status` — estado por worker: frames procesados, eventos enviados,
  errores RTSP
