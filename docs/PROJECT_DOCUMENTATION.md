# VisionCore — Documentación Técnica Integral

> ⚠ **SUPERSEDED (2026-09-06) — índice histórico.** La entrada canónica es ahora
> `docs/AI_HANDOFF.md`, con detalle en `docs/IMPLEMENTATION_STATUS.md`,
> `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/DEVELOPMENT_HISTORY.md`, `docs/TEST_EVIDENCE.md`,
> `docs/HARDWARE_STATUS.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md` y `docs/BACKUP_RESTORE.md`.
> Este documento se conserva como referencia histórica; puede contener afirmaciones desactualizadas
> (p. ej. §17 afirma que ONVIF/Hik-Connect no existen, pero SÍ existen en `main` `0f9d1f5`, gated por flag).
> Ante discrepancia, prevalecen los documentos canónicos.

> **Fuente única de verdad del proyecto.** Documento vivo. Última actualización:
> 2026-09-03. Rama de trabajo: `claude/multi-agent-project-audit-hf14wq`
> (estado **c22**, commit `0b3c2f8` — importación local de c22 ≈ `9fbb01f`
> aplicada sobre `main` `620c893`).
>
> Este documento describe el **código versionado**, no el estado de ningún
> servidor de producción. No autoriza despliegues ni operaciones remotas.
> No contiene secretos, credenciales ni IPs internas reales (se usan
> marcadores como `<ip_nvr>`).

---

## Índice

1. [Propósito y alcance](#1-propósito-y-alcance)
2. [Arquitectura general](#2-arquitectura-general)
3. [Flujo de video y ciclo de vida de streams](#3-flujo-de-video-y-ciclo-de-vida-de-streams)
4. [Reproducción de grabaciones](#4-reproducción-de-grabaciones)
5. [Modelo de datos (Prisma)](#5-modelo-de-datos-prisma)
6. [API REST — endpoints principales](#6-api-rest--endpoints-principales)
7. [RBAC, roles y permisos](#7-rbac-roles-y-permisos)
8. [Plano de grants de medios y trabajo C1–C22 (N1/N2, Track2/Track3)](#8-plano-de-grants-de-medios-y-trabajo-c1c22)
9. [Analítica de video (IA)](#9-analítica-de-video-ia)
10. [Notificaciones y alertas](#10-notificaciones-y-alertas)
11. [Integración Hikvision ISAPI](#11-integración-hikvision-isapi)
12. [Variables de entorno (flags)](#12-variables-de-entorno-flags)
13. [Invariantes que no se deben romper](#13-invariantes-que-no-se-deben-romper)
14. [Seguridad](#14-seguridad)
15. [Despliegue y operación](#15-despliegue-y-operación)
16. [Estado actual: hecho / pendiente](#16-estado-actual-hecho--pendiente)
17. [Prioridades del usuario](#17-prioridades-del-usuario)
18. [Registro de lo solicitado y lo realizado](#18-registro-de-lo-solicitado-y-lo-realizado)
19. [Marcadores para completar](#19-marcadores-para-completar)

---

## 1. Propósito y alcance

VisionCore es un **VMS (Video Management System) web** para administrar NVR
Hikvision. Cubre: vista en vivo multiview, reproducción de grabaciones,
gestión de cámaras y NVR, usuarios, roles, control de acceso (RBAC), PTZ,
alertas/notificaciones y una base de analítica de video.

No es solo un dashboard: su misión operativa es **proteger la continuidad de
visualización y la evidencia de grabaciones**. Está desplegado sobre 4 NVR
Hikvision (16, 32, 31 y 62 canales; ~141 canales en total). Ver `README.md`.

**Límites de este documento:** describe el árbol de código en la rama de trabajo.
No describe ni autoriza cambios en producción, Nginx, MediaMTX, Docker ni `main`.

---

## 2. Arquitectura general

```
                          ┌──────────────────────── Navegador (React SPA) ───────────────────────┐
                          │  hls.js (HLS H.264)   ·   PTZ/WebRTC   ·   JWT en localStorage         │
                          └───────────────▲───────────────────────────────▲──────────────────────┘
                                          │ HTTPS / WSS                     │ /hls/  (video)
                                          │                                 │
                    ┌─────────────────────┴─────────────────────┐   ┌───────┴─────────┐
                    │                Nginx (proxy)               │   │  Nginx /hls/    │
                    │  / → web (SPA)   /api/ → api   /ws/ → api  │   │  → MediaMTX 8888│
                    └───────┬────────────────────────┬──────────┘   └───────▲─────────┘
                            │ /api/                   │ /ws/                  │
                    ┌───────▼────────────────────────▼──────────┐           │
                    │        apps/api  (Node + Fastify)          │           │ HLS/WebRTC
                    │  routes · services · plugins · jobs        │           │
                    │  Prisma ─┐   Redis ─┐   Socket/WS ─┐       │           │
                    └──────────┼──────────┼──────────────┼───────┘           │
                               │          │              │                   │
                      ┌────────▼──┐  ┌────▼─────┐        │        ┌──────────┴──────────┐
                      │PostgreSQL │  │  Redis    │        │        │      MediaMTX       │
                      │ (Prisma)  │  │ (estado/  │        │        │  RTSP→HLS/WebRTC    │
                      └───────────┘  │  grants)  │        │        │  sourceOnDemand     │
                                     └───────────┘        │        └──────────▲──────────┘
                                                          │                   │ RTSP :554
              ┌───────────────────────────────┐          │        ┌──────────┴──────────┐
              │  apps/analytics (Python/FastAPI)│◀────────┘        │   NVR Hikvision     │
              │  YOLOX/ONNX · ByteTrack         │  restream        │  (ISAPI :80 / RTSP) │
              │  lee restream MediaMTX          │  MediaMTX        └─────────────────────┘
              └───────────────────────────────┘

  apps/native (Tauri/Rust + shared-core TS) — cliente nativo en diseño, decoder HEVC por SO.
```

### Componentes

| Componente | Stack | Rol | Ubicación |
|---|---|---|---|
| **apps/api** | Node.js + Fastify + Prisma | Backend REST + WS; orquesta streams, ISAPI, grants | `apps/api/src` |
| **apps/web** | React 18 + Vite + TS + Tailwind + Zustand | SPA (dashboard, live, grabaciones, admin) | `apps/web/src` |
| **apps/analytics** | Python + FastAPI + OpenCV + ONNX | Detección/tracking sobre restream MediaMTX | `apps/analytics` |
| **apps/native** | Tauri 2 (Rust) + shared-core TS | Cliente nativo multiplataforma (diseño) | `apps/native` |
| **PostgreSQL** | postgres:16-alpine | Persistencia (Prisma) | `docker-compose.yml:3` |
| **Redis** | redis:7-alpine | Estado compartido: consumidores, grants, tokens | `docker-compose.yml:26` |
| **MediaMTX** | bluenviron/mediamtx | RTSP → HLS/WebRTC on-demand | `docker-compose.yml:45`, `infra/mediamtx/mediamtx.yml` |
| **Nginx** | nginx:alpine | Reverse proxy + SSL + `/hls/` + `/ws/` | `docker-compose.yml:214`, `infra/nginx/nginx.conf` |
| **Certbot** | certbot/certbot | Let's Encrypt (renovación 12h) | `docker-compose.yml:239` |

### Backend — organización (`apps/api/src`)

- `routes/` — handlers HTTP por dominio (ver §6).
- `services/` — lógica: `hikvision.ts` (ISAPI, ~97 KB), `stream-manager.ts`
  (ciclo de vida de streams, ~175 KB), `stream.ts` (publicación/FFmpeg),
  `stream-consumer-registry.ts`, `session-lifecycle.ts`, `media/` (grants
  nativos), `ai/` (pipeline IA), `recordings/`, `credentials.ts` (AES),
  `notification.service.ts`, `totp.ts`.
- `plugins/` — `prisma`, `redis`, `auth` (JWT).
- `jobs/` — `healthWorker` (salud NVR/cámara/HDD), `syncWorker`.
- `server.ts` — bootstrap: registra plugins, rutas (algunas gated por flags),
  jobs y el re-registro de paths en MediaMTX al arrancar.

### Frontend — páginas (`apps/web/src/pages`)

`DashboardPage`, `LiveViewPage`, `ViewsPage`/`ViewPlayerPage` (vistas
multiview guardadas), `RecordingsPage`, `NVRsPage`/`NVRDetailPage`,
`UsersPage`, `AlertsPage`, `AnalyticsPage`, `ActivityPage`, `SettingsPage`,
`AppearancePage`, `ProfilePage`, `LoginPage`/`ForgotPasswordPage`/`ResetPasswordPage`.

---

## 3. Flujo de video y ciclo de vida de streams

Referencia canónica: `STREAMING.md`.

### 3.1 Flujo de datos

```
NVR Hikvision (RTSP :554)
  └─ MediaMTX — pull on-demand (sourceOnDemand: true)
       ├─ HLS  (:8888) → nginx /hls/ → hls.js   (~6 s latencia)
       └─ WebRTC (:8889)                          (~500 ms; PTZ / futuro)
```

MediaMTX conecta al NVR **solo cuando hay un lector**. VisionCore cierra la
sesión explícitamente al salir/cambiar de vista; `sourceOnDemandCloseAfter: 10m`
es solo el GC de respaldo. Config: `infra/mediamtx/mediamtx.yml`
(`hlsVariant: fmp4`, `hlsSegmentCount: 7`, `hlsSegmentDuration: 2s`).

### 3.2 Nombres de path

Los paths se registran como `nvr_<cameraId>`; el transcode HD usa el sufijo
`_main_h264`. El bloque `~^nvr_.*` aplica la política on-demand.

### 3.3 Arranque on-demand

1. Frontend `POST /api/live-view/heartbeat` (o `start-stream`) con `viewId` +
   `visibleCameraIds` → `reconcileView` (`apps/api/src/routes/liveView.ts:51`,
   `services/stream-manager.ts`).
2. API descifra la contraseña AES del NVR y registra/asegura el path en MediaMTX.
3. El player carga `index.m3u8` → MediaMTX conecta al NVR por RTSP.
4. Al salir/cambiar, el API retira la sesión; el cierre 10 min es red de seguridad.

### 3.4 Vigencia de una sesión — tres conceptos distintos

Definido en `STREAMING.md` y `docs/phase-a1-session-heartbeat-truth.md`:

| Concepto | Qué es | ¿Mantiene viva la sesión? |
|---|---|---|
| `lastClientHeartbeat` | Hora del **servidor** al recibir actividad de un cliente autenticado | **Sí — única evidencia de espectador** |
| `lastMediaActivity` | Actividad de medio sobre el path | No (diagnóstico) |
| `processAlive` | FFmpeg vivo | No (estado observado) |

Regresión histórica corregida: el limpiador renovaba el heartbeat al ver FFmpeg
vivo, y una sesión llegó a "vivir" 26 h sin espectador. Ahora **solo** el
heartbeat de cliente prolonga la sesión.

### 3.5 Pertenencia y ciclo de cierre

- La clave de sesión es `(usuario, pestaña/viewId, cámara, tipo)`. Todo arranque
  envía su `viewId`; sin él, expira por `view_heartbeat_missing`.
- Un cierre/heartbeat sin `viewId` solo se resuelve si la pertenencia es
  inequívoca; con ambigüedad se registra `stop_ignored_ambiguous`.
- Cierre inmediato e idempotente con `fetch(..., { keepalive: true })` sobre
  `DELETE /api/cameras/:id/stream` o `DELETE /api/cameras/my-sessions`
  (no se usa `sendBeacon` porque no permite `Authorization`).
- Procesos **compartidos**: varias sesiones comparten un FFmpeg (mismo
  `streamPath`/perfil); solo se termina cuando **no queda ningún espectador
  válido**, decidido sobre el conjunto completo.
- El supervisor **no re-spawnea** sin heartbeat de cliente fresco o arranque en
  vuelo válido; `lastMediaActivity` no autoriza reinicio.

### 3.6 Límites de concurrencia

| Variable | Default | Descripción |
|---|---|---|
| `MAX_STREAMS_PER_USER` | 16 | Streams simultáneos por usuario |
| `MAX_STREAMS_GLOBAL` | 50 | Streams simultáneos totales |
| `MAX_TRANSCODE_SESSIONS` | **2** | **Transcodes HEVC→H.264 simultáneos (invariante duro)** |
| `STREAM_IDLE_TIMEOUT` | 90 s | TTL sin heartbeat de cliente (acotado 15–3600) |
| `STREAM_HD_IDLE_TIMEOUT` | 90 s | TTL sesiones HD/transcode (hereda el anterior) |

El **límite de 2 transcodes** es el primer dolor del usuario (§17): no se sube;
la palanca real es el playback nativo (HEVC por hardware en el cliente).

### 3.7 H.265/HEVC

Los navegadores no decodifican HEVC en HLS; MediaMTX retransmite sin transcodificar
⇒ pantalla negra. VisionCore usa el **substream (`{canal}02`, normalmente H.264)**
por defecto. Para HEVC en web se transcodifica (consume uno de los 2 cupos).
Ver `TROUBLESHOOTING.md` §3.

---

## 4. Reproducción de grabaciones

Referencia: `docs/recordings/ARCHITECTURE.md`, `RECORDINGS_SDK_PLAN.md`,
`apps/api/src/routes/recordings.ts` (~193 KB), `apps/api/src/services/recordings/`.

### 4.1 Flujo (estilo iVMS-4200, sin esperar un MP4 completo)

1. **Búsqueda (ISAPI):** paginación con tag `searchResultPostion` (sic), loop en
   `responseStatusStrg=MORE`, dedupe, fallback por chunks de tiempo; calendario
   de disponibilidad vía `dailyDistribution`.
2. **Preview instantáneo (fMP4 sobre HTTP):** FFmpeg lee el RTSP de playback del
   NVR y emite fMP4 vía `reply.hijack()` (arranca en 1–3 s).
3. **MP4 bajo demanda:** solo al descargar/exportar se genera el MP4 completo
   (cache en disco + token de descarga de 24 h en Redis).

### 4.2 Selección de variantes y errores

`services/recordings/rtsp-url.ts` (helpers puros, testeados): cadena
`main_full → main_no_name_size → sub_full → sub_no_name_size`.
`classifyRtspError` detecta **453 (límite de sesiones del NVR)** antes que el
ruido 4XX/DESCRIBE; también auth/track/offline/codec. Reescribe el `starttime`
del playbackURI y enmascara credenciales.

### 4.3 Máquina de estados y continuidad

```
idle → searching → loading → playing ⇄ paused
                              playing → buffering → playing
                              playing → continuing → loading  (siguiente bloque)
                              loading → no_recording           (hueco)
                              searching → end_of_results
   cualquiera → error | cancelled
```

Continuidad automática por `ended` del `<video>`, timer esperado
(`clipEnd − effectiveStart`) o error cerca del final. Considera gaps
`> CONTINUITY_GAP_MS`.

### 4.4 Límites y plan SDK (no implementado)

Reproducción reversa real, frame-atrás real, decodificación nativa multicanal y
descarga exacta por tiempo **no** son viables con fMP4/web. `RECORDINGS_SDK_PLAN.md`
diseña dos caminos futuros (no implementados): **Opción A** worker nativo
HCNetSDK (servicio C++ separado, nunca dentro de `apps/api`) y **Opción B**
WebSDK Windows (plugin oficial en el cliente). Decisión actual: seguir en
ISAPI/RTSP/FFmpeg mientras cubra los casos. La reproducción de grabaciones es el
segundo dolor del usuario (§17).

---

## 5. Modelo de datos (Prisma)

Esquema: `prisma/schema.prisma` (655 líneas, PostgreSQL). Modelos principales:

| Modelo | Propósito | Notas clave |
|---|---|---|
| `User` (`:23`) | Usuarios del sistema | `passwordHash` bcrypt; 2FA TOTP (`twoFactorSecret`); política de contraseñas (`passwordHistory`, `lockedUntil`); enforcement MFA (`mfaGraceLoginsUsed`, `forceMfaEnrollment`) |
| `Session` (`:67`) | Sesiones/refresh JWT | Rotación de refresh (`previousRefreshToken`); detección de replay |
| `UsedRefreshToken` (`:93`) | Historial de refresh consumidos | Detección de reutilización de familia + gracia multi-pestaña |
| `NVR` (`:107`) | NVR Hikvision | `password` cifrado AES; `maxConcurrentPlaybackSessions` (límite físico, 453); capacidades de grabación ISAPI/SDK; `audioMode` |
| `NvrHdd` (`:158`) | Discos del NVR | Capacidad, libre, estado |
| `Camera` (`:179`) | Cámaras/canales | `preferredStream` (main/sub), codecs/resoluciones, diagnóstico RTSP, `streamHealthStatus`, evidencia real de pipeline (`lastStreamSuccessAt`, `lastHlsSuccessAt`…), alertas por cámara, modo mantenimiento |
| `UserPermission` (`:268`) | Permisos por NVR/cámara | `canView`, `canPlayback`, `canPtz`, `canHighQuality`, y granulares (download, transcode, main stream…) |
| `UserFeaturePermissions` (`:307`) | Permisos por módulo de UI | dashboard, live, recordings, gestión, acciones |
| `AuditLog` (`:337`) | Auditoría | userId, action, resource, detail JSON, ip, userAgent |
| `Alert` (`:355`) + `AlertType`/`AlertSeverity` | Alertas | tipos de salud + analítica (PERSON_DETECTED, ZONE_INTRUSION…) |
| `CameraView` (`:404`) / `CameraViewAccess` (`:422`) | Vistas multiview guardadas | layout, `cameraSlots` JSON, slideshow, acceso por usuario |
| `AppearanceSettings` (`:436`) | Marca/tema (singleton) | Sistema de tokens V2 |
| `NotificationDelivery` (`:479`) | Entregas de notificación | canal (email/websocket/telegram/whatsapp), status, `source` (live/backfill) |
| `NvrChannelConfigBackup` (`:520`) | Backup de config de canal | before_edit/manual/restore |
| `CameraAnalyticsConfig` (`:537`) | Config de analítica por cámara | clases COCO, zonas, líneas, cooldown |
| `AnalyticsEvent` (`:560`) | Eventos de detección | tipo, clase, confidence, trackId, bboxes, incidentId |
| `LicensePlateEvent` (`:588`) | ALPR (scaffold) | flag `ANALYTICS_ALPR_ENABLED` |
| `SecuritySettings` (`:605`) | Política de seguridad (singleton) | longitud mínima, lockout, MFA obligatorio |
| `RecordingsSettings` (`:623`) | Política de grabaciones (singleton) | `recordingsAudioMode`, `recordingsDefaultMaxConcurrentPerNvr` |
| `AlertSettings` (`:639`) | Config SMTP/alertas (singleton) | host/puerto/tipos/`minSeverity` |

> Nota: los grants de medios (§8) **no** son tabla Prisma — viven en Redis (o
> memoria como fallback), con TTL corto e índices atómicos.

---

## 6. API REST — endpoints principales

Registro y prefijos en `apps/api/src/server.ts:186`. Todas las rutas de negocio
requieren JWT (`server.authenticate`); las de diagnóstico global exigen ADMIN.

### Auth — `/api/auth` (`routes/auth.ts`)
`POST /login`, `POST /2fa/verify`, `GET /2fa/setup`, `POST /2fa/enable`,
`POST /mfa/enroll/start`, `POST /mfa/enroll/complete`, `POST /step-up`,
`POST /2fa/disable`, `POST /2fa/backup-codes/regenerate`, `POST /change-password`,
`GET /sessions`, `DELETE /sessions/:sessionId`, `DELETE /sessions`,
`POST /refresh`, `POST /logout`, `POST /forgot-password`, `POST /reset-password`,
`GET /me`. (El logout/cambio de permisos **revoca grants de medios** — §8.)

### Cámaras — `/api/cameras` (`routes/cameras.ts`)
`GET /`, `POST /batch`, `GET /:id`, `GET /:id/stream`, `GET /:id/stream/status`,
`GET /:id/diagnostics`, `POST /:id/restart-stream`, `POST /:id/test-rtsp`,
`GET /:id/snapshot`, `POST /:id/ptz`, `POST /:id/start-stream`,
`POST /cleanup-my-sessions`, `GET /stream-sessions` (ADMIN),
`POST /:id/stop-stream`, `DELETE /:id/stream`, `DELETE /my-sessions`,
`POST /:id/touch-stream`, `POST /:id/validate-stream`, `GET /:id/debug-stream`,
`PUT /:id`, `PATCH /:id/name`, `POST /:id/migrate`.

### NVR — `/api/nvrs` (`routes/nvr.ts` + `routes/nvrConfig.ts`)
Conexión/descubrimiento: `POST /test-connection`, `/detect`, `/scan`.
CRUD: `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`.
Estado/ISAPI: `GET /:id/status`, `/device-info`, `/storage`, `/users`, `/cameras`.
Sync: `POST /:id/sync`, `/sync-cameras`, `/sync-streams`, `/force-names-sync`.
Salud/operación: `POST /:id/validate-health`, `/reboot`, `/onboard`.
Grabación: `GET/POST/PUT /:id/recording-capabilities*`.
Canales/adopción: `GET /:id/free-channels`, `POST /:id/cameras/adopt`.
Usuarios del NVR: `POST/PUT/DELETE /:id/users*`.
Video/audio: `GET/PUT /:id/video-audio*`.
Config de canal (nvrConfig): `GET/PUT /:nvrId/channels/:channelId/video-config`,
`.../restore`, `.../capabilities`.

### Grabaciones — `/api/recordings` (`routes/recordings.ts`)
`GET /search`, `GET /calendar`, `POST /batch-search`, `POST /playback`,
`GET /playback/:sessionId/status`, `GET /playback/:sessionId/file.mp4`,
`DELETE /playback/:sessionId`, `GET /download`, `GET /audit`,
`POST /preview/start`, `GET /preview/:sessionId/stream`,
`GET /preview/:sessionId/status`, `DELETE /preview/:sessionId`,
`POST /diagnostics/playback`, `GET /diagnostics/nvr-time`,
`GET/PUT /settings/audio`.

### Live View — `/api/live-view` (`routes/liveView.ts`)
`POST /heartbeat` (reconciliación de viewport), `GET /sessions` (ADMIN),
`GET /capabilities`, `POST /client-capabilities` (negociación nativa — §8),
`GET /transcodes` (diagnóstico FFmpeg).

### Grants de medios — `/api/live-view` (`routes/mediaGrants.ts`, **solo si `NATIVE_PLAYBACK_ENABLED`**)
`POST /media-grant`, `DELETE /media-grant/:grantId`,
`DELETE /media-grant/view/:viewId`, `POST /internal/media-grant/validate`
(lo llama el relay; requiere `MEDIA_RELAY_SECRET`).

### Usuarios — `/api/users` (`routes/users.ts`)
`GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`,
`GET/PUT/POST /:id/permissions`, `GET /:id/effective-permissions`,
`POST /:id/feature-permissions`, `POST /:id/reset-2fa`, `POST /:id/unlock`,
`GET/DELETE /:id/sessions`, `GET /audit/activity`.

### Analítica — `/api/analytics` (`routes/analytics.ts`)
Internos (secreto compartido): `GET /internal/cameras`, `POST /internal/events`,
`POST /internal/plates`. UI: `GET/PUT /config*`, `GET /events`, `GET /summary`,
`GET /service-status`, `GET /live-frame/:cameraId`, `GET /plates`.

### Otros
Alertas `/api/alerts` (`GET /`, `/summary`, `/unread-count`, `POST /read-all`,
`/:id/read`, `PUT /:id/resolve`) + AlertSettings (`GET/PUT /settings`,
`POST /settings/test-email`, `GET /settings/deliveries`).
Dashboard `/api/dashboard/overview`. Vistas `/api/views` (CRUD).
Búsqueda `/api/search/global`. Seguridad `/api/security/settings`.
Apariencia `/api/appearance`. Perfil `/api/profile`.
Admin `/api/admin/*` (diagnósticos de transcodes/capacidad).
Diagnósticos `/api/diagnostics/*`. IA demo `/api/ai/demo/*` (**solo si
`AI_EVENTS_ENABLED`**). Métricas Prometheus `/metrics` (sin prefijo).
Health: `/health`, `/api/health`, `/api/health/deep`. WebSocket `/ws/alerts`.

---

## 7. RBAC, roles y permisos

Cuatro roles (`prisma/schema.prisma:15`), permisos incrementales:

| Rol | Ver en vivo | Grabaciones | PTZ | Config NVR | Usuarios |
|---|---|---|---|---|---|
| `ADMIN` | Todas | Todas | Sí | Sí | Sí |
| `SUPERVISOR` | Todas | Todas | Sí | Lectura | No |
| `OPERATOR` | Solo asignadas | No | Sí (si habilitado) | No | No |
| `AUDITOR` | No (solo asignadas para playback) | Solo asignadas | No | No | No |

**Permisos granulares** (`UserPermission`) independientes del rol, por NVR o
cámara: `canView`, `canPlayback`, `canPtz`, `canHighQuality` y granulares
(`canDownload`, `canUseMainStream`, `canUseTranscode`, `canAddToViews`,
`canViewRecordings`, `canManage`…). Un `OPERATOR` solo ve cámaras con
`canView = true` explícito.

**Permisos por módulo de UI** (`UserFeaturePermissions`): controlan visibilidad
de dashboard, live, grabaciones, gestión de NVR/cámaras/usuarios/apariencia y
acciones (resolver alertas, transcodificar, descargar, etc.).

RBAC de medios compartido entre negociación y emisión de grants
(`hasMediaAccess`, `services/media/native-readiness.ts`): `sub ⇒ canView`;
`main`/HD ⇒ `canView + canHighQuality`. ADMIN/SUPERVISOR tienen acceso sin
permiso explícito.

---

## 8. Plano de grants de medios y trabajo C1–C22

> El trabajo C-numerado es una serie de rondas de endurecimiento del pipeline de
> streaming y del futuro **cliente nativo**. C1–C21 endurecieron el ciclo de vida
> de streams/FFmpeg; C22 añadió el **plano de autorización de medios** para el
> cliente nativo, más N1/N2, Track2 y Track3. **Todas las flags nuevas están OFF
> por defecto: con ellas apagadas, el comportamiento es idéntico a C21.**

### 8.1 ¿Por qué existe un cliente nativo?

`docs/native/LIVE_CLIENT_ARCHITECTURE.md`, `ADR-0001`. Una cámara HEVC en web
consume uno de los **2 cupos de transcode**. Si el cliente nativo decodifica HEVC
por hardware (Media Foundation/MediaCodec/VideoToolbox), **no** usa un FFmpeg del
servidor: el límite deja de ser `MAX_TRANSCODE_SESSIONS=2` y pasa a depender del
dispositivo/red/NVR. Es la palanca real contra el primer dolor (§17), sin subir el
límite de 2.

| Cliente | HEVC principal | Usa FFmpeg del servidor | Límite dominante |
|---|---|---:|---|
| Navegador | HLS H.264 transcodificado | Sí | `MAX_TRANSCODE_SESSIONS=2` |
| Nativo sin HEVC HW | fallback HLS H.264 | Sí | servidor |
| Nativo con HEVC HW + relay seguro | HEVC directo | **No** | dispositivo/red/NVR |

### 8.2 El plano de grants (C22 · C22.1 · C22.2)

Objetivo: autorizar acceso de medios al cliente nativo **sin** entregarle jamás
credenciales del NVR ni URLs RTSP. Piezas en `apps/api/src/services/media/`:
`contracts.ts`, `media-grants.ts`, `grant-store.ts`, `grant-service.ts`,
`native-readiness.ts`, `session-policy.ts`, `source-lifecycle.ts`,
`admission-wait.ts`. Threat model: `docs/security/THREAT_MODEL_NATIVE_MEDIA.md`.

Modelo de grant (honesto, tipo **bearer**):
- Secreto opaco de 256 bits; el API guarda **solo `sha256(secret)`**; el secreto
  viaja una sola vez en la emisión.
- **Uso único anti-replay** en una transición **atómica linealizable**
  (`validateAndClaim`): Redis vía script Lua `LUA_VALIDATE_AND_CLAIM` (`EVAL`),
  memoria vía método síncrono. Dos consumos ⇒ exactamente uno gana; el otro es
  `REPLAYED`.
- Scope **server-derivado**: `cameraId`, `streamPath`, `codec`, `effectiveType`,
  `transport`, `mediaInstanceId`, `authorizationEpoch`. El cliente no puede
  alterar el scope.
- Aislamiento cross-user real por: RBAC en la **emisión** + `authorizationEpoch`
  por usuario (logout/cambio de permiso lo incrementa ⇒ `EPOCH_MISMATCH`) + TTL
  corto + uso único.
- `mediaInstanceId` liga el grant a una **fuente viva**; recrear el path rota la
  instancia ⇒ grants viejos dan `INSTANCE_MISMATCH`. `issue` se **niega** si no
  hay fuente vigente (`NO_MEDIA_INSTANCE`).
- **Fail-closed:** relay sin backend atómico cross-process (Redis) ⇒
  `GRANT_ATOMICITY_UNAVAILABLE` (503); revocación que no se aplica ⇒ pending +
  retry (outbox), nunca se declara revocado sin aplicar.

Correctivos tras auditoría independiente:
- **C22.1** (`docs/native/C22_1_CORRECTIVE.md`): 6 defectos P0 — revocación
  atómica singleton, `mediaInstanceId` (elimina `processGeneration:number`),
  coherencia de `nativeDirect.available`, lifecycle nativo (dispose antes de
  publicar), IA con aislamiento/cancelación.
- **C22.2** (`docs/native/C22_2_CORRECTIVE.md`): 7 defectos P0 sobre el **modelo**
  (atomicidad, epoch durable, revocación no tragada, fuente real, readiness/RBAC
  unificados, carrera de handle en dispose, concurrencia real de inferencia).

### 8.3 N1 / N2 (Track 1) — `docs/native/N1_N2_WIRING.md`

Cierra huecos que C22.2 marcó como *no cableados*. Todo detrás de flags OFF.

- **N1 — lifecycle de fuente MediaMTX** (`source-lifecycle.ts`): reconcilia
  eventos `onReady/onNotReady` contra `GET /v3/paths/list` (**solo lectura**). Un
  `ready` duplicado **no rota** la instancia (keepalive `refreshSource`); solo un
  ciclo `notReady→ready` rota. `reconcile(null)` (API caída) no retira nada.
  Poller detrás de `NATIVE_SOURCE_LIFECYCLE_ENABLED` (`server.ts:274`). Con la
  flag OFF nada se registra ⇒ `issue` sigue negándose.
- **N2a — auto-revocación por lifecycle del cliente** (`native/shared/lifecycle-binder.ts`):
  `onHidden/onVisible/onPageHide/onTeardown` → invalidate/dispose.
- **N2b — espera cancelable de cupo** (`admission-wait.ts`): `waitForCapacity`
  **observa** disponibilidad, **no reserva** (la reserva del límite de 2 sigue en
  el stream-manager). No reduce el TTL ni sube el límite.
- **N2c — puente decisión→coordinador** (`native/shared/apply-decision.ts`):
  aplica la decisión server-side al coordinador (autoridad = servidor).
- **N2d — sesión de medios única por usuario** (`session-policy.ts`, cableado en
  `mediaGrants.ts:83`): al emitir grant en dispositivo nuevo, revoca los grants de
  la sesión previa. Detrás de `SINGLE_ACTIVE_MEDIA_SESSION` (OFF).

### 8.4 Track 2 — capstone del cliente nativo (`docs/native/TRACK2_CAPSTONE.md`)

`apps/native/shared/native-controller.ts`: compone coordinator + lifecycle-binder
+ applyPlaybackDecision en un `NativePlaybackController` usable por la app de
plataforma. `onResume` re-aplica la última decisión del servidor. TS puro (sin
DOM/Tauri). No cambia autoridad ni invariantes.

### 8.5 Track 3 — validación Lua real (`docs/native/TRACK3_VALIDATION.md`)

`grant-store.lua.test.ts` ejecuta el **script Lua exacto** sobre una VM Lua
(**wasmoon**, devDependency solo-test) y cruza su resultado contra el reducer TS
para cada caso (happy, NOT_FOUND, REVOKED, EXPIRED, SCOPE, EPOCH,
INSTANCE_*, SECRET, REPLAYED, orden). 11/11 verde. **Alcance honesto:** valida la
**lógica** del script; **no** la atomicidad/linealizabilidad de `EVAL` en un Redis
real (eso lo garantiza Redis).

### 8.6 Estado del cliente nativo (`apps/native`)

- `shared/` (TS): implementado y **probado** (shared-core, no ejecutable):
  `playback.ts`, `session-controller.ts`, `grant-client.ts`, `coordinator.ts`,
  `lifecycle-binder.ts`, `apply-decision.ts`, `native-controller.ts`,
  `mock-adapter.ts`.
- `src-tauri/` (Rust): **skeleton, NO compilado** (sin cargo/rustc ni SDK).
- Binarios `.msi/.apk/.ipa`: **no generados**.
- `NATIVE_MEDIA_RELAY_ENABLED=false` hasta completar el relay autenticado (N1).

### 8.7 A1 — relay de medios autenticado

**NO-GO / deshabilitado.** No confundir con el trabajo A1 de "transición de
viewport atómica" mencionado en `docs/AI_HANDOFF.md` (ese sí está en `main`).
El A1 del relay sigue bloqueado hasta que MediaMTX exija auth por path.

---

## 9. Analítica de video (IA)

Dos capas complementarias:

### 9.1 Servicio Python (`apps/analytics`) — `docs/analytics/ARCHITECTURE.md`

FastAPI que **nunca muere**: el arranque pesado (cv2/onnx/supervision, modelo)
va en hilo de fondo; `/health` y `/status` responden aunque el modelo esté caído.
Estados: `starting/running/degraded/model_error/api_error/stopping`.
`PipelineManager` reconcilia workers desde `GET /api/analytics/internal/cameras`
(secreto compartido). Cada `CameraWorker` (1 hilo/cámara):
`captura → muestreo → provider.infer → ByteTrack → reglas (zonas/líneas/
loitering/aforo) → snapshot → webhook`. RTSP TCP forzado (MediaMTX es TCP-only),
backoff exponencial + circuit breaker (`disabled_due_errors`). Consume el
**restream de MediaMTX** (`ANALYTICS_MEDIAMTX_RTSP`), no abre 2.ª conexión al NVR.

### 9.2 Base de IA en TS (`apps/api/src/services/ai`) — `docs/ai/AI_BASE.md`

Base desacoplada detrás de `AI_EVENTS_ENABLED` (OFF). No es inferencia
productiva: aporta contratos (`contracts.ts`), cola acotada con backpressure
(`queue.ts`), circuit breaker (`circuit-breaker.ts`), proveedor mock
(`mock-provider.ts`), pipeline resiliente (`pipeline.ts`) y ruta demo
determinista (`routes/aiDemo.ts`, ADMIN). **Garantía:** nunca bloquea el video
(`submit` O(1) y no lanza; drain aislado). Se integra vía `StreamConsumerRegistry`
(tipo `analytics`).

### 9.3 StreamConsumerRegistry

`services/stream-consumer-registry.ts`: refcount de consumidores por path
(`acquire/renew/release/count/list/cleanupExpired`), tipos
`live/analytics/recording/diagnostic`, backend Redis + fallback memoria. **Un path
no se borra mientras tenga consumidores vigentes** (`mediamtx_path_kept`).

---

## 10. Notificaciones y alertas

`NOTIFICATIONS.md`, `services/notification.service.ts`, `jobs/healthWorker`.

```
healthWorker → detecta (NVR/cámara offline, HDD lleno/error, auth) → Alert (DB)
  → NotificationService → Email (SMTP) + WebSocket broadcast → NotificationDelivery
```

Configuración en `AlertSettings` (singleton): SMTP, `alertTypes`, `minSeverity`.
Severidades `LOW/MEDIUM/HIGH/CRITICAL`. WebSocket `ws(s)://servidor/ws/alerts`
(JWT validado al conectar; nginx `proxy_read_timeout 3600s`). Arquitectura de
delivery preparada para telegram/whatsapp (no integrados).

---

## 11. Integración Hikvision ISAPI

`HIKVISION_ISAPI.md`, `services/hikvision.ts`. HTTP **Digest Auth** (handshake
completo por Axios). Endpoints usados: `System/deviceInfo`,
`System/Video/inputs/channels`, `ContentMgmt/InputProxy/channels` (cámaras IP),
`ContentMgmt/Storage` (HDD), `Security/users`, `Streaming/channels/{c}01|02`
(encoding), `PTZCtrl/channels/{c}/continuous` (PTZ -100..100),
`Streaming/channels/{c}01/picture` (snapshot), `System/reboot`,
`ContentMgmt/search` (grabaciones). Canales base-1 (canal 3 → `301`/`302`).
Puertos: ISAPI 80, RTSP 554, SDK 8000.

---

## 12. Variables de entorno (flags)

De `.env.example`. **Toda flag C22/nativa/IA está OFF por defecto.**

### Núcleo / seguridad
| Var | Default | Efecto |
|---|---|---|
| `JWT_SECRET` | — (requerido) | Firma JWT (mín. 32). Sin ella el API aborta (`server.ts:72`) |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | 60m / 7d | TTL access/refresh |
| `NVR_CREDENTIAL_KEY` | fallback JWT_SECRET | Clave AES de credenciales NVR |
| `CORS_ORIGINS` | vacío = refleja origin | Lista blanca de orígenes |
| `COOKIE_SECURE` | false | `true` solo con HTTPS |
| `METRICS_TOKEN` | vacío = `/metrics` abierto | Bearer/`?token` para métricas |

### Streaming / sesiones
| Var | Default | Efecto |
|---|---|---|
| `MAX_STREAMS_PER_USER` | 16 | Streams por usuario |
| `MAX_STREAMS_GLOBAL` | 50 | Streams totales |
| `STREAM_IDLE_TIMEOUT` | 90 | TTL sin heartbeat de cliente (15–3600) |
| `STREAM_HD_IDLE_TIMEOUT` | 90 | TTL HD/transcode (hereda el anterior) |
| `CAMERA_STREAM_DEMAND_WINDOW_MS` | 600000 | Ventana de demanda para CAMERA_STREAM_ERROR |
| `CAMERA_STREAM_HLS_PROBE_MAX_PER_CYCLE` | 3 | Sondas HLS por ciclo |
| `CAMERA_OFFLINE_CONFIRM_CHECKS` / `CAMERA_STREAM_ERROR_CONFIRM_CHECKS` | 3 | Confirmaciones |
| `CAMERA_STREAM_DEGRADED_ALERTS` | false | Alertas de degradado |

> `MAX_TRANSCODE_SESSIONS=2` es un invariante interno (no se sube por env).

### Preview de grabaciones (watchdogs)
`RECORDINGS_PREVIEW_AUDIO=1`, `RECORDINGS_PREVIEW_FIRST_BYTE_TIMEOUT_MS=25000`,
`RECORDINGS_PREVIEW_KILL_GRACE_MS=2000`, `RECORDINGS_TERMINATION_WAIT_MS=12000`,
`RECORDINGS_EXIT_CONFIRMATION_MARGIN_MS=3000`, `RECORDINGS_UNCONSUMED_LEASE_MS=45000`,
`RECORDINGS_NVR_CAPACITY_COOLDOWN_MS=120000` (tras 453),
`RECORDINGS_PREVIEW_TOTAL_STARTUP_MS=60000`, `RECORDINGS_PREVIEW_RETRY_DELAY_MS=800`,
`RECORDINGS_PREVIEW_BUDGET_SAFETY_MARGIN_MS=3000`,
`RECORDINGS_PREVIEW_STARTUP_HARD_CAP_MS=120000`,
`RECORDINGS_NVR_SUBSTREAM_TTL_MS=21600000`.

### Analítica
`ANALYTICS_SECRET` (vacío = deshabilitada), `ANALYTICS_URL`,
`ANALYTICS_MEDIAMTX_RTSP`, `ANALYTICS_PROVIDER=yolox_onnx`,
`ANALYTICS_ALLOW_DIRECT_RTSP=false`, `ANALYTICS_ALPR_ENABLED=false`,
`ANALYTICS_FALL_DETECTION_ENABLED=false`, `ANALYTICS_MAX_WORKERS=16`.

### Retención
`ALERTS_RETENTION_DAYS=90`, `DELIVERIES_RETENTION_DAYS=90`,
`AUDIT_RETENTION_DAYS=365`, `ANALYTICS_RETENTION_DAYS=30` (0 desactiva purga).

### Nativo / medios / IA (C22 — todo OFF)
| Var | Default | Efecto |
|---|---|---|
| `NATIVE_PLAYBACK_ENABLED` | false | Registra rutas de grants + decisión por-cámara |
| `NATIVE_MEDIA_RELAY_ENABLED` | false | Emitir grants de transporte relay + endpoint interno de validación |
| `MEDIA_RELAY_SECRET` | vacío | Secreto compartido con el relay (timing-safe) |
| `MEDIA_GRANT_TTL_MS` | 30000 | TTL de grant (5000–300000) |
| `NATIVE_SOURCE_LIFECYCLE_ENABLED` | false | Poller N1 de reconcile de fuente |
| `NATIVE_SOURCE_LIFECYCLE_INTERVAL_MS` | 30000 | Intervalo del reconcile |
| `SINGLE_ACTIVE_MEDIA_SESSION` | false | Sesión de medios única por usuario (N2d) |
| `AI_EVENTS_ENABLED` | false | Pipeline IA + ruta demo |

---

## 13. Invariantes que no se deben romper

De `docs/AI_HANDOFF.md`, `docs/audits/_SHARED_BRIEF.md` y los correctivos C22:

1. **Nunca fabricar, perder ni declarar inválida una grabación** sin evidencia
   verificable.
2. **RBAC estricto:** un usuario solo ve cámaras, grabaciones y PTZ permitidos.
3. **Un stream se libera solo cuando no tiene espectadores/sesiones vivos**; no
   depender solo de temporizadores. `lastMediaActivity` y `processAlive` **no**
   prolongan ni reinician una sesión.
4. **Cambios de viewport invalidan** timers, colas, solicitudes y respuestas
   obsoletas. Una respuesta vieja no puede iniciar/reactivar/publicar un stream
   (barrera `requestTicket`, `server.ts:96`).
5. **Ciclo de vida explícito** de FFmpeg/MediaMTX y cierres terminales.
6. **Nunca** registrar/versionar IPs internas reales, usuarios, contraseñas de
   NVR, JWT, cookies, claves, URIs RTSP/HLS ni video (en respuestas, logs,
   métricas o tests).
7. **No** subir `MAX_TRANSCODE_SESSIONS` (=2). **No** bajar el TTL de seguridad de
   90 s. La palanca contra el límite de transcodes es el **playback nativo**.
8. **Flags nuevas OFF por defecto** ⇒ con flags off, comportamiento idéntico a
   C21. **A1 (relay) = NO-GO.** No tocar producción/Nginx/MediaMTX/Docker/`main`.
9. Preservar invariantes C1–C21: capacidad, liberación de procesos, leases,
   retenciones, `processInstanceId`, cierre exacto, retry, protección A/B.

---

## 14. Seguridad

`SECURITY.md`, `docs/security/SECURITY_AUDIT.md`, threat model nativo.

- **Contraseñas de usuario:** bcrypt (`passwordHash`). Historial de 5, lockout,
  política configurable (`SecuritySettings`), 2FA TOTP, refresh con rotación y
  detección de replay (revoca la familia).
- **Credenciales NVR:** AES (crypto-js) con `NVR_CREDENTIAL_KEY`
  (`services/credentials.ts`); nunca en respuestas ni logs (enmascaradas). Si la
  clave cambia, deben re-ingresarse.
- **URLs RTSP:** siempre enmascaradas (`admin:***@...`) en logs, respuestas,
  auditoría y scripts.
- **JWT:** HS256, Bearer en `localStorage`; refresh en tabla `sessions` con
  IP/User-Agent. Mutex de refresh en `apps/web/src/lib/api.ts`.
- **Grants de medios:** hash-only, uso único, TTL corto, epoch, fail-closed (§8).
- **Auditoría:** tabla `audit_logs` (userId, action, resource, detail, ip, UA).
- **Endpoints internos analytics:** secreto compartido con comparación
  timing-safe. `/metrics` con `METRICS_TOKEN` opcional.
- **CORS/Helmet:** `server.ts` (CSP básica, CORS por env). Manejo global de
  errores (ZodError→400, sin stack al cliente).
- **MediaMTX** hoy acepta `user: any`: la red/firewall es parte de la frontera;
  no exponer el puerto 9997 (API admin) ni 8554/8888/8889 fuera de la red
  confiable. Un `streamPath` **no** es credencial fuerte.
- **Estado de la auditoría:** la mayoría ✅; parciales 🟡: **IDOR** (checks
  presentes, falta test automatizado de acceso cruzado), **SSRF** (hosts
  configurados, sin fetch de URLs arbitrarias) y **uploads** (tamaño/MIME
  acotados). Recomendaciones abiertas: tests de permisos/IDOR, rotación de
  secretos documentada, `METRICS_TOKEN`/`CORS_ORIGINS` explícitos en producción.

---

## 15. Despliegue y operación

`DEPLOY.md`, `docker-compose.yml`, `Makefile`, `scripts/`.

Servicios (compose): `postgres`, `redis`, `mediamtx`, `api`, `web`, `analytics`,
`nginx`, `certbot`. Puertos host: 80/443 (nginx), 4000 (api), 5432/6379/9997
(restringir en prod), 8554/8888/8889 (medios). Despliegue: `bash scripts/deploy.sh
main` (backup DB + build + `prisma migrate deploy` + seed admin). HTTPS por
`infra/certbot/*`. Rollback: `scripts/rollback.sh`. Diagnóstico:
`scripts/check-nvrs.sh`, `probe-camera.sh`, `check-mediamtx.sh`, `check-smtp.sh`.

> Operaciones destructivas (`make clean`, borrar volúmenes, reiniciar servicios,
> migrar, desplegar, fusionar, force-push) **requieren autorización expresa**.

---

## 16. Estado actual: hecho / pendiente

### Hecho / verificado (Node/TS)
- Pipeline de streaming C1–C21 endurecido (capacidad, cierres, ownership por
  pestaña, protección de respuestas viejas). Suites extensas en
  `services/stream-manager*.test.ts`.
- Plano de grants C22/.1/.2 + N1/N2 + Track2 + Track3: `apps/api`, `apps/web`,
  `apps/native/shared` con `tsc` limpio y vitest verde; mutaciones (M1–M19)
  detectadas (`tools/mutation-run.mjs`).
- Preview de grabaciones (fMP4), búsqueda ISAPI paginada, calendario, descarga
  con token, watchdogs de FFmpeg.
- StreamConsumerRegistry (Redis + fallback), base de IA (cola/breaker/mock),
  notificaciones (email + WS), auditoría, RBAC granular, 2FA, métricas Prometheus.

### Pendiente / no validado en el entorno de desarrollo
- **N1 en vivo:** el lister real de `/v3/paths/list` no se ejerció contra un
  MediaMTX vivo; no pagina. Ruta real **NO VALIDADA en vivo**.
- **Atomicidad de `EVAL` en Redis real** (solo lógica validada vía wasmoon).
- **Adopción de `waitForCapacity`** por un llamador real (hoy solo observa).
- **Forma durable (Redis) de la sesión activa** para N2d multi-worker.
- **Cliente nativo Rust/Tauri:** skeleton no compilado; sin binarios.
- **Relay autenticado (A1/N1):** NO-GO; `NATIVE_MEDIA_RELAY_ENABLED=false`.
- **Docker/`docker compose config`, analytics Python en runtime, cargo/Tauri:**
  no validados en el entorno de desarrollo.
- **Scaffolds:** detección de caídas y ALPR (requieren modelos con licencia
  compatible); canales WhatsApp/Telegram/SMS (solo arquitectura de delivery).
- **Deuda conocida:** test automatizado de IDOR/acceso cruzado; rotación de
  secretos documentada (ver `docs/audit/*`, `SECURITY_AUDIT.md`).

---

## 17. Prioridades del usuario

De `docs/audits/_SHARED_BRIEF.md`:

1. **Robustecer con patrones de 2 proyectos externos** (portados a TS, detrás de
   flags, con tests):
   - **Servicio ONVIF:** WS-Discovery + GetStreamUri + PTZ + imaging.
   - **Provider Hik-Connect:** token cloud + HLS temporal + ISAPI-proxy; cuidar
     **SSRF y secretos**.
2. **Atacar 2 dolores:**
   - **Límite de 2 transcodes** — NO subirlo; la palanca real es el **playback
     nativo** (HEVC por hardware, §8).
   - **Playback de grabaciones** — robustez del preview/continuidad; SDK nativo
     solo si aparecen NVR con tracks RTSP de playback limitados (§4.4).
3. **Siempre mejorar y robustecer sin romper invariantes** (§13).

> ONVIF y Hik-Connect **aún no existen** en el árbol de código (no hay
> `services/onvif` ni `providers/hik-connect`). Son trabajo propuesto, sujeto a
> flags OFF, tests y revisión de SSRF/secretos.

---

## 18. Registro de lo solicitado y lo realizado

### Lo solicitado por el usuario
- Montar un **equipo multi-agente** de auditoría + desarrollo sobre VisionCore.
- **Robustecer** el sistema con patrones de dos proyectos externos: un **servicio
  ONVIF** y un **provider Hik-Connect** (portados a TS, detrás de flags, con
  tests, cuidando SSRF y secretos).
- **Atacar los 2 dolores:** el límite de 2 transcodes (vía playback nativo, sin
  subir el límite) y el playback de grabaciones.
- Mantener siempre los invariantes de negocio y las restricciones duras.

### Lo realizado en esta sesión (equipo multi-agente, rama `claude/multi-agent-project-audit-hf14wq`, PR #162)

**Base y auditoría (Ciclo 1):**
- Se **importó el estado c22** (≈ `9fbb01f`) sobre `main` (`620c893`) como commit
  `0b3c2f8`. `main` no fue tocado.
- Se ejecutó la **escuadra de auditoría** (4 agentes solo-lectura): reportes en
  `docs/audits/AUDIT_DEV_ARCH.md`, `AUDIT_DEVOPS.md`, `AUDIT_SECURITY.md`, y la
  **síntesis del líder** en `docs/audits/LEADERSHIP_SYNTHESIS.md` (backlog P0–P3).
- Se generó **esta documentación integral** como fuente única de verdad.

**Desarrollo verificado (compuerta tsc + vitest + mutaciones / compileall + unittest):**
- **Dev 1 — seguridad/robustez:** bump de dependencias a **0 hallazgos npm audit**;
  **apagado elegante SIGTERM/SIGINT** con cierre de FFmpeg; **redacción de IPs
  internas** en la doc versionada (invariante #6).
- **Dev 2 — plano de grants:** recuperación de **revocación durable** cableada a
  reconexión Redis (P1); **`issueGrant` atómico** vía EVAL Lua; **paginación de
  `/v3/paths/list`** (lista truncada no autoritativa); **verificación de scope**
  no tautológica. `vitest 1002/1002`, `mutaciones 19/19`.
- **Dev 3 — integración Frigate:** ingestor en `apps/analytics/app/frigate/`
  (normalize/camera_map/derive/client/mqtt_consumer/ingestor) que alimenta el
  dashboard vía el ya-existente `POST /api/analytics/internal/events`, detrás de
  `FRIGATE_ENABLED=false`. HTTP polling funcional, MQTT scaffold. Cero cambios en
  API/DB/web. Diseño en `docs/frigate/INTEGRATION_DESIGN.md`. `unittest 79/79`.
- **Dev 4 — endurecimiento aprobado:** credenciales NVR migradas a **AES-256-GCM**
  (`node:crypto` + scrypt) con **descifrado legacy retrocompatible** y clave
  **obligatoria en prod** (fail-fast) / warning en dev; puertos MediaMTX
  **atados a 127.0.0.1**; bugfixes de `deploy.sh` (backup DB) y `setup.sh`
  (generación de secretos). `vitest 1008`.

**Diseño (sin habilitar):** plan del **relay A1 autenticado** vía hooks HTTP de
MediaMTX contra el plano de grants, en `docs/native/A1_RELAY_DESIGN.md`. A1 sigue
NO-GO (`NATIVE_MEDIA_RELAY_ENABLED=false`).

**Decisiones tomadas por el humano:** (1) deuda antes que ONVIF/Hik-Connect;
(2) atar MediaMTX a 127.0.0.1 — hecho; (3) `NVR_CREDENTIAL_KEY` obligatoria en
prod — hecho; (4) diseñar A1 sin habilitar — hecho.

### Ciclo 2 de robustez (rama reiniciada sobre `main` mergeado)

Auditoría de robustez en `docs/audits/ROBUSTNESS_CYCLE2.md`. Implementado y verificado:
- **Robustez segura** (sin cambio de comportamiento): logging de IPs enmascarado
  (invariante #6), try/catch por cámara en re-registro al arranque, `forget()` de
  sesión de medios en logout, `/metrics` timing-safe, handler `on('error')` de
  Redis, cota de tamaño del snapshot de Frigate.
- **Endurecimiento aprobado**: pin de imágenes docker (mediamtx 1.9.3, certbot
  v3.0.1, frigate 0.14.1, postgres/redis/nginx a minor); healthchecks web/
  analytics/frigate + `nginx` espera `web` sano; recarga periódica de nginx para
  tomar certs renovados; `upgrade-to-https.sh` ya no regresiona la nginx.conf
  endurecida; **CORS** por defecto sin reflejar origin+credenciales (solo
  localhost sin allowlist); `POSTGRES_PASSWORD` y credenciales del seed **por env**
  (admin sin password por defecto conocido).
- Verificación: `tsc` 0 · `vitest` 1233 · YAML/bash OK. El comportamiento
  de la app queda idéntico salvo lo aprobado (CORS default + defaults de deploy).
- **Sub-lote menor (Ciclo 2)** — implementado y verificado (tsc 0 · vitest 1268):
  seed de usuarios demo por env (`SEED_DEMO_USERS`; sin passwords conocidos en
  deploy real); rate-limit con store en Redis si `REDIS_URL` (degrada seguro sin
  él); tests de regresión IDOR (`rbac-idor.route.test.ts`); CSP más estricta
  (`scriptSrc` sin `unsafe-inline` + `scriptSrcAttr 'none'`; `styleSrcElem/Attr`
  conservan inline por el theming dinámico y los `style=` de React); y **scope de
  alertas/eventos por permiso de cámara** (`canView`) en listado, conteos, summary,
  mutaciones y broadcast WS (ADMIN sin restricción; alertas sin `cameraId` siguen
  globales; `alerts.route.test.ts`).
- **Scope de eventos de Analítica por cámara** ✅: `/events`, `/summary` (todas
  las agregaciones) y `/live-frame/:cameraId` scopeados por `canView` (ADMIN sin
  restricción; SUPERVISOR/AUDITOR solo sus cámaras); `analytics.route.test.ts`.
- Pendientes menores restantes: healthcheck de mediamtx (imagen `scratch`,
  requiere cambio de imagen — decisión); revocación de permisos no cierra
  conexiones WS vivas (aplica en el siguiente broadcast).

### Todavía no realizado (siguiente desarrollo)
- **ONVIF** ✅ y **Hik-Connect** ✅ implementados (flags OFF, con tests) **y
  cableados a la UI**: página admin **Integraciones** (`apps/web/src/pages/IntegrationsPage.tsx`,
  ruta `/integrations` ADMIN-only) con paneles ONVIF (descubrir/perfiles/stream-URI/
  PTZ/imaging) y Hik-Connect (token/HLS temporal/ISAPI-proxy), alimentados por
  `GET /api/integrations/status` (siempre disponible; muestra "deshabilitado"
  cuando la flag está OFF). Falta validación con hardware/cuenta reales.
- **Despliegue de Frigate**: artefactos listos y validados (servicio opt-in bajo
  profile `frigate` en docker-compose, `infra/frigate/config.example.yml`, env, y
  runbook `docs/frigate/DEPLOYMENT.md`). Falta correrlo en el servidor real
  (`docker compose --profile frigate up`), completar `config.yml` con cámaras
  reales y validar el flujo end-to-end.
- **A1 Fase F0** (código del auth-hook + session-grant, flag OFF) si se autoriza.
- Cliente nativo (Tauri/Rust) por plataforma; adopción real de `waitForCapacity`.

> ⚠️ **Nota de migración (producción):** con este cambio, el arranque del API
> **falla si `NVR_CREDENTIAL_KEY` no está definida** en producción. Antes de
> desplegar, definirla (`openssl rand -hex 32`). Si la instalación previa cifró
> con `JWT_SECRET` o el default, mantener ese valor disponible (la ruta legacy lo
> usa para descifrar) o re-guardar cada credencial (se re-cifra a GCM).

---

## 19. Marcadores para completar

> Estas secciones se completan a medida que avance el desarrollo. Mantener este
> documento como fuente única de verdad y actualizar la fecha del encabezado.

- [x] **ONVIF (nuevo):** implementado en `apps/api/src/services/onvif/*`, flag
  `ONVIF_ENABLED=false`. Núcleo puro (SOAP builders, WS-Security digest, parsers,
  WS-Discovery) + I/O inyectable (SOAP HTTP, UDP multicast). SSRF LAN-only +
  bloqueo de metadatos cloud; XXE-safe; credenciales nunca logueadas. Ruta ADMIN
  guardada por flag. 80 tests. _Falta validación con cámaras reales._
- [x] **Hik-Connect (nuevo):** implementado en
  `apps/api/src/services/providers/hik-connect/*`, flag `HIK_CONNECT_ENABLED=false`.
  Token cloud (appKey/secretKey→accessToken+areaDomain), HLS temporal (TTL≤600),
  ISAPI-proxy con validación estricta de path (anti-SSRF) + validación de
  areaDomain; AppKey/SecretKey/accessToken tratados como secretos. Ruta ADMIN
  guardada por flag. 73 tests. Limitación: H.264, sin HEVC/transcode. _Falta
  validación con cuenta Technology Partner real._
- [x] **N1/A1 relay autenticado:** diseño completo en `docs/native/A1_RELAY_DESIGN.md`
  (hooks HTTP de MediaMTX + session-grant + revoke→kick). _Sin implementar/habilitar._
- [ ] **Cliente nativo:** resultados de compilación Tauri/Rust, adaptadores por
  plataforma, benchmarks 1/4/9 cámaras HEVC. _(Skeleton.)_
- [x] **Hallazgos de auditoría:** consolidados en `docs/audits/LEADERSHIP_SYNTHESIS.md`
  + reportes por área (`AUDIT_DEV_ARCH.md`, `AUDIT_DEVOPS.md`, `AUDIT_SECURITY.md`).
- [x] **Frigate (nuevo):** ingestor en `apps/analytics/app/frigate/`, flag
  `FRIGATE_ENABLED`, diseño en `docs/frigate/INTEGRATION_DESIGN.md`. Despliegue
  listo (profile `frigate` en compose + `infra/frigate/config.example.yml` +
  runbook `docs/frigate/DEPLOYMENT.md`). _Falta correrlo en servidor real._
- [ ] **Playback de grabaciones:** métricas reales de robustez del preview;
  decisión sobre Opción A (SDK) si aparece `RTSP_AUTH_OR_TRACK_DENIED` persistente.
- [ ] **Validaciones en vivo:** `docker compose config`, Redis/Lua real, analytics
  Python en runtime, lister real de MediaMTX.
- [ ] **Deuda de seguridad:** test automatizado de IDOR/acceso cruzado; rotación
  documentada de `JWT_SECRET`/`NVR_CREDENTIAL_KEY`/`ANALYTICS_SECRET`.

---

### Apéndice — documentos de referencia

Raíz: `README.md`, `STREAMING.md`, `RECORDINGS_SDK_PLAN.md`, `SECURITY.md`,
`DEPLOY.md`, `TROUBLESHOOTING.md`, `HIKVISION_ISAPI.md`, `NOTIFICATIONS.md`,
`LICENSES.md`, `CLAUDE.md`.
`docs/`: `AI_HANDOFF.md`, `audits/_SHARED_BRIEF.md`, `ai/AI_BASE.md`,
`analytics/*`, `architecture/SYSTEM_ARCHITECTURE.md`, `audit/*`,
`development/*`, `native/*` (ADR-0001, C22_*, N1_N2_WIRING, TRACK2/3,
LIVE_CLIENT_ARCHITECTURE, METRICS_LIVE_STARTUP), `recordings/ARCHITECTURE.md`,
`runbooks/*`, `security/*` (SECURITY_AUDIT, THREAT_MODEL_NATIVE_MEDIA),
`phase-a1-session-heartbeat-truth.md`.
