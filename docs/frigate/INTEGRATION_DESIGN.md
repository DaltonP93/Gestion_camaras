# Diseño de integración: Frigate → VisionCore (analítica)

> Estado: propuesta de diseño. Flag `FRIGATE_ENABLED=false` por defecto ⇒ sin
> cambios de comportamiento. No autoriza despliegue ni cambios de infra.
> Base: rama `claude/multi-agent-project-audit-hf14wq`.

## 1. Objetivo

Robustecer la analítica de VisionCore usando **Frigate** (NVR con detección de
objetos en tiempo real, MIT) como **fuente de eventos de detección**, para llenar
el dashboard de Analítica (hoy en cero por falta de productor de eventos).

## 2. Principio de diseño

Frigate **sustituye la etapa de detección** (YOLOX + ByteTrack del pipeline
Python) y reutiliza **todo el resto del contrato ya existente**:
- El endpoint receptor `POST /api/analytics/internal/events` (`apps/api/src/routes/analytics.ts:215`) **no cambia**.
- El `eventSchema` interno (`analytics.ts:73-87`) **no cambia**.
- La tabla `AnalyticsEvent` (`prisma/schema.prisma:560`) **no cambia**.
- El dashboard (`/summary`, `/events`) **no cambia**.

⇒ **Cero cambios en `apps/api`, DB y `apps/web`.** Solo se agrega un productor.

## 3. Ubicación: `apps/analytics` (Python)

Se elige Python (no TS) porque:
- El rol de "productor que hace POST a `/internal/events`" ya vive ahí
  (`pipeline.py:_post_event` L524-547) y se reutiliza tal cual.
- Se reutiliza la lógica pura de `rules.py` (CooldownTracker, TrackDedup,
  ZoneIntrusionTracker, occupancy) para derivar loitering/aforo/cruce.
- Integración MQTT/HTTP con Frigate es natural en Python (paho-mqtt/httpx).
- No agrega superficie nueva a `apps/api`.

## 4. Componentes nuevos (`apps/analytics/app/frigate/`)

| Módulo | Responsabilidad | Testeable |
|---|---|---|
| `normalize.py` | **puro**: dict de evento Frigate → payload interno (`eventSchema`) | ✅ unit |
| `camera_map.py` | **puro**: nombre-cámara-Frigate → `cameraId` VisionCore | ✅ unit |
| `derive.py` | **puro**: derivar `line_crossing`/`occupancy_limit` de zonas/tracks | ✅ unit |
| `client.py` | HTTP a Frigate (`GET /api/events`, snapshot) — I/O inyectable | ✅ (fakes) |
| `mqtt_consumer.py` | suscripción MQTT `frigate/events` — cliente inyectable | ✅ (fakes) |
| `ingestor.py` | orquesta: consume → normalize → derive → dedup/cooldown → POST | ✅ (fakes) |

Patrón: **núcleo puro testeable + I/O inyectable** (igual que N1/ONVIF).

## 5. Mapeo de campos (Frigate `after` → eventSchema)

| Frigate | Interno | Regla |
|---|---|---|
| `camera` | `cameraId` | vía `camera_map` (config `FRIGATE_CAMERA_MAP` o match por nombre) |
| `label` | `className` | person/car/truck/bus/motorcycle/bicycle; otros se descartan |
| (label) | `type` | person→`person`; vehículo→`vehicle`; `entered_zones`≠∅→`zone_intrusion`; dwell/`stationary`→`loitering` |
| `score`/`top_score` | `confidence` | 0–1 |
| `id` (string) | `trackId` | hash estable → int (local por cámara) |
| `current_zones`/`entered_zones` | `zoneName` | zona Frigate = zona VisionCore |
| derivado | `direction` in/out | `derive.py` con zonas de conteo |
| `id` | `incidentId` | `cam:zona:id` para correlacionar entrada/exit |
| `start_time`×1000 | `occurredAt` | ISO-8601 UTC `.000Z` |
| `/api/events/<id>/snapshot.jpg` | `snapshotJpegBase64` | descargar+base64 (opcional, `FRIGATE_FETCH_SNAPSHOTS`) |
| conteo tracks/zona | `occupancy_limit` | `derive.py` (Frigate no lo da directo) |

## 6. Transportes de ingest (seleccionable)

- **HTTP polling** (`FRIGATE_INGEST_MODE=http`, **default**): `client.py` consulta
  `GET /api/events?after=<cursor>&...` cada N seg. Sin broker nuevo. Idempotente
  por `id` de evento (dedup) para no re-POSTear.
- **MQTT** (`FRIGATE_INGEST_MODE=mqtt`): `mqtt_consumer.py` se suscribe a
  `frigate/events` (tiempo real). Requiere broker (Mosquitto). Procesa `type`
  new/update/end; emite en `end` (o `new` para intrusión inmediata).

Ambos convergen en `ingestor.py` → mismo POST.

## 7. Flags nuevas (`.env.example`, todas OFF/seguras)

```
FRIGATE_ENABLED=false                 # master switch del ingestor
FRIGATE_URL=http://frigate:5000       # API HTTP de Frigate
FRIGATE_INGEST_MODE=http              # http | mqtt
FRIGATE_POLL_INTERVAL_SEC=5           # solo http
FRIGATE_MQTT_HOST=                    # solo mqtt
FRIGATE_MQTT_PORT=1883
FRIGATE_MQTT_TOPIC=frigate/events
FRIGATE_CAMERA_MAP=                   # JSON {"frigate_cam":"<cameraId>"} opcional
FRIGATE_FETCH_SNAPSHOTS=true          # descargar snapshot del evento
FRIGATE_MIN_CONFIDENCE=0.6
FRIGATE_SUPPORTED_CLASSES=person,car,truck,bus,motorcycle,bicycle
```

Con `FRIGATE_ENABLED=false` el ingestor no arranca ⇒ comportamiento idéntico.
El native pipeline (YOLOX) y Frigate son **mutuamente excluyentes por cámara**
(evitar eventos duplicados): si una cámara está mapeada a Frigate, el worker
nativo no debe correr para ella (o se corre solo uno de los dos según deploy).

## 8. Seguridad

- Reutiliza `x-analytics-secret` (`ANALYTICS_SECRET`) para POSTear; sin nuevo
  canal privilegiado.
- **RBAC intacto**: los eventos entran por `cameraId`; el dashboard filtra por
  permisos de cámara como hoy.
- Frigate corre en red interna; su URL/MQTT no se exponen ni se loguean.
- No se versionan credenciales ni IPs. `FRIGATE_URL`/hosts vía env.
- **SSRF**: el ingestor solo llama a `FRIGATE_URL` fijo (no a URLs derivadas de
  input), así que la superficie SSRF es nula. Validar que `FRIGATE_URL` sea de
  configuración, nunca de un evento.

## 9. Despliegue (NO se aplica sin autorización)

Frigate necesita su **propio contenedor** + hardware de detección (Coral TPU
ideal; si no, GPU o CPU con pocas cámaras). Bloque de `docker-compose` propuesto
(a agregar SOLO con autorización, ver decisión pendiente):
- servicio `frigate` (imagen `ghcr.io/blakeblackshear/frigate:stable`), con su
  `config.yml`, apuntando a los substreams RTSP de los NVR, en la red interna.
- broker MQTT solo si `FRIGATE_INGEST_MODE=mqtt`.

El **código del ingestor se construye y testea sin tocar infra**. La conexión a
un Frigate real es paso de despliegue.

## 10. Plan de tests (compuerta Python + CI "Analytics")

- `test_normalize.py`: payloads Frigate reales → payload interno correcto (todos
  los tipos y clases; descartes; timestamps; hashing de trackId).
- `test_camera_map.py`: mapeo por config y por nombre; cámara desconocida → skip.
- `test_derive.py`: line_crossing in/out y occupancy desde transiciones de zona.
- `test_ingestor.py`: con cliente/mqtt fake y POST fake — dedup por id, cooldown,
  filtro de confianza/clase, no-POST cuando `FRIGATE_ENABLED=false`.
- Validar `docker compose config` si se añade el bloque (fase de despliegue).

## 11. Decisiones para el humano

1. ¿Ya corrés una instancia de Frigate (conectamos) o planificamos el despliegue
   desde cero (servicio + hardware de detección)?
2. Transporte: HTTP polling (default, sin broker) o MQTT (tiempo real, requiere
   broker). Recomendación: soportar ambos, default HTTP.
3. (Al desplegar) autorización para agregar el servicio `frigate` a
   `docker-compose.yml` y su `config.yml`.
