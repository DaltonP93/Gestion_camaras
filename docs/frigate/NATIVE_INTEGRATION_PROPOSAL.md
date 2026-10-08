# Propuesta técnica — adaptación nativa de Frigate dentro de VisionCore

> Estado: **PROPUESTA** (planificación). No autoriza portar código, desplegar, instalar ni activar flags.
> Revisión 3 — 2026-10-08 (alcance definitivo: toda la configuración, no sólo detección). Base del repo:
> `main` = `94305f32ddba17b697b8f28b5fe3ef5108b0bc2c`.
> Matriz de pantallas y funciones: `docs/frigate/SCREEN_FUNCTION_MATRIX.md`. Plan de pruebas:
> `docs/frigate/PLAYER_TEST_PLAN.md`. Migración: `docs/runbooks/migration-dell-pro-slim.md`.
> Prototipo navegable con datos simulados: PR #188 (`apps/web/prototype`).

## 0. Alcance pedido (definitivo, revisión 3)

Adaptar **de forma nativa dentro de VisionCore** la **interfaz y la organización de configuración de
Frigate**, aplicadas a **todas** las funciones existentes de VisionCore —administración, seguridad y
NVR— y a las nuevas de eventos y detección. La configuración nueva **no se limita a detección**.

Pantallas y funciones cubiertas (detalle por función, permisos y fuente de datos en
`SCREEN_FUNCTION_MATRIX.md`):

1. **Vivo configurable** (grilla, calidad automática, foco, PTZ, actividad en el mosaico);
2. **visores personales y compartidos**;
3. **reproducción multicámara sincronizada** (reloj común, timeline, pistas archivadas, huecos, límites);
4. **configuración general** (sistema, apariencia, preferencias de interfaz, mantenimiento);
5. **NVR y cámaras**;
6. **usuarios, roles y permisos por cámara**, **seguridad** y **auditoría**;
7. **alertas, SMTP y canales** (Slack, Teams, webhook);
8. **eventos** (revisión, snapshots y clips);
9. **detección** (objetos, zonas, máscaras, ventana del evento, retención).

Se mantienen sin cambios de dueño:

- **Login, roles y permisos por cámara de VisionCore.** Nada de la UI ni de la autenticación de Frigate queda expuesto al usuario. La adaptación **no amplía** permisos salvo lo que apruebe la política única (`docs/security/PERMISSIONS_POLICY.md`): por indicación del dueño, visores personales para todos los roles dentro de sus cámaras autorizadas; y la exportación pasa a exigir un permiso propio (D5). Mientras tanto, cada sección aplica los `authorize([...])` actuales de la API (§2.3).
- **NVR y visores de VisionCore.**
- **El archivo completo existe exclusivamente en los NVR.** Vivo, búsqueda y reproducción del archivo salen siempre del NVR.
- **Almacenamiento local limitado a los eventos configurados**: metadatos, snapshots y clips de la ventana de cada evento, con cuota y retención. Sin grabación continua en el servidor.

Frigate se usa como **motor de detección** en un servicio interno, sin acceso de usuarios. Lo que se adapta a VisionCore es su **experiencia**: organización de la configuración, patrones y componentes de UI, y modelos de datos de eventos. El motor de detección en Python **no se porta**.

## 1. Referencia oficial fijada

| Campo | Valor |
|---|---|
| Repositorio | <https://github.com/blakeblackshear/frigate> |
| Tag | `v0.18.0` (última estable al 2026-10-07; posteriores sólo `-beta`/`-rc`) |
| Commit | `77a66e75c61862b048a07c1295877f4b31343504` |
| Licencia del código | MIT (`LICENSE`, "Copyright (c) 2026 Frigate, Inc.") |
| Marca | `TRADEMARK.md`: "Frigate™", "Frigate NVR™", "Frigate+™" y el logo **no** se licencian con MIT |
| Imagen del motor | `ghcr.io/blakeblackshear/frigate:0.18.0`, fijada por digest `@sha256:` al preparar la etapa E7 |
| En el repo hoy | `docker-compose.yml` fija `frigate:0.14.1` bajo el profile `frigate` (no corre en producción) |

**Atribución y marca para todo componente portado:**
- Cabecera en cada archivo portado: `Adaptado de Frigate v0.18.0 (77a66e7), <ruta original>, MIT`.
- Aviso MIT íntegro en `THIRD_PARTY_NOTICES.md` (nuevo).
- Nombres propios en la UI ("Detección", "Eventos", "Zonas"). "Frigate" sólo aparece como referencia técnica ("motor de detección: Frigate"), sin logo y sin sugerir afiliación.
- Un componente adaptado no es un fork distribuido. Si algún día se distribuyera una imagen modificada del motor, habría que renombrarla y quitar el logo (§4 de su política de marca).

## 2. Inventario: reutilizable, a adaptar o no reutilizable

Todas las rutas son de Frigate `v0.18.0`. Las diferencias de stack condicionan la estrategia de reutilización.

| | Frigate `v0.18.0` | VisionCore |
|---|---|---|
| UI | React **19** | React **18.3** |
| Estado y datos | SWR + API propia | Zustand + `@/lib/api` (cookie + CSRF) |
| Textos | i18next | Textos en español, sin i18n |
| Editor de zonas | `react-konva` 19 (requiere React 19) | — |
| Vivo | go2rtc (MSE, WebRTC, JSMpeg) | MediaMTX (HLS; WebRTC no expuesto) |
| Grabaciones | HLS VOD de su propio almacenamiento | NVR vía ISAPI/RTSP → FFmpeg → fMP4/MP4 (`nvrRecordingProvider`, PR #184; aún no en `main`) |

### 2.1 Web (`web/src/…`)

**Timeline** (`components/timeline/`): `ReviewTimeline.tsx`, `EventReviewTimeline.tsx`, `MotionReviewTimeline.tsx`, `EventSegment.tsx`, `SummaryTimeline.tsx`, `VirtualizedEventSegments.tsx`, y los hooks `use-timeline-utils` y `use-draggable-element`.
- **Decisión: portar con adaptación.** Es el componente de mayor valor. Hoy dependen de Radix tooltip, `react-device-detect`, `react-i18next` y los tipos `@/types/review`.
- **Adaptaciones:**
  - la fuente de datos pasa de SWR/API de Frigate a un **proveedor de timeline** que combina bloques de grabación del NVR (`nvrRecordingProvider.search`) con eventos del almacén de VisionCore;
  - los textos se reemplazan por textos en español;
  - el eje se alinea con el **reloj del NVR** (offset por NVR, §6);
  - los huecos del NVR se pintan como huecos aunque exista un clip local.

**Controles de reproducción** (`components/player/VideoControls.tsx`).
- **Decisión: portar con adaptación.**
- **Adaptaciones:**
  - quitar `FrigatePlusIcon` y la marca;
  - conectar la pausa, el seek y la velocidad al **controlador de reproducción NVR** (§5), no directo al elemento `<video>`. El seek dentro del archivo NVR implica una nueva sesión en el backend; no es un `currentTime` local.

**Reproductor HLS** (`components/player/HlsVideoPlayer.tsx`).
- **Decisión: usarlo de referencia, no portarlo.** Está acoplado a SWR, `axios`, la configuración de Frigate, `ObjectTrackOverlay` y la persistencia de usuario.
- El reproductor de grabaciones de VisionCore consume sesiones fMP4/MP4 del NVR, no HLS VOD de Frigate. Se toma su manejo de buffering y de errores de `hls.js` para el **vivo**.

**Vivo** (`LivePlayer.tsx`, `MsePlayer.tsx`, `WebRTCPlayer.tsx`, `JSMpegPlayer.tsx`).
- **Decisión: no reutilizable tal cual.** Hablan el protocolo y la API de go2rtc.
- El vivo de VisionCore sigue con MediaMTX (HLS detrás de `auth_request`). Se adopta la UX de Frigate (indicadores de actividad, chips de objetos detectados), alimentada por eventos de VisionCore.

**Editor de zonas y máscaras** (`components/settings/ZoneEditPane.tsx`, `MotionMaskEditPane.tsx`, `ObjectMaskEditPane.tsx`, `PolygonCanvas.tsx`, `PolygonDrawer.tsx`, `utils/canvasUtil`).
- **Decisión: portar con adaptación sobre React 18** — ver §2.4 (prueba de compatibilidad).
- VisionCore ya tiene un editor SVG mínimo (`apps/web/src/pages/AnalyticsPage.tsx:706-744`: agrega puntos con clic y cierra la zona; sin arrastre de vértices, deshacer ni táctil). El port lo reemplaza.
- **Adaptaciones:**
  - persistir en `CameraAnalyticsConfig.zones`/`lines` (ya existen) en lugar del `config.yml` de Frigate;
  - validar con zod en la API.

**Formulario de configuración** (`components/config-form/*`, `sectionConfigs.ts`).
- **Decisión: tomar el modelo de secciones, no el motor RJSF.** RJSF (`@rjsf/*`) se alimenta del JSON Schema único de Frigate (`GET /config/schema.json`); VisionCore no tiene un documento de configuración único: cada dominio tiene su endpoint, su tabla y su validación zod en la API.
- Se adopta la **configuración declarativa por sección** (orden y grupos de campos, campos avanzados, mensajes condicionales, "requiere reinicio") con formularios propios. Ver §2.3.

**Vistas de eventos y exploración** (`views/events`, `views/explore`, `views/search`).
- **Decisión: portar la estructura de vista**: lista y filtros por cámara, clase, zona y fecha.
- Los datos salen de la API de eventos de VisionCore, con RBAC. La búsqueda semántica queda fuera (§10).

### 2.2 Backend (`frigate/…`)

| Módulo | Decisión | Motivo |
|---|---|---|
| `frigate/config/*` (modelos pydantic) | Consumir, no portar | Se usa como **contrato** para generar y validar el `config.yml` que produce VisionCore (validación en CI contra el esquema de `v0.18.0`) |
| `frigate/review/*`, `frigate/events/*` | Usar de referencia | Semántica de *review segments* y de eventos (alert/detection, `start_time`/`end_time`) para el modelo de VisionCore |
| `frigate/record/*` | Usar de referencia | Lógica de retención y de limpieza de emergencia; VisionCore aplica cuota propia (§7) |
| `frigate/motion`, `frigate/track`, `frigate/detectors`, `frigate/object_detection` | **No portar** | Es el motor. Corre en el contenedor oficial |
| `frigate/api/*` | No portar | VisionCore expone su propia API con RBAC; la API de Frigate queda interna |

### 2.3 Organización de la configuración (alcance definitivo)

Referencia: `web/src/pages/Settings.tsx` de Frigate (`allSettingsViews`, 61 claves en 9 grupos:
general, globalConfig, cameras, enrichments, system, users, notifications, frigateplus, maintenance;
`Settings.tsx:307-453`). Se adopta su **organización y sus patrones**, con **todas** las funciones
de VisionCore reubicadas en ella:

| Grupo en VisionCore | Secciones | Origen hoy en VisionCore | Patrón de Frigate |
|---|---|---|---|
| Sistema | General (sitio, zona horaria, idioma), Apariencia, Sistema y mantenimiento, Preferencias de interfaz (por usuario) | `SettingsPage` (pestañas Sistema/Streaming **no persisten**, `SettingsPage.tsx:229-231`), `AppearancePage`, `/api/health`, `/api/admin/diagnostics/*` | `uiSettings`, `systemUi`, `maintenance` |
| Dispositivos | NVR (alta, credenciales, sync, salud, usuarios del NVR, reinicio, capacidades de grabación), Cámaras (nombre, streams, códec, audio, PTZ habilitado, alertas por cámara) | `NVRsPage`, `NVRDetailPage` (pestañas), `/api/nvrs/*`, `/api/cameras/*`, ISAPI | `cameraManagement` + asistente (`CameraWizardDialog`), selector de cámara por sección |
| Acceso | Usuarios, Permisos por cámara/NVR, Seguridad (`SecuritySettings`, step-up), Auditoría | `UsersPage`, `UserPermissionsModal`, `SettingsPage` (Seguridad), `ActivityPage` | `users`, `roles` (tabla + diálogos), `systemAuthentication` |
| Notificaciones | Alertas (tipos, severidad), Correo y canales (SMTP, Slack, Teams, webhook, prueba, historial de entregas) | `SettingsPage`/`AlertSettings`, `/api/alerts/settings*` | `notifications` |
| Vivo | Visores (personales/compartidos), streaming por cámara | `ViewsPage`, `/api/views` | grupos de cámaras (sólo la UI; el modelo y la ACL siguen siendo de VisionCore) |
| Análisis | Detección (objetos, umbrales), Zonas y máscaras, Movimiento, Eventos y almacenamiento (ventana, retención, cuota) | `AnalyticsPage` (config), `/api/analytics/config/:cameraId` | `cameraDetect`, `cameraObjects`, `masksAndZones`, `motionTuner`, `cameraReview`, `cameraSnapshots`, `cameraRecording` |

**Patrones reutilizados:** página por sección con encabezado y "Modificado"; formulario por sección con
**cambios sin guardar · Guardar · Deshacer**; cambios pendientes que sobreviven al cambiar de sección
con **Guardar todo** que informa éxito **parcial** (en VisionCore no puede ser atómico entre dominios);
mensajes condicionales (p. ej. "el NVR no grabó subflujo"); selector de cámara por sección;
navegación de tablet explícita (Frigate sólo tiene móvil y escritorio, y sus e2e no cubren tablet).

**No se copia:** `useIsAdmin()` (devuelve `true` si el rol es `undefined`: fail-open,
`hooks/use-is-admin.ts:4-9`); el diálogo de "cambios sin guardar" que nunca se abre
(`Settings.tsx:675`); el filtro "no admin ⇒ sólo 2 vistas" (`Settings.tsx:480`): VisionCore necesita
una **tabla sección × rol** derivada de los `authorize([...])` (el prototipo #188 la implementa en
`prototype/model/permissions.ts`); perfiles de Frigate, Frigate+, go2rtc, MQTT, birdseye, audio,
reconocimiento facial, LPR del motor y enriquecimientos (fuera de alcance o sin equivalente).

**Hallazgos que condicionan la reubicación** (detalle y evidencia en la matriz):
- `UserFeaturePermissions` (`canManageNVRs`, `canManageCameras`, `canManageUsers`, `canManageViews`, `canManageSettings`…) se guarda pero **casi ningún endpoint lo consulta**; la matriz se basa en `authorize([...])`, no en esos flags.
- La UI y la API no coinciden en varios puntos (p. ej. `/nvrs` permite SUPERVISOR pero la barra lateral sólo lo muestra a ADMIN; el panel PTZ se oculta a OPERATOR con `canPtz`; la API de eventos admite AUDITOR pero la ruta web no).
- Hay pestañas que **aparentan** guardar y no persisten (Streaming, Sistema). No se presentan como configurables hasta tener backend.

### 2.4 Editor de zonas con React 18 — prueba de compatibilidad y decisión

**Decisión: adoptar el editor de Frigate con React 18.3 + `react-konva` 18.2.16 + `konva` 10.2.3,
sin actualizar VisionCore a React 19.** Implementado en el prototipo (#188,
`apps/web/prototype/vendor/frigate` y `prototype/zones`).

Prueba realizada (2026-10-08, proyecto aislado con npm real y Chromium 141; evidencia en la
descripción de #188):

| Variante | `npm ls --all` | `tsc` | `vite build` | Playwright (8 casos: ratón, táctil CDP, lista, re-escalado) |
|---|---|---|---|---|
| React 18.3.1 + react-konva 18.2.16 + konva 9.3.22 | 0 | 0 | ok | 8/8 |
| React 18.3.1 + react-konva 18.2.16 + konva 10.2.3 | 0 | 0 | ok | 8/8 |
| Control: React 19.2.4 + react-konva 19.2.3 + konva 10.2.3 | 0 | 0 | ok | 8/8 |
| Negativo: React 18 + react-konva 19 | ERESOLVE | — | — | 0/8 ("only compatible with React 19") |
| Negativo: React 19 + react-konva 18 | **1** (sólo `--all`) | 0 | ok | 0/8 (`ReactCurrentOwner`) |

- **Por qué funciona:** los 4 componentes (`PolygonCanvas`, `PolygonDrawer`, `PolygonItem`,
  `PolygonEditControls`) y sus 19 dependencias internas **no usan ninguna API exclusiva de React 19**
  (`use()`, `useActionState`, `<Context>` como provider, `ref` como prop de componente función,
  limpieza de refs). Los `ref` van a nodos de react-konva (`Stage` es `forwardRef` en 18 y 19).
  `useSyncExternalStore` es de React 18. El estado final de las 8 pruebas es **idéntico byte a byte**
  entre las tres pilas válidas.
- **Por qué konva 10 y no 9:** el peer de react-konva 18 acepta `konva ^10.0.0` desde 18.2.13;
  mismo comportamiento, 1.6 kB gzip menos, es la versión de Frigate, la rama 9 no publica desde
  2025-07 y konva 9 no se importa en Node puro (`require("canvas")`).
- **Por qué no React 19 ahora:** subir React es un cambio transversal (react-router, Radix, recharts,
  react-grid-layout, pruebas del vivo y de grabaciones) sin beneficio para el editor; el código del
  editor no cambia entre pilas, así que migrar después es aislado.
- **Controles de que la prueba no es trivial:** 8 de 8 defectos inyectados detectados (índice de
  arrastre, orden de deshacer, `onTouchStart`, re-escalado, cierre, umbral de ajuste, URL de borrado,
  límite del lienzo).
- **Condiciones (implementadas en #188):** versiones fijadas exactas; prueba que exige la misma versión
  mayor de React y react-konva; `npm ls --all` en CI (el `npm ls` simple **no** detecta react-konva 18
  sobre React 19); el editor se carga diferido (~93 kB gzip sólo al abrir la sección; el build de la
  app no incluye konva); código portado idéntico al original con verificación por hash; sustitutos
  de VisionCore para WebSocket, i18n e íconos.
- **Riesgos:** react-konva 18 recibe parches pero la línea principal es 19 (19.3 exige React ^19.3);
  konva 11 probablemente no entre en el peer de la 18; iPadOS/Safari, pinch-zoom y hardware táctil
  real no se probaron (sólo Chromium con eventos táctiles CDP); el área sensible de un vértice es
  chica para un dedo y el borrado de vértice con clic derecho no existe en táctil.

## 3. Arquitectura

```
NVR Hikvision ──RTSP──► MediaMTX ──RTSP (lector "detección")──► motor Frigate (interno)
     │                     │  ▲                                     │ MQTT/API interna
     │                     │  └─ FFmpeg transcode HEVC→H264 (publica, usuario "api")
     │                     └──HLS──► nginx /hls/ (auth_request) ──► navegador (vivo)
     │                                                              │
     └──ISAPI/RTSP──► API VisionCore (búsqueda, preview, playback, FFmpeg) ◄── eventos ┘
                          │  RBAC, sesiones, revocación, cuota y retención de eventos
                          └──► PostgreSQL (eventos, medios) + volumen dedicado de medios
```

Decisiones:
- **Fuente única por cámara:** el motor lee de MediaMTX, nunca directo del NVR, para no sumar sesiones RTSP.
- **VisionCore es la fuente de verdad de la configuración.** La API genera el `config.yml` del motor desde la base (cámaras con detección habilitada, zonas, objetos, retención) y lo valida contra el esquema de `v0.18.0`. Se aplica sólo en staging, y en producción con autorización. Ningún usuario edita el `config.yml` a mano.
- **Ingesta de eventos:** el ingestor existente (`apps/analytics/app/frigate/`) se endurece:
  - idempotencia por id de evento;
  - mapeo por `cameraId` (el `name` de la cámara en el motor = `cameraId`), no por nombre libre como hoy (`FRIGATE_CAMERA_MAP`).

## 4. MediaMTX según sus consumidores reales (prerrequisito de seguridad)

Hoy `infra/mediamtx/mediamtx.yml` tiene `authInternalUsers: - user: any` con `api`, `read`, `publish` y `playback` **sin credenciales**. El aislamiento depende de la red docker, del loopback del host y del `auth_request` de nginx.

| Consumidor real (código actual) | Acción en MediaMTX | Origen | Usuario propuesto |
|---|---|---|---|
| Navegador → nginx `/hls/` → `mediamtx:8888` | `read` (HLS) de `nvr_*` | contenedor nginx | `nginx-hls`: `read` sólo `~^nvr_`. nginx agrega `Authorization` hacia el upstream **después** de `auth_request`; la credencial se inyecta por entorno en la plantilla de nginx, nunca versionada |
| API: control `:9997` (`publishStream`, `listRegisteredConfigPaths`, paths/list, `source-lifecycle`) | `api` | contenedor api | `api-control`: `api` (y `metrics` si se usa) |
| API: FFmpeg de transcode HEVC→H264 → `rtsp://mediamtx:8554/<path>` | `publish` | contenedor api | `api-publish`: `publish` sólo sobre paths de transcode (`~_h264$`) |
| API: sondas HLS internas (`probeHlsManifest`, `waitForHlsReady`) | `read` | contenedor api | `api-probe`: `read` |
| Servicio `analytics` → `ANALYTICS_MEDIAMTX_RTSP` (`rtsp://mediamtx:8554`) | `read` | contenedor analytics | `analytics`: `read` |
| Motor de detección (futuro, E7) | `read` de substreams | contenedor del motor | `detector`: `read` sólo substreams |
| Puerto `127.0.0.1:8554` publicado en el host | `read` | host | Decidir: quitarlo o dejarlo `read` con usuario propio de diagnóstico |
| Comentario "WebRTC por nginx `/webrtc/` → `:8889`" (`stream.ts`) | — | — | **Sin `location` en nginx hoy:** documentar como no expuesto; el guard de CI ya impide exponer `8889` |

**Requisitos de la etapa E0.5:**
- Las credenciales vienen del entorno; donde MediaMTX lo soporte, se restringen además por IP de la red docker (`ips`).
- Guard de CI que rechace `user: any` y `publish` anónimo.
- Pruebas: lectura anónima rechazada; vivo, transcode, sondas y analítica funcionando con sus usuarios.
- Rollback: volver al archivo anterior.

## 5. Reproductor y controlador de reproducción NVR

Un **controlador de reproducción** único (nuevo, sobre el `nvrRecordingProvider` de #184) es dueño de:

- **Sesiones:**
  - crear preview o playback;
  - relevo de continuidad: cierra el predecesor **sólo después** de registrar el sucesor (criterio tomado de #181);
  - cierre explícito al cambiar de cámara, de layout o de página.
- **Seek:**
  - dentro del bloque ya cargado → `currentTime`;
  - fuera del bloque → nueva sesión desde la nueva posición, invalidando respuestas viejas (invariante 4).
- **Pausa y velocidad:**
  - el timer de continuidad se basa en el **video realmente consumido** (`currentTime`), no en tiempo de pared (criterio de #181);
  - la pausa y el buffering no avanzan el timer;
  - las velocidades cambian el ritmo del reloj del timeline.
- **Calidad y pistas:**
  - **vivo:** 1×1 en alta calidad (main, si el usuario tiene `canHighQuality`), grilla en substream (criterio de #180, pospuesto), con degradación si el main no está listo;
  - **grabaciones:** **no se asume que el NVR grabó el subflujo.** Se descubren las pistas archivadas por cámara (`canal*100+1` y `+2`) y cada celda usa una pista **con grabación en el instante del reloj común** (grilla: subflujo si existe, si no principal con aviso; 1×1: principal, si no subflujo). Hoy la búsqueda sólo consulta `+1` (`hikvision.ts:1760`) y el subflujo se prueba a ciegas como variante de reintento (`rtsp-url.ts:176-225`). Criterio completo en `PLAYER_TEST_PLAN.md` §1.1.
- **Huecos, carga y límites visibles:** cada celda muestra "sin grabación" con "ir al próximo tramo", "cargando" y "en cola · posición N · el NVR acepta L sesiones"; el reloj común puede esperar a las celdas (sincronía estricta).
- **Liberación:** la sesión se libera sólo cuando no quedan espectadores vivos. El lease del backend se libera tras la salida real de FFmpeg (invariante 3).

El reproductor de eventos usa el **mismo** controlador:
- "Ver en el archivo" abre el NVR en `startedAt − preRoll`;
- "Clip del evento" reproduce el medio local rotulado como evidencia derivada.

## 6. Timeline y eventos

- **Una sola línea de tiempo por cámara:**
  - bloques de grabación del NVR (fuente del archivo);
  - marcas de eventos de VisionCore (detección);
  - huecos del NVR visibles.
- **Reloj:**
  - offset medido por NVR (ISAPI `/System/time` contra el reloj del servidor), guardado en la base;
  - los overlays se desplazan por ese offset;
  - con desvío por encima del umbral → aviso "alineación no fiable".
- **Modelo de datos (aditivo):**
  - `AnalyticsEvent` + `source` (`native | detector`), `externalId` y `@@unique([source, externalId])`, `startedAt`/`endedAt`;
  - nueva tabla `EventMedia` (`kind`: `snapshot | clip`, `bytes`, `sha256`, `expiresAt`, `deletedAt`).
- **RBAC:** toda lectura de eventos y medios usa `canView`/`canPlayback` de la cámara. Las miniaturas también.

## 7. Almacenamiento local: cuotas, caché temporal y retención completa de la ventana del evento

**Qué se guarda.** Sólo para las cámaras y clases con detección configurada:
- metadatos;
- un snapshot;
- un clip con la **ventana completa** del evento: `pre_capture` + duración + `post_capture`.

**Retención completa de la ventana.** En la configuración del motor:
- `record.continuous.days: 0` y `record.motion.days: 0`: nada fuera de eventos;
- `record.alerts.retain.mode: all` y `record.detections.retain.mode: all`;
- `pre_capture`/`post_capture` configurables por cámara.

`mode: all` es obligatorio: `motion` o `active_objects` descartan los segmentos de la ventana sin movimiento u objetos activos, y el clip quedaría con cortes. La revisión 1 de esta propuesta usaba `active_objects`: **corregido**.

**Caché temporal (dos niveles):**
1. **Caché de segmentos del motor** (dentro del contenedor). Los segmentos se escriben primero en la caché y sólo se mueven a almacenamiento si caen dentro de la ventana de un evento.
   - Dimensionarla para `max(pre_capture)` + margen por cámara analizada, y medirla en E8.
   - **No es almacenamiento.**
   - Volumen o `tmpfs` propio, con tamaño fijo.
2. **Almacén del motor** (`frigate_media`): retención corta, por ejemplo 2 días. Es sólo un **área de tránsito**: el ingestor copia snapshot y clip al almacén de VisionCore y verifica `sha256` y tamaño.

**Almacén de VisionCore (evidencia de eventos):**
- volumen dedicado de tamaño fijo;
- cuota global y por cámara (`SUM(EventMedia.bytes)`);
- retención por `expiresAt`, configurable por cámara y clase.
- **Política de cuota llena:**
  - borrar primero lo más viejo **ya expirado**;
  - si no alcanza, rechazar el medio nuevo y alertar;
  - nunca borrar en silencio evidencia no expirada (invariante 1);
  - todo borrado deja fila en `EventMedia.deletedAt` y en la auditoría.

## 8. Etapas (PR Draft pequeños) y criterios de aceptación

Cada etapa es un PR Draft con CI en verde. El detalle de pruebas de cada etapa está en `PLAYER_TEST_PLAN.md`.

| Etapa | Contenido | Criterio de aceptación (resumen) |
|---|---|---|
| **E0** | Esta propuesta, la referencia fijada, el plan de pruebas, la matriz y el runbook | Revisión aprobada |
| **P0** | Prototipo navegable con datos simulados (#188) | Revisión de la experiencia por el dueño; suite simulada verde en PC y tablet |
| **S0** | Correcciones de seguridad previas a exponer nada nuevo: #186 (`playbackURI`), #189 (RBAC del heartbeat), #190 (sólo access tokens) y los pendientes **Alto** de la matriz (§ hallazgos) | Pruebas de ruta que reproducen cada fallo antes del fix |
| **E0.5** | Autenticación de MediaMTX por consumidor (§4) | Lectura anónima rechazada; vivo, transcode, sondas y analítica OK con sus usuarios; guard de CI |
| **E1** | Controlador de reproducción NVR sobre #184 + pruebas simuladas | Suite simulada **S1–S9** verde (continuidad, seek, pausa, velocidades, multicámara, calidad automática, liberación, revocación, límites) |
| **E2** | Almacén de eventos y medios (sin motor) | Pruebas IDOR; cuota y retención con fixtures; migración aditiva contra PostgreSQL real; rollback documentado |
| **E3** | Timeline unificado (port de `ReviewTimeline` y afines) | NVR + eventos + huecos con un NVR simulado; offset de reloj; snapshot visual |
| **E4** | Vista de eventos y "Ver en el archivo" / "Clip del evento" | Clic en un evento → seek del NVR a ±1 s; sin permiso no hay evento ni miniatura |
| **E5** | Configuración de detección (zonas, máscaras, objetos, ventana, retención) + generación de `config.yml` | Config generada válida contra el esquema de `v0.18.0` en CI; decisión React 18/19 tomada |
| **E6** | Ingestor endurecido | Idempotencia, mapeo por `cameraId`, copia con `sha256` y límites de tamaño |
| **E7** | Motor en staging, hardware nuevo (OpenVINO NPU/GPU) | Arranca aislado (#187), lee de MediaMTX con el usuario `detector`, sin acceso externo |
| **E8** | Mediciones con NVR reales (piloto) | Plan de pruebas, parte **M**: no se declara mejora sin cifras |
| **E9** | Reubicación de la configuración existente en la organización de §2.3 (General, NVR/cámaras, usuarios/permisos, seguridad, alertas/SMTP, visores) | Misma API y mismos `authorize([...])` (sin ampliar permisos); tabla sección × rol con prueba; ninguna sección que no persiste se presenta como configurable |

## 9. Decisiones pendientes

> Los puntos 5–9 pasan a la política única de permisos (`docs/security/PERMISSIONS_POLICY.md` §8: 5 → D1, 6 → D3 y R-H, 7 → D4, 8 → D5, 9 → D2). El 10 y el 11 los **resolvió el dueño** (2026-10-08).

1. ~~Editor de zonas: React 18 vs 19~~ → **resuelto** en §2.4 (React 18 + react-konva 18.2.16 + konva 10.2.3).
2. `127.0.0.1:8554` en el host: quitarlo o dejarlo con usuario de diagnóstico.
3. Retención por defecto de los clips de eventos y cuota total del volumen.
4. Si se adoptan *review segments* (alert/detection) como en Frigate, o sólo eventos.
5. **Política de SUPERVISOR por recurso:** hoy es "sin restricción" en vivo/grabaciones/cámaras pero
   se filtra por `canView` en alertas y eventos de análisis. Elegir una sola regla.
6. **Permisos por NVR** (filas sin `cameraId`): hoy cuentan en `/nvrs` y `hls-auth` pero no en
   `/cameras`, `start-stream`, heartbeat (#189 mantiene el criterio de `start-stream`), alertas ni eventos.
7. **`UserFeaturePermissions` y flags granulares** (`canManage*`, `canDownload*`, `canRestart*`…): se
   guardan pero casi ningún endpoint los consulta. Aplicarlos o quitarlos de la UI; la matriz se basa
   en `authorize([...])`.
8. **Descarga de grabaciones:** `canDownload`/`canDownloadRecordings` no se aplican (cualquier
   ADMIN/SUPERVISOR o AUDITOR con `canPlayback` genera y descarga el MP4). Decidir si `POST /playback`
   cuenta como descarga.
9. **AUDITOR y el vivo:** algunas rutas lo excluyen (`/stream`, `/snapshot`) y otras no
   (`start-stream`, `hls-auth`); el default `canViewLive=false` no se aplica.
10. ~~**Visores personales para OPERATOR/AUDITOR**~~ → **resuelto por el dueño:** se permiten dentro de las cámaras autorizadas (política §6; lo pendiente de visores es D7).
11. ~~**Política de reloj común en grabaciones**~~ → **resuelto por el dueño:** una cámara bloqueada o
    cargando **no** detiene a las demás por defecto; reloj común con resincronización por celda; "esperar
    a todas" queda como opción explícita, apagada (prototipo #188).

## 10. Fuera de alcance

Reconocimiento facial, LPR del motor, búsqueda semántica y GenAI. Cada uno requiere evaluación propia de privacidad, consentimiento y hardware.
