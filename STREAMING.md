# VisionCore VMS — Arquitectura de Streaming

## Flujo de datos

```
NVR Hikvision (RTSP puerto 554)
  └─ MediaMTX — pull on-demand (sourceOnDemand: true)
       ├─ HLS  (puerto 8888) → nginx /hls/ → Navegador (hls.js)   ~6s latencia
       └─ WebRTC (puerto 8889) → red confiable / futuro relay     ~500ms latencia
```

MediaMTX se conecta al NVR sólo cuando hay un lector. VisionCore cierra la
sesión explícitamente al salir o cambiar de vista; `sourceOnDemandCloseAfter:
10m` es únicamente el GC de respaldo para una limpieza que no haya llegado.

---

## NVRs en producción

| IP | Canales | Descripción |
|---|---|---|
| <ip_nvr_1> | <n> | NVR principal |
| <ip_nvr_2> | <n> | NVR secundario A |
| <ip_nvr_3> | <n> | NVR secundario B |
| <ip_nvr_4> | <n> | NVR secundario C |

---

## Formato de URLs RTSP

```
# Stream principal (main) — alta resolución, H.264 o H.265
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/<canal>01

# Substream (sub) — resolución reducida, recomendado para web
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/<canal>02
```

**Ejemplo — Canal 3 del NVR `<ip_nvr>`:**
```
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/301   # main
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/302   # sub
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
5. Al salir/cambiar, el API retira la sesión; el cierre on-demand de 10 min es
   sólo una red de seguridad de MediaMTX

---

## Límites de concurrencia

Configurables en el contenedor `api` via variables de entorno:

| Variable | Default | Descripción |
|---|---|---|
| `MAX_STREAMS_PER_USER` | 16 | Streams simultáneos por usuario |
| `MAX_STREAMS_GLOBAL` | 50 | Streams simultáneos en total |
| `STREAM_IDLE_TIMEOUT` | 90 s | TTL de una sesión sin heartbeat de **cliente** |
| `STREAM_HD_IDLE_TIMEOUT` | 90 s | TTL de sesiones HD/transcodificadas (hereda el anterior si no se define) |

Ambos se acotan al rango 15–3600 s. El API registra al arrancar una línea con
los valores **efectivos**, porque el valor crudo del entorno no es
necesariamente el que rige:

```
stream_session_ttl_resolved standardTtlMs=90000 hdTtlMs=90000 requestedStandardSec=none requestedHdSec=none wasClamped=false
```

Las sesiones se almacenan en memoria; se pierden al reiniciar el API (intencional: el frontend reconecta).

### Vigencia de una sesión: tres conceptos distintos

Una sesión vive **sólo** mientras su cliente late. Estos tres datos existen por
separado y no pueden sustituirse entre sí:

| Concepto | Qué es | ¿Mantiene viva la sesión? |
|---|---|---|
| `lastClientHeartbeat` | Hora del **servidor** al recibir actividad explícita de un cliente autenticado | **Sí — es la única evidencia de espectador** |
| `lastMediaActivity` | Última actividad de medio observada sobre el path | No (diagnóstico) |
| `processAlive` | Si el proceso FFmpeg sigue corriendo | No (estado observado) |

El timestamp lo pone siempre el servidor: un valor enviado por el navegador no
es confiable.

> **Regresión histórica que esto corrige.** El limpiador renovaba el heartbeat
> cuando veía FFmpeg vivo, con lo que el proceso se justificaba a sí mismo: una
> sesión iniciada el 2026-08-10T12:38Z seguía "latiendo" el 2026-08-11T14:22Z
> (26 h) sin ningún espectador. Además contaba como demanda real en el monitor
> de pipeline y contribuía a generar `CAMERA_STREAM_ERROR` falsos.

### Ciclo de cierre

1. **Pestaña visible y player montado** → heartbeat periódico (30 s).
2. **`document.hidden`** → el heartbeat se **suspende**.
3. **Vuelve a ser visible antes del TTL** → heartbeat inmediato; la sesión se conserva.
4. **Oculta más que el TTL** → el servidor expira la sesión y libera su FFmpeg.
   Al volver se pide alta calidad **una sola vez**, respetando la capacidad, y
   mientras tanto sigue reproduciéndose la baja calidad (nunca pantalla negra).
5. **Desmontaje, cambio de cámara/layout, cierre explícito y `pagehide`** →
   cierre inmediato e idempotente con `fetch(..., { keepalive: true })` sobre
   `DELETE /api/cameras/:id/stream` o `DELETE /api/cameras/my-sessions`.
6. **TTL del servidor** → garantía final si nada de lo anterior llegó.

No se usa `navigator.sendBeacon`: no permite fijar `Authorization`, y poner el
token en la URL o en una cookie ad-hoc empeoraría la seguridad para resolver
algo que `keepalive` ya resuelve.

### Pertenencia: la sesión es de la PESTAÑA

La clave de una sesión es `(usuario, pestaña, cámara, tipo)`. Antes era
`(usuario, cámara, tipo)`, con lo que dos pestañas del mismo usuario viendo la
misma cámara colapsaban en una sola fila: la segunda se apropiaba de la primera
y cerrar en una cerraba la de la otra.

Todo arranque debe enviar su `viewId`. Si no lo hace, la sesión se registra bajo
`default` y su heartbeat de view nunca coincide, de modo que expira por
`view_heartbeat_missing` aunque el usuario la esté mirando.

Un cierre o un heartbeat **sin** `viewId` sólo se resuelve cuando la pertenencia
es inequívoca (una sola pestaña con esa cámara y tipo). Con varias, se rechaza y
se registra `stop_ignored_ambiguous` / `touch_ignored_ambiguous`: una pestaña no
puede cerrar la sesión de otra.

### Cierre durante un arranque en vuelo

Un arranque atraviesa varias operaciones asíncronas (consulta a la base,
`publishStream`, spawn de FFmpeg, `waitForHlsReady`, espera de un
`transcodeInFlight`). En cualquiera de ellas puede llegar el `pagehide`.

- `cleanupUserSessions(userId, viewId)` marca el cierre **siempre**, aunque
  todavía no exista ninguna sesión — ése era el hueco por el que nacía la sesión
  fantasma.
- El arranque vuelve a comprobar la cancelación después de cada etapa y justo
  antes de registrar, reutilizar o devolver una sesión.
- Si el view se cerró: no se registra nada, se resuelve el single-flight, y se
  deshace lo creado **sin** tocar lo que otro espectador válido siga usando.

### El supervisor no reinicia sin espectador

El supervisor de FFmpeg sólo re-spawnea si hay una sesión con heartbeat de
cliente fresco sobre ese `streamPath`, o un arranque en vuelo todavía válido.
`lastMediaActivity` **no** autoriza un reinicio: es diagnóstico.

### Procesos compartidos

Varias sesiones pueden compartir un mismo FFmpeg (mismo `streamPath`/perfil).
Al vencer o cerrarse una sesión sólo se termina el proceso si **no queda ningún
otro espectador válido** sobre ese path. La decisión se toma sobre el conjunto
completo de sesiones, no una por una.

---

## Evidencia C21: liberación frente a preparación

La validación real del 2026-09-01, con `MAX_TRANSCODE_SESSIONS=2`, separó los
dos tiempos que la interfaz antes hacía parecer uno solo:

- `exit_focus` terminó FFmpeg y el conteo bajó en el mismo segundo;
- una nueva solicitud ocupó el cupo en aproximadamente 0,1–0,2 s;
- `waitForHlsReady` tardó aproximadamente 5,1–6,8 s en producir HLS usable;
- al terminar la prueba el conteo quedó en cero.

Por tanto, reducir `STREAM_HD_IDLE_TIMEOUT` no acelera un cierre normal: sólo
debilitaría la red de seguridad ante pestañas o redes interrumpidas. C21 expone
por separado los gauges de capacidad y el histograma
`visioncore_live_transcode_hls_ready_seconds`.

## Configuración MediaMTX relevante

```yaml
# infra/mediamtx/mediamtx.yml
hlsVariant: fmp4            # Tolera B-frames/DTS reordenado del origen
hlsSegmentCount: 7          # Ventana de segmentos disponible
hlsSegmentDuration: 2s      # Latencia total ~6s
hlsMuxerCloseAfter: 10m
hlsAlwaysRemux: no          # Se genera bajo demanda
hlsAllowOrigin: "*"         # CORS abierto (el acceso real lo gestiona la API)

paths:
  ~^nvr_.*:
    sourceOnDemandStartTimeout: 15s   # Tiempo máx. para que el NVR responda
    sourceOnDemandCloseAfter: 10m     # GC de respaldo; el API cierra antes
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
  -d '{"source":"rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/101","sourceOnDemand":true}'

# Eliminar un stream
curl -X DELETE http://localhost:9997/v3/config/paths/delete/nvr_test
```

---

## Diagnóstico con ffprobe

```bash
# Script completo (prueba main + sub, muestra codec, resolución, FPS)
bash scripts/probe-camera.sh <ip_nvr> <canal> <usuario> <contraseña>

# Ejemplo: canal 5 del NVR principal
bash scripts/probe-camera.sh <ip_nvr> 5 <usuario> <contraseña>

# Prueba manual directa
ffprobe -v quiet -print_format json -show_streams \
  -rtsp_transport tcp \
  "rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/501"
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

El frontend web usa HLS por defecto. El cliente nativo previsto y su requisito
de relay autenticado se documentan en
[`docs/native/LIVE_CLIENT_ARCHITECTURE.md`](docs/native/LIVE_CLIENT_ARCHITECTURE.md).
