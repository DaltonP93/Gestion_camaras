# Despliegue de Frigate para VisionCore (runbook)

> Perfil elegido: **desplegar desde cero · ingest HTTP polling · detector CPU**.
> Frigate corre como servicio **opt-in** bajo el compose profile `frigate`: el
> `docker compose up` por defecto NO lo levanta (comportamiento del stack idéntico).
> Este runbook lo ejecutás **vos en el servidor**; no se corre desde el repo.
>
> Regla dura: nunca versionar IPs internas, usuarios ni contraseñas. El config real
> (`infra/frigate/config.yml`) está gitignored; solo se versiona la plantilla.

## 0. Qué hace esta integración

Frigate hace la detección de objetos (personas/vehículos/zonas) sobre los
substreams RTSP de tus NVR y expone eventos por su API HTTP. El **ingestor** de
`apps/analytics` (flag `FRIGATE_ENABLED`) consulta `GET /api/events` de Frigate,
normaliza cada evento al esquema interno y lo POSTea a
`/api/analytics/internal/events` (el mismo que ya alimenta el dashboard). Así el
dashboard de Analítica (hoy en cero) se llena. **No cambia** API/DB/web.

## 1. Prerrequisitos

- Servidor con Docker + Docker Compose y CPU disponible (el detector CPU limita
  el nº de cámaras/FPS; para más carga ver §7 Coral/GPU).
- Acceso RTSP a los NVR (substreams) desde el server de Frigate.
- El stack de VisionCore ya operativo.

## 2. Configurar Frigate (sin secretos en el repo)

```bash
cp infra/frigate/config.example.yml infra/frigate/config.yml
# Editá infra/frigate/config.yml: por cada cámara, poné <NVR_IP>, <RTSP_USER> y
# el canal correcto (Streaming/Channels/<NN>02 = substream). NO escribas la
# contraseña: se inyecta por {FRIGATE_RTSP_PASSWORD} desde el entorno.
```

## 3. Variables de entorno (archivo `.env` del stack, gitignored)

```dotenv
# Contraseña RTSP de las cámaras (usada por {FRIGATE_RTSP_PASSWORD} en el config)
FRIGATE_RTSP_PASSWORD=<pass-rtsp>
# Memoria compartida de Frigate (subir con muchas cámaras). Default 256mb.
FRIGATE_SHM_SIZE=256mb

# ── Ingestor (apps/analytics) ──
FRIGATE_ENABLED=true
FRIGATE_URL=http://frigate:5000        # red docker interna (no publicar 5000)
FRIGATE_INGEST_MODE=http               # HTTP polling (sin broker)
FRIGATE_POLL_INTERVAL_SEC=5
FRIGATE_FETCH_SNAPSHOTS=true
FRIGATE_MIN_CONFIDENCE=0.6
FRIGATE_SUPPORTED_CLASSES=person,car,truck,bus,motorcycle,bicycle
# Mapeo nombre-de-cámara-Frigate -> cameraId de VisionCore (JSON):
FRIGATE_CAMERA_MAP={"camara_ejemplo":"<cameraId-de-VisionCore>"}

# La analítica exige este secreto para ingestar (openssl rand -hex 32).
# Si está vacío, /internal/events responde 503 y NO entra nada.
ANALYTICS_SECRET=<secreto-compartido>
```

> El `cameraId` de VisionCore lo sacás de la gestión de cámaras (o de la DB
> tabla `cameras`). El nombre de cámara de Frigate es la clave del bloque
> `cameras:` en `config.yml`.

## 4. Levantar SOLO Frigate (profile opt-in)

```bash
docker compose --profile frigate up -d frigate
docker compose logs -f frigate         # verificá que arranca y detecta
```

La UI autenticada queda en `http://127.0.0.1:8971` (solo localhost del server;
tunelizá por SSH si la necesitás). La API interna (5000) NO se publica: solo la
alcanza el contenedor de analytics por la red docker.

## 5. Activar el ingestor

El servicio `analytics` toma las `FRIGATE_*` del `.env`. Recreá analytics para
que lea la nueva config y arranque el ingestor:

```bash
docker compose up -d analytics
docker compose logs analytics | grep -i frigate   # "frigate_ingestor_boot ..."
```

Con `FRIGATE_ENABLED=true`, las cámaras mapeadas a Frigate NO corren el worker
YOLOX nativo (exclusión mutua, evita eventos duplicados).

## 6. Verificación

1. En la UI de Frigate (8971) confirmá que cada cámara muestra imagen y detecta.
2. Generá movimiento frente a una cámara (persona/vehículo).
3. En VisionCore → **Analítica**: las tarjetas (Personas, Vehículos, Tracks,
   etc.) deben empezar a contar; en **Eventos/Snapshots** deben aparecer eventos
   con snapshot.
4. Si no aparecen: revisá `docker compose logs analytics` (errores de POST,
   `ANALYTICS_SECRET`, o cámara sin mapear en `FRIGATE_CAMERA_MAP`).

## 7. Cambiar el detector (más rendimiento)

En `infra/frigate/config.yml`, sección `detectors:`
- **Coral TPU (USB/PCIe):**
  ```yaml
  detectors:
    coral:
      type: edgetpu
      device: usb   # o pci
  ```
  y en docker-compose (servicio `frigate`) agregá el passthrough del dispositivo
  (`devices: ["/dev/bus/usb:/dev/bus/usb"]` para USB).
- **GPU NVIDIA:** detector `tensorrt` + `runtime: nvidia` / `deploy.resources`
  con la GPU, y `hwaccel_args` de NVDEC. Ver docs de Frigate.

## 8. Rollback (comprobable)

```bash
docker compose stop frigate && docker compose rm -f frigate   # baja Frigate
# y en .env: FRIGATE_ENABLED=false ; luego:
docker compose up -d analytics                                  # ingestor OFF
```

Con `FRIGATE_ENABLED=false` el ingestor no arranca y el sistema vuelve al estado
previo (las cámaras vuelven al worker nativo si estaban mapeadas). El profile
`frigate` no se levanta en el `up` por defecto.

## 9. Seguridad (recordatorio)

- No publiques el 5000 de Frigate ni go2rtc a la red externa; solo red docker.
- La UI (8971) atada a loopback; accedé por SSH tunneling.
- `infra/frigate/config.yml` y `.env` son gitignored: nunca los commitees.
- La contraseña RTSP va por env (`FRIGATE_RTSP_PASSWORD`), no en el config.
