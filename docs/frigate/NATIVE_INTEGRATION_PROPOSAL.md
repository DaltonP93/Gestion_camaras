# Propuesta técnica — detección de eventos con Frigate dentro de VisionCore

> Estado: **PROPUESTA** (planificación). No autoriza portar código, desplegar ni activar flags.
> Fecha: 2026-10-07. Base del repo: `main` = `94305f32ddba17b697b8f28b5fe3ef5108b0bc2c`.

## 0. Resumen de la decisión propuesta

VisionCore sigue siendo **el producto**: login, roles, permisos por cámara, NVR, alertas, visores en
vivo y archivo. Frigate se usa como **motor interno de detección** (servicio aislado, sin acceso de
usuarios) y VisionCore consume sus eventos. La "integración nativa" es de **experiencia y datos**
(los eventos aparecen en la UI, el timeline y las alertas de VisionCore con sus permisos), **no** un
port del código de Frigate.

Se propone **no portar código** en las primeras etapas. Correr la imagen oficial fijada por digest
como servicio interno da las actualizaciones y correcciones de upstream sin mantener un fork en Python
grande. Portar un componente concreto (por ejemplo la lógica de *review*) se evaluaría recién después
de medir con NVR reales (E6), y sólo si hay una razón medible.

## 1. Referencia oficial fijada

| Campo | Valor |
|---|---|
| Repositorio | <https://github.com/blakeblackshear/frigate> |
| Tag | `v0.18.0` (última estable al 2026-10-07; posteriores sólo `-beta`/`-rc`) |
| Commit | `77a66e75c61862b048a07c1295877f4b31343504` |
| Imagen a usar | `ghcr.io/blakeblackshear/frigate:0.18.0` **fijada por digest `@sha256:`** al preparar E5 (el digest se registra entonces, verificado con `docker buildx imagetools inspect`). |
| Licencia del código | MIT (`LICENSE`, "Copyright (c) 2026 Frigate, Inc.") |
| Marca | `TRADEMARK.md`: "Frigate™", "Frigate NVR™", "Frigate+™" y el logo **no** están cubiertos por MIT |
| En el repo hoy | `docker-compose.yml` fija `frigate:0.14.1` bajo el profile `frigate` (no corre en producción) |

**Atribución y marca:**
- Si se copia código, el aviso MIT va **íntegro** junto al código copiado y en
  `THIRD_PARTY_NOTICES.md` (nuevo), con el tag y el SHA de origen.
- Sólo **uso referencial**: "detección con Frigate", "compatible con Frigate". No se usa "Frigate" en el
  nombre de una función o módulo de cara al usuario, no se usa el logo y no se sugiere afiliación.
- Usar la imagen oficial sin modificar no es un fork. Un fork modificado **debe renombrarse y quitar el
  logo** (§4 de su política de marca).

## 2. Requisitos que se mantienen (no negociables)

1. **Login, roles y permisos.** Toda lectura de eventos, snapshots y clips pasa por la API de
   VisionCore con `canView`/`canPlayback` por cámara. La UI (8971) y la API (5000) de Frigate nunca se
   exponen: red docker interna, sin puertos publicados, sin enlaces desde el navegador.
2. **NVR como única fuente del archivo completo.** Vivo y búsqueda/reproducción del archivo siguen
   saliendo de los NVR mediante el proveedor de grabaciones (#184). **El almacenamiento local de
   Frigate no es el archivo del NVR**: un clip de evento es evidencia derivada, corta y con retención
   propia.
3. **Sólo metadatos, snapshots y clips de eventos configurados** se guardan en el servidor, con cuota
   y retención explícitas. Sin grabación continua en el servidor.
4. **Credenciales**: el RTSP se arma en el servidor. El navegador nunca recibe credenciales ni abre
   RTSP.
5. **Alertas y notificaciones** se generan desde VisionCore (reglas por cámara/zona/clase con
   cooldown), no desde las notificaciones propias de Frigate (desactivadas).

## 3. Arquitectura

```
                 ┌──────────────────────── servidor VisionCore ────────────────────────┐
NVR Hikvision ──►│ MediaMTX (único puller RTSP por cámara analizada, substream)         │
  (RTSP)         │   │  rtsp interno, usuario de lectura por path (sin exponer)          │
                 │   ├──► Frigate (detector OpenVINO NPU/GPU, record = sólo eventos)     │
                 │   │       │ MQTT frigate/events, frigate/reviews (red interna)        │
                 │   │       ▼                                                           │
                 │   │   apps/analytics (ingestor existente, endurecido)                 │
                 │   │       │ POST /api/analytics/internal/events (secreto interno)      │
                 │   │       ▼                                                           │
                 │   └──► apps/api ── PostgreSQL (eventos, medios, retención)            │
                 │            │  ── almacén de medios de eventos (volumen con cuota)     │
                 │            ▼                                                          │
                 │        apps/web: lista de eventos + overlay en el timeline del NVR    │
                 └──────────────────────────────────────────────────────────────────────┘
```

**Decisiones clave:**

- **Una sola conexión RTSP por cámara analizada.** Los NVR limitan las sesiones remotas y el ancho de
  banda. Frigate **no** se conecta directo a los NVR: lee de MediaMTX (`rtsp://mediamtx:8554/...`),
  que ya es el puller de vivo. Hay que medir el impacto sobre las sesiones de vivo/playback (ver E6).
- **Prerrequisito de seguridad (bloqueante para E5).** En `main` (`94305f3`)
  `infra/mediamtx/mediamtx.yml` sigue con `authInternalUsers: - user: any` y permisos `api`, `read`,
  `publish` y `playback` **sin credenciales**: el aislamiento depende sólo de la frontera de red y del
  `auth_request` de nginx para `/hls/`. Antes de sumar un lector nuevo (Frigate) hay que crear
  usuarios internos por rol (lector de detección sólo con `read`, backend con `api`, sin `publish`
  anónimo), con credenciales desde el entorno y una prueba de CI que impida volver a `user: any`. Va
  como PR propio (E0.5).
- **Substream para detección** (Frigate no necesita el main). Ni el vivo ni el playback del usuario
  dependen de Frigate.
- **Grabación de Frigate en modo "sólo alertas"**: `continuous.days: 0`, `motion.days: 0`, y
  alertas/detecciones con `retain.mode: active_objects` y días acotados. Así sólo quedan clips de
  eventos, con pre/post-roll.
- **Los medios se copian a VisionCore.** El ingestor descarga snapshot y clip del evento por la API
  interna de Frigate y los guarda en el almacén de VisionCore, que los sirve con RBAC. La retención la
  controla VisionCore; el almacén de Frigate queda como caché efímera.
- **Mapeo de cámaras por id, no por nombre.** Hoy `FRIGATE_CAMERA_MAP` es nombre→`cameraId`. Se pasa
  a generar la config de Frigate desde la base (cámaras con detección habilitada) con
  `name = cameraId` estable, para que un renombre no rompa el mapeo.

## 4. Modelo de datos (propuesto)

Se reutiliza `AnalyticsEvent` (ya existe y tiene consumidores) con dos agregados, en lugar de crear
una tabla paralela:

- `source` (`'native' | 'frigate'`) y `externalId` (id de evento de Frigate), con
  `@@unique([source, externalId])` → **ingesta idempotente** (MQTT entrega *at-least-once*).
- `startedAt` / `endedAt` (ventana del evento) además de `occurredAt`.

Tabla nueva `EventMedia`: `eventId`, `kind` (`snapshot | clip`), `storageKey`, `bytes`, `sha256`,
`createdAt`, `expiresAt`, `deletedAt`. Así la cuota se calcula con `SUM(bytes)` y la retención borra
por `expiresAt`, registrando qué se borró (invariante 1: nunca perder evidencia sin registro).

**Reloj.** El timeline del NVR está en la hora de pared del NVR y los eventos de Frigate en UTC del
servidor. Se guarda el **offset medido por NVR** (ISAPI `/System/time` contra el reloj del servidor)
para alinear los overlays. Si el desvío supera un umbral, el timeline muestra que la alineación no es
fiable.

## 5. Timeline y reproductor

- El timeline sigue construyéndose con el **proveedor NVR** (`nvrRecordingProvider`, #184).
- Los eventos se dibujan como **marcas sobre el timeline del NVR** (cámara + ventana alineada). Al
  hacer clic se pide al proveedor el archivo **del NVR** en `startedAt − preRoll`, no el clip local.
- El clip local se ofrece aparte como **"Clip del evento"**, rotulado como evidencia derivada, con su
  propia expiración visible.
- No se asume que el clip local equivale al archivo del NVR. Si el NVR no tiene grabación en esa
  ventana (hueco, disco lleno), el timeline lo muestra como hueco aunque exista el clip local.

## 6. Etapas (PR Draft pequeños) y criterios de aceptación

Cada etapa es un PR Draft independiente, con CI 11/11 y sin cambios de producción.

**E0 — Esta propuesta y la referencia fijada** (sólo docs).
- Aceptación: revisión de arquitectura aprobada; tag/SHA/licencia/marca registrados.

**E0.5 — Autenticación interna de MediaMTX** (prerrequisito de E5).
- Usuarios internos por rol en lugar de `user: any`; credenciales sólo por entorno; guard de CI.
- Aceptación:
  - una lectura RTSP o HLS interna sin credenciales es rechazada;
  - vivo y playback de VisionCore siguen funcionando (e2e y smoke en staging);
  - rollback documentado.

**E1 — Proveedor NVR (#184) y criterios de #180/#181 sobre la interfaz.**
- Portar a la interfaz del proveedor las pruebas de #181 (`recordings-continuity.spec.ts`: relevo sin
  corte, timer basado en `currentTime` real, pausa y buffering no avanzan, seek rearma) y de #180 (1×1
  en alta calidad) como **especificaciones** contra un controlador nuevo, sin cambiar el
  comportamiento actual.
- Aceptación: e2e Playwright de continuidad, buffering, seek, pausa, velocidad (0.5×/1×/2×/4×), cambio
  de cámara, multicámara 2×2, revocación de permiso a mitad de sesión (la siguiente petición da 403 y
  se libera la sesión) y límite de sesiones (cola/admisión visible, sin fugas). Todo verde con NVR
  simulado.

**E2 — Almacén de eventos (sin Frigate).**
- Migración aditiva (`source`, `externalId`, `startedAt/endedAt`, `EventMedia`), API de lectura con
  RBAC, job de retención con cuota y fixtures.
- Aceptación:
  - pruebas IDOR (cámara ajena → 403 o lista vacía, también para medios);
  - la cuota no se excede (cuando hace falta, se borra lo más viejo y queda registrado);
  - la migración pasa contra PostgreSQL real en CI;
  - rollback documentado.

**E3 — Ingestor endurecido.**
- Idempotencia por `externalId`, mapeo por `cameraId`, descarga de medios con límite de tamaño y
  timeout, verificación de tipo, sin seguir redirecciones, sólo hosts internos.
- Aceptación:
  - un evento duplicado no crea filas;
  - un clip corrupto o vacío no se guarda;
  - el ingestor caído no pierde eventos más allá del buffer documentado;
  - pruebas con fixtures de MQTT de `v0.18.0`.

**E4 — UI: eventos y overlay en el timeline del NVR.**
- Aceptación:
  - clic en un evento → el reproductor del NVR busca la ventana correcta (±1 s con offset medido);
  - el clip local se muestra rotulado;
  - un usuario sin permiso no ve el evento ni su miniatura.

**E5 — Servicio Frigate en el hardware nuevo (staging aislado).**
- `0.18.0` fijado por digest, profile `frigate`, detector OpenVINO (NPU para detección y GPU/VA-API
  para decodificar), lectura desde MediaMTX y notificaciones de Frigate apagadas.
- Aceptación: arranca sin acceso externo; consumo de CPU, GPU y NPU medido con N cámaras de prueba.

**E6 — Medición con NVR reales (piloto).**
- Mismo rango y cámaras antes/después: sesiones RTSP por NVR, latencia de vivo, tiempo al primer
  frame del playback, uso de recursos y falsos positivos por cámara.
- Aceptación: no se declara mejora sin estas cifras. Las reglas de alerta se habilitan cámara por
  cámara.

**Port de componentes** (opcional, después de E6): sólo con una justificación medida, con atribución
MIT y una etapa propia.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Límite de sesiones RTSP del NVR | MediaMTX como único puller; medir en E6; substream |
| Desalineación del reloj NVR/servidor | Offset medido por NVR; aviso en la UI |
| Llenado de disco por clips | Volumen dedicado con cuota, retención por `expiresAt`, alertas al 80/90 % |
| MediaMTX con `user: any` | E0.5 antes de E5 |
| Exposición de la UI o API de Frigate | Sin puertos publicados; red interna; test en CI que verifica que compose no publica 5000/8971 |
| Divergencia con upstream | Imagen oficial por digest; actualización deliberada con pruebas de E3 |
| Eventos duplicados o perdidos (MQTT) | Idempotencia por `externalId`; métricas de ingesta |

## 8. Fuera de alcance de esta propuesta

Reconocimiento facial, LPR de Frigate, búsqueda semántica y GenAI. Si se quieren, cada uno lleva su
propia evaluación de privacidad, hardware y consentimiento.
