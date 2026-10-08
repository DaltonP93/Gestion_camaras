# Política única de permisos — VisionCore

> Estado: **PROPUESTA** (parte de #185). Fecha: 2026-10-08. Se define **antes de conectar la interfaz
> nueva**; no autoriza cambios de código, migraciones, despliegues ni cambios de permisos reales.
> Describe el código de la rama de revisión conjunta `17a8597` (`main` `94305f3` + #182 + #186 + #189
> + #190), leído sin ejecutar nada contra servidores ni NVR. Fuente: inventario por lectura de código de
> cuatro áreas (vivo, grabaciones, dispositivos y administración) más verificación directa en el
> código de cada contradicción del inventario (§10).
> Evidencia `archivo:línea` relativa a `apps/api/src/`; los `.tsx` son de `apps/web/src/` y `prisma/…`, de la raíz.
> Complementa y no reemplaza: `docs/frigate/SCREEN_FUNCTION_MATRIX.md` (funciones y hallazgos `H#`),
> `docs/frigate/NATIVE_INTEGRATION_PROPOSAL.md` §9 (decisiones) y `docs/SECURITY.md` (postura y riesgos).

## 0. Resumen

- **Hoy no hay una política: hay siete resolutores.** La decisión "¿puede este usuario con esta cámara?" está
  implementada por separado en `services/access-policy.ts`, `services/camera-scope.ts`,
  `cameras.ts:37` (`userCanAccessCamera`), `liveView.ts:44` (`viewableCameraIds`),
  `services/media/grant-derivation.ts:70` + `native-readiness.ts:77`, `websocket.ts:33`, `search.ts:25-60`
  y cinco copias inline en `recordings.ts` (`:1411`, `:1454`, `:1500`, `:1595`, `:2018`). Cada una
  resuelve distinto el rol SUPERVISOR, la herencia NVR→cámara y el AUDITOR.
- **Esta política fija un modelo:** el **rol es el techo** (qué acciones puede llegar a tener alguien)
  y las **filas de permiso son el alcance** (sobre qué cámaras y NVR). Una fila de NVR hereda a todas
  sus cámaras, en todos los endpoints, sin excepciones.
- **Reproducir no es exportar.** Convertir video para verlo (preview fMP4, MP4 progresivo al
  reproductor, `main_h264`) exige permiso de **reproducción**; generar y descargar un MP4 para
  conservarlo exige permiso de **exportación**. La separación es pauta del dueño; que la exportación se
  exprese con `canDownload` por cámara con herencia es la propuesta de **D5a**. Hoy son lo mismo.
- **Visores personales para todos los roles**, con las cámaras recortadas siempre a los permisos
  vigentes de quien mira. Los compartidos y públicos los administra quien corresponda (§6).
- **SUPERVISOR queda como decisión del dueño (D1)**, con dos opciones descritas por endpoint y una
  recomendación técnica (§4). No se da por tomada.
- La aplicación propuesta es **un único módulo** con una función por acción, un actor resuelto con
  rol, estado y versión **vigentes** en cada petición, y una **prueba de contrato** que falla si una ruta
  registrada no declara su acción (§7).

## 1. Principios

| # | Principio | Qué exige | Hoy (síntesis) |
|---|---|---|---|
| P1 | **Denegar por defecto** | Sin regla explícita que conceda, se niega. Una ruta sin acción declarada no se registra (prueba de contrato, §7.5). Las filas nuevas no conceden nada que no se marque. | `canView`, `canViewCameras` y `canViewLive` valen `true` por defecto en el esquema (`prisma/schema.prisma:278, 284, 293`). Varias rutas sólo exigen `authenticate` y entregan datos de todos (`liveView.ts:226`). |
| P2 | **Un solo módulo de decisión** | Toda decisión de acceso por rol o recurso pasa por `services/access-policy.ts` (§7.1). Las rutas declaran la acción; no copian consultas a `userPermission`. | Siete resolutores más cinco copias inline (§0). `middleware/requireAuth.ts` está muerto. |
| P3 | **Chequeo en servidor, por recurso** | Cada petición que toca una cámara, un NVR, una grabación o un visor decide sobre **ese** recurso. La UI sólo refleja lo que el servidor devuelve como permitido. | La UI decide por rol (`App.tsx`, `Sidebar.tsx`) y hay botones que reciben 403 (H41). |
| P4 | **Permisos vigentes en cada petición y latido** | Rol, `active` y filas se leen (o se validan contra una versión) en cada petición, heartbeat y segmento HLS; nunca se confía en el rol del JWT para decidir. | Las filas sí se leen por petición; el **rol y `active` salen del JWT** (`plugins/auth.ts:102-131`) hasta que vence (60 min por defecto, configurable hasta 24 h con `sessionTimeoutMinutes`: `auth.ts:661, 974`, `services/security-policy.ts:24, 35`). Sólo `POST /api/auth/ws-ticket` (`auth.ts:934`) y el reparto de alertas WS (`websocket.ts:49-52`) miran la base. |
| P5 | **Revocación efectiva** | Quitar un permiso, cambiar el rol, desactivar, borrar, resetear 2FA o cambiar la contraseña corta en el siguiente uso **todo** lo derivado: access token, WS, grants, sesiones de vivo, previews, VOD y tokens de descarga (§7.2). | Sólo se revocan grants de medios y WS, y sólo en algunos eventos (`users.ts:330-376`, `:440-477`). Previews, VOD y descargas de 24 h sobreviven (H10). |
| P6 | **Mínimo dato** | Cada respuesta devuelve sólo lo necesario para la acción. Nunca usuario, contraseña (ni cifrada), IP, puertos o serie del NVR a quien no administra el NVR; nunca datos de otros usuarios a quien no los administra. El navegador no guarda permisos con datos de infraestructura. | `GET /api/auth/me` devuelve la fila completa del NVR y la web la persiste en `localStorage` (H4); `/cameras*` devuelve `nvr.ipAddress` (H13). |
| P7 | **Permiso antes que existencia** | Se responde igual (403 o 404 uniforme, a definir en el módulo) a "no existe" y "no tenés permiso". | `recordings.ts:1412-1415`, `cameras.ts:342-346`: 404/400 antes de 403 (H39). |
| P8 | **Auditar el acceso a evidencia y las mutaciones** | Reproducir, exportar, descargar, mover PTZ y toda mutación de configuración o permisos dejan registro con actor y diff. | `GET /download`, calendario, CRUD de visores, `PUT /cameras/:id`, resolver alertas y `PUT /alerts/settings` no se auditan (H28). |
| P9 | **Una sola fuente para la UI** | La interfaz obtiene sus permisos efectivos de un endpoint calculado por el **mismo** módulo (propuesto `GET /api/auth/me/access`), no de reglas propias ni de filas crudas. | `GET /users/:id/effective-permissions` no calcula herencia ni bypass y no lo consume nadie (`users.ts:385-437`). |
| P10 | **Modelo aditivo** | Los permisos se suman (unión); no hay filas de negación. Una restricción se expresa no concediendo. | Igual hoy; la ambigüedad viene de que cada resolutor suma cosas distintas (§3). |

## 2. Roles, acciones y alcance

### 2.1 Modelo: techo por rol + alcance por recurso

- **Rol (techo).** El enum `Role` (`prisma/schema.prisma:15-20`) fija qué **acciones** puede llegar a
  tener un usuario. Una fila de permiso nunca da una acción que el rol no tiene (p. ej. `canPlayback`
  a un OPERATOR no le abre grabaciones si su techo no incluye reproducir; ver D2).
- **Filas `UserPermission` (alcance).** Dicen **sobre qué cámaras/NVR** se ejerce cada acción de
  recurso. Fila de NVR = `{nvrId, cameraId: null}`; fila de cámara = `{cameraId}` (§3).
- **Acciones de sistema** (usuarios, SMTP, seguridad, auditoría, diagnóstico global, NVR admin) no
  tienen alcance: las decide sólo el rol.
- **Feature flags (`UserFeaturePermissions`)**: hoy el backend sólo lee `canViewDashboard`
  (`services/dashboard-policy.ts`) y `canManageAppearance` (`services/appearance-policy.ts`). La política
  no los usa como segunda fuente para la misma acción; su destino es la decisión D4.

### 2.2 Catálogo de acciones

Cada acción es un identificador estable que declaran las rutas y que resuelve el módulo (§7.1).

| Acción | Qué cubre | Recurso | Flag de la fila (heredable de NVR) |
|---|---|---|---|
| `live.view` | Grilla y foco en calidad estándar: heartbeat, `start-stream` `sub`, segmentos HLS `_sub`, grant nativo `sub`, estado del path | cámara | `canView` |
| `live.hq` | Alta calidad **pedida por el usuario**: `main` o `main_h264` en foco y su HLS `_main`/`_main_h264`. Cuando el servidor usa `main`/`main_h264` por compatibilidad (sub HEVC redirigido, `USING_MAIN_STREAM`, grant nativo `main` derivado del códec) el mismo path cuenta según **D6** | cámara | `canHighQuality` (+ `live.view`) |
| `live.ptz` | Movimiento, zoom, STOP (y presets cuando existan) | cámara con `ptzEnabled` | `canPtz` (+ `live.view`) |
| `live.snapshot` | JPEG en vivo pedido al NVR (`GET /cameras/:id/snapshot`, fondo del editor de zonas) | cámara | según D5d |
| `camera.status` | Estado mínimo de salud del tile, sin usuario/IP del NVR y **sin sondas** (nuevo, separado del diagnóstico) | cámara | el de la acción de la pantalla |
| `camera.diagnose` | Sondas RTSP, `debug-stream`, `test-rtsp`, `validate-stream` | cámara | — (rol) + alcance según D1 |
| `recordings.play` | Buscar, calendario, timeline, preview fMP4, MP4 progresivo para el reproductor | cámara | `canPlayback` |
| `recordings.export` | Generar un MP4 para conservar y descargarlo | cámara | `canDownload` (+ `recordings.play`), propuesta sujeta a **D5a** |
| `events.view` | Alertas de cámara, eventos de análisis, snapshots y clips de evento; alertas de NVR por alcance de NVR | cámara / NVR | `canView` (cámara); cualquier acceso al NVR para alertas sin cámara (D8) |
| `alerts.ack` | Marcar una alerta como leída **para sí** | alerta visible | dentro de `events.view` |
| `alerts.resolve` | Resolver una alerta (cierra evidencia) | alerta visible | — (rol) + alcance |
| `camera.configure` | `PUT /cameras/:id`, renombrar, `ptzEnabled`, `active`, `audioMode`, reiniciar stream | cámara | — (rol) + alcance según D1 |
| `detection.configure` | Detección, zonas, máscaras, alertas por tipo | cámara | — (rol) + alcance según D1 |
| `nvr.read` | Ficha, estado, discos, capacidad de grabación: recursos de **todo** el dispositivo | NVR | `canView` en **fila de NVR** (una fila de cámara no alcanza) |
| `nvr.maintain` | Sincronizar, revalidar, onboarding, canales libres, chequeo de capacidad | NVR | — (rol) + alcance según D1 |
| `nvr.admin` | Alta, baja, edición, credenciales, reinicio, cuentas del NVR, escritura de video/audio, adopción, migración, publicación de streams, herramientas ONVIF/Hik-Connect | NVR / dispositivo | — (sólo ADMIN) |
| `users.manage` | Usuarios, permisos, sesiones y 2FA de otros | sistema | — |
| `alerts.settings` | SMTP, canales, destinatarios, historial de entregas | sistema | — |
| `security.settings` | Política de sesión, bloqueo, contraseña y MFA | sistema | — |
| `recordings.settings` | Política global de audio del preview (y límites de reproducción cuando sean editables) | sistema | — |
| `audit.view` | Registro de auditoría | sistema | — |
| `system.diagnostics` | Sesiones de todos, transcodes, capacidad por NVR, salud de cámara global | sistema | — |
| `appearance.manage` | Tema, marca, logos | sistema | — (D4) |
| `views.personal` | Crear, editar y borrar visores propios privados | visor propio | — (las cámaras de los slots se acotan, §6) |
| `views.share` | Compartir un visor con una lista de usuarios | visor propio | — |
| `views.publish` | Marcar un visor como público | visor | — |
| `views.view` | Abrir visores accesibles; los slots se filtran por la acción de la pantalla | visor | — |
| `self` | Perfil, contraseña, 2FA, sesiones propias, "mi acceso" | propio | — |
| `camera.list` | Listas de cámaras (`/api/cameras`, `/batch`): devuelve la unión de `scopeFor` de las acciones de cámara de la pantalla, con proyección mínima (P6) | cámaras del alcance | el de cada acción |
| `nvr.list` | Lista de NVR: los del alcance, con datos de dispositivo sólo para quien tiene `nvr.read` y credenciales sólo para `nvr.admin` | NVR del alcance | el de cada acción |
| `channel.read` | Configuración de video de un canal (lectura): `live.view` del canal o `nvr.read` | canal | `canView` (cámara) o fila de NVR |
| `dashboard.view` | Conteos del tablero, calculados sobre el alcance del usuario | alcance | — (D4: `canViewDashboard`) |
| `authenticated` | Cualquier sesión válida, sin recurso ni datos sensibles (capacidades del cliente, estado de integraciones) | — | — |
| `public` / `service` | Login, recuperación, salud, `GET /api/appearance`, assets de branding de `/uploads/branding/*`; endpoints servicio a servicio con secreto y red interna | — | — |

### 2.3 Tabla rol × acción × alcance (propuesta)

"Alcance" = cámaras/NVR donde la fila efectiva (§3) tiene el flag. "A/B" = depende de D1 (§4): A =
global, B = acotado por filas. Las celdas con **D#** dependen de esa decisión.

| Acción | ADMIN | SUPERVISOR | OPERATOR | AUDITOR | Hoy (diferencia principal) |
|---|---|---|---|---|---|
| `live.view` | todas | A: todas · B: alcance | alcance | — (**D2**) | Sin herencia salvo `hls-auth`; AUDITOR bloqueado sólo en `GET /:id/stream` y `/snapshot` (`cameras.ts:124, 322`) |
| `live.hq` | todas | A: todas · B: alcance | alcance | — (**D2**) | `canHighQuality` sólo se exige con `NATIVE_PLAYBACK_ENABLED` (`grant-derivation.ts:79-85`) |
| `live.ptz` | todas (`ptzEnabled`) | A: todas · B: alcance | alcance | — (**D2**) | `canPtz` exacto, **sin** exigir `canView` (`cameras.ts:337-355`) |
| `live.snapshot` | todas | A/B | alcance (**D5d**) | — (**D2**) | AUDITOR 403 (`cameras.ts:322`) |
| `camera.status` | todas | A/B | alcance | alcance de su acción | No existe: `GET /:id/diagnostics` sondea y expone usuario/IP (H5) |
| `camera.diagnose` | todas | A: todas · B: alcance | — | — | Abierto a `canView` en `/diagnostics`; rol en el resto |
| `recordings.play` | todas | A: todas · B: alcance | — (**D2**) | alcance | OPERATOR 403 siempre; AUDITOR fila exacta; sin herencia |
| `recordings.export` | todas | A: todas · B: alcance (**D5**) | — (**D2**) | alcance (**D5a**) | Exportar = reproducir; `canDownload` no se lee (H8) |
| `events.view` | todas | A: todas · B: alcance | alcance (**D12** análisis) | alcance | Bypass sólo ADMIN; alertas de NVR a todos (H11) |
| `alerts.ack` | sí | sí | sí | sí | `readAt` global: marca para todos (H12) |
| `alerts.resolve` | todas | A: todas · B: alcance | — | — | Igual (contrato de `docs/SECURITY.md` §2.1), sin auditoría |
| `camera.configure` | todas | A: todas · B: alcance | — | — | ADMIN/SUPERVISOR por rol, sin alcance; sin auditoría salvo el renombrado (`CAMERA_RENAME`, `cameras.ts:745-749`) |
| `detection.configure` | todas | A: todas · B: alcance | — | — | ADMIN/SUPERVISOR sin alcance (`analytics.ts:353-364`) |
| `nvr.read` | todos | A: todos · B: fila de NVR | fila de NVR | fila de NVR | Igual (`access-policy.ts:49`) |
| `nvr.maintain` | todos | A: todos · B: fila de NVR | — | — | ADMIN/SUPERVISOR sin alcance |
| `nvr.admin` | sí | — | — | — | Igual, salvo `onboard` (SUPERVISOR publica streams) |
| `users.manage`, `alerts.settings`, `security.settings`, `recordings.settings`, `audit.view`, `system.diagnostics` | sí | — | — | — (`audit.view` de grabaciones: **D2**) | Igual, salvo `GET /live-view/transcodes` abierto (H20) |
| `appearance.manage` | sí | — (**D4**) | — | — | Override `canManageAppearance` lo habilita a cualquier rol |
| `views.personal` | sí | sí | sí | sí | Sólo ADMIN/SUPERVISOR (`views.ts:75, 102, 137`) |
| `views.share` | sí | sí (**D7**) | — (**D7**) | — (**D7**) | ADMIN/SUPERVISOR, sin validar destinatarios |
| `views.publish` | sí | — (**D7**) | — | — | ADMIN/SUPERVISOR |
| `views.view` | todos (**D7** sobre personales ajenos) | ACL | ACL | ACL | ACL sin filtrar slots; `search.ts` aplica otra regla |
| `self` | sí | sí | sí | sí | Igual |

## 3. Herencia NVR → cámara

### 3.1 Qué hace el código hoy

`UserPermission` es **una sola tabla** para los dos alcances (`prisma/schema.prisma:268-304`), con todas
las columnas en ambas formas de fila. `PUT /users/:id/permissions` graba la fila de cámara con el
`nvrId` de la cámara (`users.ts:355-364`); el `POST` legado acepta `nvrId` y `cameraId` sueltos
(`users.ts:28-35, 456-465`). `@@unique([userId, nvrId, cameraId])` (`schema.prisma:300`) no impide filas
de NVR duplicadas porque PostgreSQL trata los `NULL` como distintos (no verificado contra una base).

| Punto de decisión | ¿Una fila de NVR habilita sus cámaras? | Evidencia |
|---|---|---|
| `GET /internal/hls-auth` | **Sí**: fila de NVR cubre todos los canales; fila de cámara, su canal | `hlsAuth.ts:95` → `access-policy.ts:65-81` |
| `GET /api/nvrs`, `/:id/cameras`, `/:id/video-audio[/:channel]` | **Sí** (`getVisibleNvrMap`, `userCanAccessNvrChannel`) | `nvr.ts:280-331, 470-499, 1669-1735`; `access-policy.ts:88-111` |
| Recursos de todo el NVR (`/:id`, `/status`, `/device-info`, `/storage`, `/recording-capabilities`) | Exigen fila de NVR; una de cámara **no** alcanza | `access-policy.ts:49-58` |
| `GET /api/cameras`, `/batch`, `/:id`, `/stream`, `/stream/status`, `/diagnostics`, `/snapshot`, `/ptz`, `/start-stream` | **No** (fila con `cameraId` exacto) | `cameras.ts:37-46, 51-96`; `camera-scope.ts:9-15` |
| `POST /api/live-view/heartbeat` | **No** (mismo criterio que `start-stream`, #189) | `liveView.ts:44-56` |
| `client-capabilities`, `media-grant` | **No** (`findFirst {userId, cameraId}`) | `services/media/grant-derivation.ts:79-81` |
| Grabaciones (5 handlers) | **No**; además una fila de NVR no tiene `canPlayback` editable por el `PUT` (sólo `canViewRecordings`) | `recordings.ts:1418-1423` y equivalentes; `users.ts:55-65` |
| Alertas REST y WS, analítica, búsqueda global | **No** | `alerts.ts:15-24`; `websocket.ts:48-57`; `analytics.ts:28-31`; `search.ts:46-50` |
| `effective-permissions` | No calcula herencia | `users.ts:385-437` |
| Interfaz | `UserPermissionsModal.inheritFromNvr` **copia** campos del NVR a filas de cámara (incluido `canDownload = canViewRecordings`), pero el componente **no está montado** (sin importadores); la pantalla en uso es `UsersPage` → `POST` legado | `apps/web/src/components/UserPermissionsModal.tsx:234-251` |

Consecuencia (inventario, confirmada en el código): un OPERATOR con `canView` sólo en la fila de NVR
ve la lista en `/api/nvrs/:id/cameras` y obtiene 200 en `hls-auth` para cualquier path publicado de
ese NVR, pero `/api/cameras` le devuelve `[]`, el heartbeat le da `NO_PERMISSION` y `start-stream` 403.

### 3.2 Regla única propuesta (R-H)

1. **Permiso efectivo** de un usuario sobre la cámara `c` para el flag `f`:
   `techo(rol, acción) ∧ ( fila{cameraId = c.id, f = true} ∨ fila{nvrId = c.nvrId, cameraId = null, f = true} )`.
2. **Resolución por la cámara, no por la fila.** El NVR se toma de `camera.nvrId` **en el momento de
   la petición**. El `nvrId` guardado en una fila de cámara se ignora para autorizar; al escribir se
   iguala al de la cámara. Así `POST /cameras/:id/migrate` (`cameras.ts:757`) no deja filas que
   abran el NVR viejo ni dupliquen la de la cámara, y una fila legada inconsistente (`nvrId` de un NVR,
   `cameraId` de otro) no pasa el control del NVR declarado, como hoy ocurre en `userCanAccessNvr` por
   el `OR(nvrId, camera.nvrId)` (`access-policy.ts:31`; el listado posterior sí filtra por
   `camera.nvrId`, pero la ruta ya consultó el NVR por ISAPI).
3. **Sin negaciones.** Un `false` en la fila de cámara **no** quita lo que da la fila del NVR (unión).
   Para "todo el NVR menos la cámara X" se asigna cámara por cámara. Agregar negaciones explícitas es
   la decisión D3 (no recomendado ahora).
4. **Mismos nombres de flag en los dos alcances** (§3.3). La fila de NVR concede las mismas acciones
   por cámara que la fila de cámara.
5. **Recursos de todo el dispositivo** (`nvr.read`, `nvr.maintain`) exigen fila de NVR; una fila de
   cámara nunca los abre (se conserva `userCanAccessNvrWide`).
6. **Acciones compuestas.** `live.hq` y `live.ptz` exigen además `live.view`; `recordings.export`
   exige además `recordings.play`. Hoy un `canPtz` sin `canView` mueve una cámara que el usuario no ve.
7. **Listas.** El módulo devuelve un alcance `{ all } | { cameraIds, nvrIdsAll }` y la consulta usa
   `id IN cameraIds OR nvrId IN nvrIdsAll`; nunca se expande en el cliente.
8. **Unicidad.** Índice único parcial `(userId, nvrId) WHERE cameraId IS NULL` (migración que requiere
   autorización). Con la regla de unión, una fila duplicada no cambia la decisión, pero sí rompe el
   `upsert`.

### 3.3 Flags por alcance (mapa de migración)

No requiere migración de esquema: todas las columnas ya existen en las dos formas de fila. Cambian el
editor y los esquemas Zod (`users.ts:55-77`).

| Flag | Fila de cámara | Fila de NVR | Hoy | Propuesta |
|---|---|---|---|---|
| `canView` | sí | sí | NVR: sólo `hls-auth` y `nvr.ts` | Ambos, regla R-H |
| `canHighQuality` | sí | sí | NVR: no editable por `PUT`; sí por `POST` legado | Ambos |
| `canPtz` | sí | sí | Sólo `POST` legado; el `PUT` no lo admite (`users.ts:67-77`) | Ambos, editables en el editor único |
| `canPlayback` | sí | sí | NVR: el `PUT` usa `canViewRecordings` | Ambos; `canViewRecordings` → `canPlayback` |
| `canDownload` | sí | sí | No se lee en ningún endpoint | Ambos; requisito de `recordings.export` |
| `canViewCameras` (NVR), `canViewLive` (cámara) | — | — | No se leen | Retirar (equivalen a `canView`) |
| `canUseMainStream` | — | — | No se lee | Retirar (equivale a `canHighQuality`) |
| `canUseTranscode`, feature `canTranscode` | — | — | No se leen; ya retirados del modal (#171) | Retirar: transcodificar para ver no exige permiso (§5) |
| `canAddToViews`, feature `canManageViews` | — | — | No se leen | Retirar: los visores se filtran por `live.view` (§6) |
| `canReceiveAlerts` | — | — | No se lee; no hay notificación por usuario | D4 |
| `canManage`, `canEditVideoAudio`, `canSync`, `canRevalidate`, `canRestart` (NVR) | — | — | No se leen | D4 (retirar de la UI hasta que exista gestión delegada) |

## 4. SUPERVISOR

### 4.1 Estado actual por endpoint

`isPrivilegedRole` trata a SUPERVISOR igual que a ADMIN (`access-policy.ts:18-20`), pero no todos lo usan.

| Grupo de endpoints | SUPERVISOR hoy | Evidencia |
|---|---|---|
| Cámaras: lista, lote, detalle, `stream`, `status`, `diagnostics`, `snapshot`, `start-stream`, PTZ | **Sin restricción por recurso** | `cameras.ts:37-46, 56, 83-96` |
| Heartbeat de vivo | Sin restricción | `liveView.ts:48` |
| `hls-auth` | 200 para cualquier path | `hlsAuth.ts:95` → `access-policy.ts:18-20, 69` |
| `client-capabilities`, `media-grant` (incluido HD) | Sin restricción | `grant-derivation.ts:79-81`; `native-readiness.ts:78` |
| `restart-stream`, `test-rtsp`, `validate-stream`, `debug-stream`, `PUT`/`PATCH` de cámara | Por rol, sobre cualquier cámara | `cameras.ts:281, 297, 637, 659, 714, 724` |
| NVR: lectura (`/`, `/:id`, `status`, `device-info`, `storage`, `cameras`, `video-audio`, `recording-capabilities`) | Sin restricción | `nvr.ts:280-499, 1340, 1669-1735` |
| NVR: `sync`, `sync-cameras`, `force-names-sync`, `validate-health`, `onboard`, `GET users`, `free-channels`, capacidades, `recording-capabilities/check`; `nvrConfig` GET | Por rol, sobre cualquier NVR | `nvr.ts:435, 527, 689, 945, 1033, 1070, 1371, 1488, 1737`; `nvrConfig.ts:18, 50, 260` |
| NVR: alta, edición, baja, reinicio, cuentas del NVR, escritura de video/audio, adopción, `sync-streams`; `migrate` de cámara | 403 | `nvr.ts:931, 1053, 1218, 1287, 1330, 1421, 1498, 1561-1643, 1760`; `cameras.ts:757` |
| Grabaciones: búsqueda, calendario, lote, `playback`, `preview` | Sin chequeo por recurso; obtiene `downloadUrl` de cualquier cámara | `recordings.ts:1407-1607, 2016-2032` |
| Sesiones de VOD/preview | Sólo las propias (dueño o ADMIN) | `recordings.ts:1811, 1902, 3262, 3706` |
| `settings/audio` GET / PUT; `audit`; diagnósticos de grabaciones | lee / 403 / 403 / 403 | `recordings.ts:1383, 1389, 1995, 3355, 3670` |
| Búsqueda global | Todas las cámaras (con IP), NVR, **visores privados ajenos** y alertas sin alcance | `search.ts:25, 89, 116-129, 148` |
| Alertas REST y WS; resolver | **Acotado** a filas de cámara con `canView` + alertas sin cámara; resuelve dentro de ese alcance | `alerts.ts:15-24, 122`; `websocket.ts:48-57` |
| Analítica `events`, `summary`, `live-frame` | **Acotado** a filas de cámara (normalmente ninguna: ve vacío o 403) | `analytics.ts:28-31, 396-407, 467-516, 725-730` |
| Analítica `config` GET/PUT, `plates`, `service-status` | Sin restricción por recurso | `analytics.ts:353-364, 664, 781` |
| Visores | Lista públicos, propios y compartidos (no los privados ajenos); crea, comparte y publica; edita y borra los propios | `views.ts:30-37, 75, 110, 144` |
| Sesiones globales (`/live-view/sessions`, `/cameras/stream-sessions`), diagnósticos, usuarios, seguridad, SMTP, auditoría | 403 | `liveView.ts:133`; `cameras.ts:528`; `diagnostics.ts:22, 143`; `users.ts:88-565`; `security.ts`; `alertSettings.ts` |
| `/live-view/transcodes` | Ve todo (como cualquier autenticado) | `liveView.ts:226` |
| `effective-permissions` | Informa `isAdmin:false` y sólo sus filas: "acceso vacío" | `users.ts:398-437` |
| Feature defaults | `canDownloadRecordings`, `canRestartStreams`, `canManageViews`, `canManageCameras` en `false`, que el backend no aplica | `services/totp.ts:103-109` |

Documentación contradictoria: `SECURITY.md:69` (raíz) y `docs/PROJECT_DOCUMENTATION.md:384` dicen
"Todas" para ver cámaras y grabaciones; `docs/SECURITY.md` §2.1 declara como contrato que en alertas
"un SUPERVISOR queda acotado a su `canView`".

### 4.2 Opciones y qué cambia en cada una

| | **Opción A — SUPERVISOR global** | **Opción B — SUPERVISOR acotado por filas** |
|---|---|---|
| Definición | Techo = OPERATOR + AUDITOR + gestión (`camera.configure`, `detection.configure`, `nvr.maintain`, `alerts.resolve`, `camera.diagnose`); alcance = **todas** las cámaras y NVR. No administra usuarios, sistema ni `nvr.admin`. | Mismo techo; alcance = **sus filas** (con herencia de NVR, §3). La gestión sólo se ejerce sobre cámaras/NVR de su alcance. |
| Cambia en alertas REST/WS | Incluir SUPERVISOR en el bypass (`alerts.ts:16`, `websocket.ts:49`) | Sumar filas de NVR al alcance (hoy sólo de cámara) |
| Cambia en analítica | Bypass en `resolveAnalyticsScope` (`analytics.ts:29`) | Sumar herencia; acotar también `config`, `plates`, `service-status` |
| Cambia en cámaras, vivo, `hls-auth`, grants, grabaciones, NVR, búsqueda | Nada en el alcance (ya es global); sí mínimo dato y exportación (D5) | `isPrivilegedRole` pasa a ser sólo ADMIN: todos esos puntos aplican la regla R-H a SUPERVISOR |
| Cambia en gestión (`restart-stream`, `PUT` cámara, `sync`, `onboard`, `analytics config`…) | Nada (rol) | Chequeo de alcance por recurso |
| Visores | Sin cambio: los visores son ACL de usuarios, no alcance de cámaras. `search.ts` deja de mostrarle privados ajenos | Igual que A |
| Exportación | `recordings.export` global, salvo que D5 exija `canDownload` también a SUPERVISOR | `canDownload` por alcance |
| Datos previos | Ninguna migración | **Siembra** de filas de NVR para cada SUPERVISOR existente × cada NVR (con `canView`, `canHighQuality`, `canPtz`, `canPlayback` y, según D5, `canDownload`) para conservar el primer día lo que hoy ve en **vivo, grabaciones, cámaras y NVR**; migración de datos con rollback (borrar las filas sembradas, marcadas) y autorización. **Efecto colateral:** con la herencia R-H aplicada a alertas y analítica (AP-2), esas filas **amplían** lo que hoy ve en alertas REST/WS, eventos de análisis, `summary` y `live-frame`, que hoy se acotan a sus filas de cámara (normalmente ninguna, §4.1). Para no ampliarlo, la siembra debe marcarse (`seeded`) y no contar para `events.view` hasta decidir D1/D8/D12, o sembrarse sólo con los flags de vivo y grabación y una regla explícita para eventos |
| NVR nuevos | Visibles al instante | No visibles hasta que un ADMIN los asigne (denegar por defecto) |
| Documentos | Corregir `docs/SECURITY.md` §2.1 | Corregir `SECURITY.md:69` y `PROJECT_DOCUMENTATION.md:384` |
| Riesgo | Acceso amplio a toda la evidencia de todos los sitios; una cuenta SUPERVISOR robada expone todo | Más superficie de cambio; si la siembra falla, un SUPERVISOR pierde el vivo (continuidad) |

### 4.3 Recomendación técnica — **DECISIÓN DEL DUEÑO pendiente (D1)**

Se recomienda **B con siembra marcada**. Con una siembra completa, B equivale a A en alcance el primer
día: su valor no es restringir de entrada, sino que el alcance pasa a ser **administrable por sitio**
(herencia de NVR), que los NVR nuevos no se abren solos (denegar por defecto) y que vivo, grabaciones,
alertas y eventos usan **la misma** regla. La siembra tiene que decidir explícitamente si conserva el
alcance acotado que hoy rige en alertas y eventos (contrato de `docs/SECURITY.md` §2.1) o lo amplía
(ver fila "Datos previos"); sin esa marca, B con siembra **amplía** esa parte. A es más simple y aceptable si la
operación tiene un solo sitio y los supervisores deben ver siempre todo, **siempre que se aplique igual
en todos los endpoints** (hoy no). Hasta que se decida, este documento no da por tomada ninguna de las
dos y las celdas "A/B" quedan abiertas.

## 5. Reproducción vs exportación

### 5.1 Criterio

- **Ver** = el video se entrega al reproductor de la sesión del usuario mientras mira: preview fMP4,
  MP4 progresivo servido a `<video>`, HLS, transcodificación a H.264 (`libx264` en grabaciones,
  `main_h264` en vivo). Exige `recordings.play` (o `live.view`/`live.hq` en vivo) y **no** exige
  `canDownload`, `canUseTranscode` ni `canTranscode`.
- **Exportar** = el sistema produce un **archivo para conservar** (descarga con `Content-Disposition:
  attachment`, enlace reutilizable, archivo en caché entregado fuera de la sesión de visualización).
  Exige `recordings.export`.
- **Límite declarado:** quien puede ver puede capturar la pantalla o guardar un flujo progresivo. La
  política controla la **función** de exportación, sus enlaces, su vigencia y su auditoría; no es DRM.

### 5.2 Clasificación de endpoints

| Endpoint | Clase | Acción propuesta | Hoy | Cambio |
|---|---|---|---|---|
| `GET /api/recordings/search`, `/calendar`, `POST /batch-search` | ver (metadatos) | `recordings.play` | OPERATOR 403; AUDITOR `canPlayback` exacto; ADMIN/SUPERVISOR libre | Herencia; permiso antes que existencia; auditar calendario |
| `POST /preview/start`; `GET /preview/:id/stream`, `/status`; `DELETE` | ver | `recordings.play` | Igual en el inicio; `stream` y `status` no revalidan (token de 30 min) | Revalidar en cada apertura de `stream` y en `status` (§7.2) |
| `POST /playback` en modo ver (`RecordingsPage.tsx:1301`, carga del MP4 en la celda) | ver | `recordings.play` | Emite **siempre** `downloadUrl` (`recordings.ts:1231, 1267, 1705`). En la web es código heredado: `loadRecordingInSlot` sólo se invoca desde su propio reintento (`RecordingsPage.tsx:1161, 1250, 1398`), así que hoy el único consumidor vivo de `/playback` es «Generar MP4…» | Deja de emitir `downloadUrl`; si el reproductor nuevo (E1) no usa VOD para ver, `/playback` queda sólo como exportación |
| `GET /playback/:id/status`, `GET /playback/:id/file.mp4`, `DELETE /playback/:id` | ver | `recordings.play` (sesión propia) | `status` reentrega `downloadUrl`; `file.mp4` sólo valida `fileToken` | Token ligado a usuario; revalidar al servir; `inline` |
| "Generar MP4…" (`RecordingsPage.tsx:1921`) → hoy el mismo `POST /playback` | **exportar** | `recordings.export` | Igual que ver | Endpoint propio (`POST /api/recordings/export`) o `purpose: 'export'` explícito; único que emite enlace de descarga; audita `RECORDING_EXPORT_REQUESTED` |
| `GET /api/recordings/download?t=` | **exportar** | `recordings.export` **vigente al servir** | Token al portador de 24 h sin `userId` ni `cameraId` (`recordings.ts:287-294, 332-345, 1921-1990`); sin auditoría; `t` no está en `SECRET_QUERY_PARAMS` (`lib/log-redact.ts:7`) y queda en el log de peticiones | Token con `userId` + `cameraId`; revalidar; auditar `RECORDING_EXPORTED`; redactar `t` o pasar a POST/cabecera; vigencia según D5c |
| Acierto de caché `RECORDINGS_CACHE_DIR` (`recordings.ts:1695-1716`) | ver o exportar según el modo | la del modo | Emite token sin auditar | Misma decisión y auditoría que sin caché |
| Captura PNG del cuadro (canvas del navegador) | — | — | Sin servidor | No es un control; se documenta |
| `GET /api/cameras/:id/snapshot` (JPEG en vivo) | D5d | `live.snapshot` | `canView`; AUDITOR 403 | Según D5d |
| Vivo `main_h264` | ver | `live.view` si el servidor lo fuerza por compatibilidad (D6); `live.hq` si lo pide el usuario. El path es el mismo en ambos casos: la decisión se toma por cámara (§7.1) | Sólo `canView` | Ver §7.4 |
| Snapshots y clips de eventos (E2/E4, futuro) | ver / exportar | snapshot: `events.view`; clip: `recordings.play` para verlo y `recordings.export` para descargarlo | `/uploads/` público (H21) | Endpoint autenticado (matriz, fila "Servir snapshots y clips…") |

### 5.3 Qué cambia respecto de hoy

- Hoy **reproducir equivale a exportar**: todo ADMIN, SUPERVISOR o AUDITOR con `canPlayback` genera y
  descarga el MP4, y el enlace sobrevive 24 h a la revocación, la desactivación y el reinicio del API.
  `canDownload` (cámara) y `canDownloadRecordings` (feature) no se leen en ningún endpoint
  (`apps/web` tampoco: el botón no depende de ellos, `RecordingsPage.tsx:2863-2878`).
- Con la política (propuesta **D5a**, pendiente), exportar exige `canDownload` (con herencia de NVR) y el techo del rol. Quitar la
  exportación a quien hoy la tiene es un cambio visible: D5b decide si se arranca restrictivo o se
  siembra `canDownload` donde hoy hay `canPlayback`. Como `/download` no se audita, **no hay forma de
  saber quién exportó hasta ahora**.
- `canDownloadRecordings` (feature) deja de ser una segunda fuente para la misma acción (D4).
- `docs/security/USER_PERMISSIONS_MATRIX.md:66, 92` marca `canDownload`/`canDownloadRecordings` como
  SUPERSEDED por un `authorize(['ADMIN'])` que corresponde a `GET /audit` (`recordings.ts:1995`): hay
  que corregirlo (§9).

## 6. Visores personales y compartidos

| Operación | Quién | Condición | Hoy |
|---|---|---|---|
| Crear visor **personal** (privado, sin lista) | Todos los roles | Cada `cameraId` de los slots debe estar, al guardar, en `live.view ∪ recordings.play` del creador; si no, 400 con la lista rechazada | Sólo ADMIN/SUPERVISOR; slots sin validar (`views.ts:75-99`) |
| Editar / borrar el propio | Dueño; ADMIN sobre personales ajenos según **D7** (hoy puede) | Misma validación de slots al editar | Dueño o ADMIN (`views.ts:110, 144`) |
| **Compartir** con una lista | ADMIN; SUPERVISOR (D7) sobre sus visores | Destinatarios existentes y activos (400 si no); compartir **no otorga** permisos de cámara | ADMIN/SUPERVISOR; ids inválidos → 500 por FK |
| **Publicar** (todos los autenticados) | ADMIN; SUPERVISOR según D7 | Igual | ADMIN/SUPERVISOR |
| Ver la lista de visores | ADMIN: todos (D7: ¿incluye personales ajenos?); resto: públicos ∪ propios ∪ compartidos | La misma ACL en `GET /views` y en la búsqueda global | `search.ts:116-129` aplica otra regla |
| Abrir un visor | Quien está en la ACL | Los slots se **filtran por la acción vigente de la pantalla** (`live.view` en vivo, `recordings.play` en grabaciones): un slot no permitido vuelve sin `cameraId` y con `restricted: true` | Devuelve todos los `cameraIds` (`views.ts:49-72`) |
| Ver quién tiene acceso | Dueño y ADMIN | Al resto no se le devuelven `userId`, `username` ni `fullName` de terceros | Cualquiera que vea el visor (`views.ts:39, 57`) |
| Reproducir cada slot | Lector | Cada stream pasa por `live.view`/`live.hq`/`recordings.play` del lector (ya ocurre en `start-stream`, heartbeat y `hls-auth`) | Igual, pero la UI recibe ids ajenos y depende de los 403 |
| Pérdida de permiso | — | El slot queda restringido en la siguiente lectura o latido; **no** se reescribe el visor del dueño | No aplica (no hay filtro) |
| Baja del dueño | — | Borrar o transferir sus visores (D7); hoy `createdById` no tiene FK (`schema.prisma:413`) | Quedan huérfanos |
| Auditoría | — | Crear, editar, borrar, compartir y publicar | No se audita (H28) |
| Selección de destinatarios | ADMIN/SUPERVISOR | Directorio mínimo (`id`, `username`, `fullName` de activos), no `GET /api/users` (sólo ADMIN) | `ViewsPage` pide `GET /api/users` y falla para SUPERVISOR |

## 7. Aplicación

### 7.1 Módulo único

Se extiende `services/access-policy.ts` (que ya se declara "fuente única para las rutas de NVR") y se
retiran los demás resolutores. Esbozo de interfaz (no implementado):

```ts
type Action = 'live.view' | 'live.hq' | 'live.ptz' | 'live.snapshot' | 'camera.status' | 'camera.diagnose'
  | 'recordings.play' | 'recordings.export' | 'events.view' | 'alerts.ack' | 'alerts.resolve'
  | 'camera.configure' | 'detection.configure' | 'nvr.read' | 'nvr.maintain' | 'nvr.admin'
  | 'users.manage' | 'alerts.settings' | 'security.settings' | 'recordings.settings' | 'audit.view' | 'system.diagnostics'
  | 'appearance.manage' | 'views.personal' | 'views.share' | 'views.publish' | 'views.view' | 'self'
  | 'camera.list' | 'nvr.list' | 'channel.read' | 'dashboard.view' | 'authenticated' | 'public' | 'service'

interface Actor { id: string; role: Role; active: boolean; authVersion: number }   // vigente (§7.2)
type Target = { cameraId: string } | { nvrId: string } | { nvrId: string; channel: number } | { viewId: string } | null
type Scope  = { all: true } | { all: false; cameraIds: string[]; nvrIdsAll: string[] }

loadActor(request): Promise<Actor>                       // una vez por petición
can(actor, action, target): Promise<boolean>              // una función por acción detrás
scopeFor(actor, action): Promise<Scope>                   // listas y filtros
cameraWhere(scope): Prisma.CameraWhereInput                // id IN … OR nvrId IN …
actionForStreamPath(path, camera): 'live.view' | 'live.hq'
  // hls-auth: _sub ⇒ live.view. _main/_main_h264 ⇒ live.view si la cámara está, AL MOMENTO de la
  // petición, en condición de compatibilidad (sub HEVC redirigido o USING_MAIN_STREAM) y D6 = live.view;
  // si no, live.hq. El sufijo solo no alcanza: el path de compatibilidad y el de alta calidad pedida son
  // idénticos (stream.ts:901-907). Alternativa: publicar paths distintos para compatibilidad.
```

Uso en las rutas: `config: { policy: { action, resource } }` + un `preHandler`
`server.requireAction(action, resolveTarget)`. Cuando la acción depende del cuerpo (p. ej.
`start-stream` con `streamType`), la ruta declara `actionFrom(request)` y el contrato lo exige igual.

### 7.2 Actor vigente y revocación

- `authenticate` sigue verificando firma y tipo de token (#190), y además carga el actor: `role`,
  `active` y una versión de autorización (`authVersion`) desde la base o una caché corta invalidada por
  época (el patrón del epoch de grants y `MediaRevokeOutbox` ya existe). El access token lleva la
  versión con la que se emitió; si no coincide, 401. **La decisión usa el rol vigente, no el claim.**
- Costo: una lectura (o un acierto de caché) por petición; `hls-auth` ya hace una consulta por segmento.

| Evento | Debe revocar (siguiente uso) | Hoy |
|---|---|---|
| `PUT`/`POST /users/:id/permissions` | grants, WS, sesiones de vivo de cámaras perdidas, previews, VOD, tokens de descarga | grants (outbox atómico) y WS (`users.ts:330-376, 440-477`); vivo al siguiente heartbeat o segmento HLS; previews, VOD y descargas **no** |
| `PUT /users/:id` (rol, `active=false`, contraseña) | todo, incluido el access token (versión) | sólo WS con `active=false` (`users.ts:251-256`) |
| `DELETE /users/:id` | todo | sólo WS |
| `POST /users/:id/reset-2fa` | todo | borra sesiones; sin WS ni grants |
| `DELETE /users/:id/sessions`; `DELETE /auth/sessions[/:sessionId]` (propias) | access tokens de esas sesiones, WS, grants | La de ADMIN corta WS (`users.ts:565`); las propias sólo borran la `Session` (`auth.ts:564-600`); en ambos casos el access token sigue hasta su TTL |
| `POST /auth/change-password`, `PUT /profile/password` | todo salvo la sesión actual | borran sesiones; sin WS, grants ni cookies |
| `POST /auth/logout` | sesión, grants, WS, cookies | sí (modelo a seguir) |
| `POST /cameras/:id/touch-stream` | revalidar `live.view`/`live.hq` | no revalida (`cameras.ts:621-634`) |

### 7.3 Paquetes de arreglo propuestos

PR Draft separados, **no creados**. Los existentes se citan por número.

| Id | Contenido | Depende de |
|---|---|---|
| S0 | #186 (`playbackURI` por canal), #189 (RBAC del heartbeat), #190 (sólo access tokens), sobre #182 | revisión conjunta en curso |
| PD-PD | **PR Draft perfil y diagnósticos** (pedido por el dueño): `/auth/me` y diagnósticos con proyección mínima, sin credenciales del NVR, revisión de lo guardado en el navegador | — |
| PD-AU | **PR Draft audio** (pedido por el dueño): `PUT` de video/audio toca sólo `<Audio><enabled>` | — |
| PD-BR | **PR Draft branding** (pedido por el dueño): reproducir en aislado el posible XSS de `/appearance/upload` y corregir si se confirma | — |
| AP-1 | Módulo único (§7.1), catálogo de acciones, editor único de permisos (retira el `POST` legado), `GET /api/auth/me/access` | D4 |
| AP-2 | Herencia R-H en todas las rutas por cámara, grabaciones, alertas, búsqueda y analítica | D3, D4 |
| AP-3 | Alta calidad en servidor (`start-stream`, redirección del heartbeat, `hls-auth` por sufijo) y techo del AUDITOR en vivo | D2, D6 |
| AP-4 | Reproducir vs exportar (§5) | D5 |
| AP-5 | Actor vigente y revocación (§7.2) | D9 |
| AP-6 | Visores (§6) | D7 |
| AP-7 | Mínimo dato fuera de PD-PD: `nvr.ipAddress` y `lastRtspError` en `/cameras*`, IP en búsqueda y en alertas, `playbackWebUrl` en `batch-search`, contrato completo de NVR a no administradores | — |
| AP-8 | SUPERVISOR según D1 (con siembra si B) | D1, AP-2 |
| AP-9 | Alertas y eventos por alcance: alertas de NVR por NVR, lectura por usuario, `plates`/`service-status` por alcance, snapshots autenticados, conteos del dashboard por alcance | D8, D12 |
| AP-10 | Superficie interna y de diagnóstico: `/live-view/transcodes` sólo ADMIN, `/api/*/internal/*` bloqueado en nginx + red interna, kick por dueño, `/metrics` con token obligatorio | — |
| AP-11 | Step-up y auditoría de mutaciones (H23, H28) | D10 |
| AP-12 | Prueba de contrato de rutas (§7.5) | — |

### 7.4 Tabla de conformidad por endpoint

Columnas: **Acción** del catálogo (§2.2); **Chequeo actual** con evidencia; **Política**: lo que exigirá el
módulo para esa acción (síntesis de §2.3 y §3.2; ADM/SUP/OP/AUD = roles, R-H = herencia de NVR, `D#` = sujeto a la
decisión); **Brecha** entre chequeo y política;
**Sev.**: Alto (entrega evidencia, credenciales o infraestructura, o una acción física/destructiva fuera
de alcance), Medio (alcance o techo incoherente, revocación tardía, dato innecesario), Bajo (oráculo,
auditoría o inconsistencia sin acceso adicional), `D#` (depende de la decisión), `—` (conforme: sólo
falta declararla en el catálogo). `H#` = hallazgo de `SCREEN_FUNCTION_MATRIX.md`. Se agrupan filas sólo
cuando chequeo, política y brecha son idénticos.

#### Vivo, PTZ, medios y alertas en tiempo real

| Método | Ruta | Acción | Chequeo actual | Política | Brecha | Sev. | Arreglo |
|---|---|---|---|---|---|---|---|
| POST | `/api/live-view/heartbeat` | `live.view` (`live.hq` si redirige) | `authenticate` + `viewableCameraIds`: bypass ADMIN/SUP, resto fila de cámara `canView` (`liveView.ts:44-56`, #189); denegadas cierran sub/main/main_h264 (`stream-manager.ts:3128`) | `canView` (R-H); la redirección según D6; techo según D1/D2 | No hereda; AUDITOR no bloqueado; la redirección `sub`→`main`/`main_h264` no exige `live.hq` (`stream-manager.ts:2110-2128`); no audita | Medio (H15, H16) | AP-2, AP-3 |
| GET | `/api/live-view/sessions` | `system.diagnostics` | `authorize(['ADMIN'])` (`liveView.ts:133`) | sólo ADM | — (GET con efectos: `pruneStaleSessions`, fuera de esta política) | — | AP-12 |
| GET | `/api/live-view/capabilities` | `authenticated` | `authenticate` (`liveView.ts:139`) | cualquier sesión válida; sin datos sensibles | — | — | AP-12 |
| POST | `/api/live-view/client-capabilities` | `live.view` / `live.hq` | Con flag: `hasMediaAccess` (`grant-derivation.ts:79-85`); sin flag no evalúa cámara | `canView` (R-H); HD: + `canHighQuality`; techo según D1/D2 | No hereda; AUDITOR | Bajo (flag apagada) | AP-2, AP-3 |
| GET | `/api/live-view/transcodes` | `system.diagnostics` | `authenticate` (`liveView.ts:226`) | sólo ADM | Cualquier rol ve `userId`, `viewId`, `streamPath` y stderr de todos | Medio (H20) | AP-10 |
| POST | `/api/live-view/media-grant` | `live.view` / `live.hq` | `hasMediaAccess`: `sub` ⇒ `canView`; `main` ⇒ + `canHighQuality` (`mediaGrants.ts:44`) | `canView` (R-H); HD: + `canHighQuality`; techo según D1/D2 | No hereda; AUDITOR | Bajo (flag apagada) | AP-2, AP-3 |
| DELETE | `/api/live-view/media-grant/:grantId` | `self` | Dueño (`services/media/media-grants.ts:275`) | sólo lo propio | — | — | AP-12 |
| DELETE | `/api/live-view/media-grant/view/:viewId` | `self` | Revoca sólo propios; `listGrantIdsForView` sin filtro (`media-grants.ts:313`) y el kick expulsa conexiones ajenas | sólo lo propio | Kick fuera de alcance (plausible) | Bajo (H30) | AP-10 |
| POST | `/api/live-view/internal/media-grant/validate` | `service` | Secreto en tiempo constante (`mediaGrants.ts:105`) | secreto + red interna | Publicado bajo `/api/` sin exigir red interna | Medio (H22) | AP-10 |
| POST | `/internal/mediamtx/auth` | `service` | Red interna + secreto (`mediamtxAuth.ts:75-82`) | secreto + red interna | — | — | AP-12 |
| GET/HEAD | `/internal/hls-auth` | `live.view` / `live.hq` por sufijo | Red interna + `jwtVerify` (sólo access, `plugins/auth.ts:63, 96-98`) + `userCanAccessNvrChannel` (`hlsAuth.ts:72-104`) | `_sub`: `canView`; `_main`/`_main_h264`: + `canHighQuality` salvo condición de compatibilidad de la cámara al momento (D6, §7.1); R-H; rol vigente | No distingue `_sub`/`_main`/`_main_h264`; rol del JWT (no vigente); AUDITOR | Medio (H14, H9) | AP-3, AP-5 |
| GET (WS) | `/ws/alerts` | `events.view` | Ticket de un uso (`auth.ts:934`: `active` + sesión); cámara: ADMIN por rol en DB o fila exacta `canView` (`websocket.ts:33-60`); sin cámara: a todos | `canView` (R-H); alertas sin cámara según D8 | No hereda; alertas de NVR a todos, con IP del NVR | Medio (H11) | AP-2, AP-9 |
| GET | `/api/cameras` | `camera.list` | ADMIN/SUP todo; resto `getViewableCameraIds` (`cameras.ts:51-72`) | unión de `scopeFor` de las acciones de cámara (R-H); proyección mínima (P6) | No hereda; `nvr.ipAddress` y fila completa con `lastRtspError` (usuario+IP del NVR) | Medio (H13, H16) | AP-2, AP-7 |
| POST | `/api/cameras/batch` | catálogo | Inline `findMany canView` (`cameras.ts:75-96`) | unión de `scopeFor` de las acciones de cámara (R-H); proyección mínima (P6) | Igual que la lista | Medio | AP-2, AP-7 |
| GET | `/api/cameras/:id` | catálogo | `userCanAccessCamera(canView)` (`cameras.ts:103-116`) | unión de `scopeFor` de las acciones de cámara (R-H); proyección mínima (P6) | No hereda; IPs; 404 antes de 403 | Medio | AP-2, AP-7 |
| GET | `/api/cameras/:id/stream` | `live.view` | AUDITOR 403 + `canView` (`cameras.ts:118-147`) | OP y ADM, SUP (D1); `canView` (R-H); AUDITOR según D2 | No hereda; publica sin sesión (invariante 3, fuera de esta política) | Bajo | AP-2 |
| GET | `/api/cameras/:id/stream/status` | `live.view` | `canView` (`cameras.ts:149`) | OP y ADM, SUP (D1); `canView` (R-H); AUDITOR según D2 | No hereda; AUDITOR | Bajo | AP-2, AP-3 |
| GET | `/api/cameras/:id/diagnostics` | `camera.diagnose` (y `camera.status` separado) | `canView`, cualquier rol (`cameras.ts:162-226`) | sondas: ADM, SUP (alcance D1); estado mínimo sin datos del NVR: la acción de la pantalla (D11) | Usuario+IP del NVR a OPERATOR/AUDITOR; sondas RTSP y escritura desde un GET | **Alto** (H5) | PD-PD |
| POST | `/api/cameras/:id/restart-stream` | `camera.configure` | `authorize(['ADMIN','SUPERVISOR'])` (`cameras.ts:281`) | ADM, SUP (alcance D1); auditado | Sin alcance; corta a todos los espectadores; sin auditoría | D1 · Medio (H25) | AP-8, AP-11 |
| POST | `/api/cameras/:id/test-rtsp` | `camera.diagnose` | Ídem (`cameras.ts:297`) | ADM, SUP (alcance D1) | Sin alcance; usuario del NVR en `urlMasked` | D1 · Medio | AP-8, PD-PD |
| GET | `/api/cameras/:id/snapshot` | `live.snapshot` | AUDITOR 403 + `canView` (`cameras.ts:316-335`) | `live.view` (D5d), auditado | No hereda | Bajo · D5d | AP-2 |
| POST | `/api/cameras/:id/ptz` | `live.ptz` | AUDITOR 403 + `ptzEnabled` + `canPtz` exacto (`cameras.ts:337-355`) | `live.view` + `canPtz` (R-H) + `ptzEnabled` | No exige `live.view`; no hereda; 404/400 antes de 403 | Medio (H39) | AP-2 |
| POST | `/api/cameras/:id/start-stream` | `live.view` (`sub`) / `live.hq` (`main`, `main_h264`) | `canView` para cualquier `streamType` (`cameras.ts:357-384`) | `sub`: `canView`; `main`/`main_h264`: + `canHighQuality` (R-H); techo según D1/D2 | Alta calidad sin `canHighQuality`; AUDITOR; no hereda | Medio (H14, H15, H16) | AP-3, AP-2 |
| POST | `/api/cameras/cleanup-my-sessions` | `self` | Sólo `user.sub` (`cameras.ts:519`) | sólo lo propio | — | — | AP-12 |
| GET | `/api/cameras/stream-sessions` | `system.diagnostics` | ADMIN (`cameras.ts:528`) | sólo ADM | — | — | AP-12 |
| POST | `/api/cameras/:id/stop-stream` | `self` | Dueño por `userId`+`viewId`+intento (`cameras.ts:534`) | sólo lo propio | — (cerrar no requiere permiso) | — | AP-12 |
| DELETE | `/api/cameras/:id/stream` | `self` | Dueño + `retentionToken` (`cameras.ts:580-610`) | sólo lo propio | `retentionToken` por query (compatibilidad C19) no se redacta en logs | Bajo | AP-10 |
| DELETE | `/api/cameras/my-sessions` | `self` | Sólo `user.sub` (`cameras.ts:612`) | sólo lo propio | — | — | AP-12 |
| POST | `/api/cameras/:id/touch-stream` | `self` + `live.view` vigente | Sin re-chequeo (`cameras.ts:621-634`) | sesión propia + `live.view` revalidado en cada latido | Mantiene viva una sesión revocada hasta el siguiente heartbeat | Medio (H9) | AP-5 |
| POST | `/api/cameras/:id/validate-stream` | `camera.diagnose` | `authorize(['ADMIN','SUPERVISOR'])` (`cameras.ts:637`) | ADM, SUP (alcance D1) | Sin alcance; cambia `preferredStream`/`online` sin auditar | D1 · Bajo | AP-8, AP-11 |
| GET | `/api/cameras/:id/debug-stream` | `camera.diagnose` | Ídem (`cameras.ts:659`) | ADM, SUP (alcance D1) | Usuario+IP del NVR a SUPERVISOR | Medio | PD-PD, AP-8 |
| PUT | `/api/cameras/:id` | `camera.configure` | Ídem (`cameras.ts:714`) | ADM, SUP (alcance D1); auditado | Sin alcance ni auditoría; devuelve la fila completa | D1 · Medio (H28) | AP-8, AP-11 |
| PATCH | `/api/cameras/:id/name` | `camera.configure` | Ídem (`cameras.ts:724`) | ADM, SUP (alcance D1); auditado | Sin alcance (sí audita) | D1 | AP-8 |
| POST | `/api/cameras/:id/migrate` | `nvr.admin` | ADMIN (`cameras.ts:757`) | sólo ADM; step-up según D10 | Las filas de cámara conservan el `nvrId` viejo; un `PUT` posterior crea otra fila (plausible) | Medio | AP-2 (R-H 2) |

#### Visores y búsqueda

| Método | Ruta | Acción | Chequeo actual | Política | Brecha | Sev. | Arreglo |
|---|---|---|---|---|---|---|---|
| GET | `/api/views` | `views.view` | ADMIN todo; resto público ∪ propio ∪ compartido (`views.ts:26-46`) | ACL del visor; slots filtrados por la acción vigente | Slots sin filtrar; identidades de terceros | Bajo (H31) | AP-6 |
| GET | `/api/views/:id` | `views.view` | Misma ACL; 404 antes de 403 (`views.ts:49-72`) | ACL del visor; slots filtrados por la acción vigente | Ídem | Bajo (H31) | AP-6 |
| POST | `/api/views` | `views.personal` / `views.share` / `views.publish` | `authorize(['ADMIN','SUPERVISOR'])`; sin validar slots ni destinatarios (`views.ts:75-99`) | propio: todos los roles; compartir: ADM, SUP (D7); publicar: ADM (D7); slots dentro del alcance | OPERATOR/AUDITOR sin visores personales; ids inválidos → 500 | Medio (política nueva) | AP-6 |
| PUT | `/api/views/:id` | ídem | Dueño o ADMIN (`views.ts:102-134`) | propio: todos los roles; compartir: ADM, SUP (D7); publicar: ADM (D7); slots dentro del alcance | Ídem | Medio | AP-6 |
| DELETE | `/api/views/:id` | `views.personal` | Dueño o ADMIN (`views.ts:137-150`) | todos los roles; slots dentro del alcance propio | Abrir a todos los roles para los propios; sin auditoría | Bajo | AP-6 |
| GET | `/api/search/global` | catálogo + `views.view` + `events.view` | ADMIN/SUP sin filtro; resto filas de cámara; visores no privilegiados sólo públicos (`search.ts:25-60, 112-150`) | cámaras: unión de `scopeFor` de las acciones de cámara (R-H); proyección mínima (P6); visores: ACL de `GET /views`; alertas: `events.view` | SUP ve privados ajenos y alertas sin alcance; los demás pierden propios y compartidos; IPs; no hereda | Medio (H17) | AP-2, AP-6, AP-7, AP-8 |

#### Grabaciones

| Método | Ruta | Acción | Chequeo actual | Política | Brecha | Sev. | Arreglo |
|---|---|---|---|---|---|---|---|
| GET | `/api/recordings/settings/audio` | `recordings.play` (lectura de política) | `authorize(['ADMIN','SUPERVISOR','AUDITOR'])` (`recordings.ts:1383`) | roles con `recordings.play`; sin alcance | — | — | AP-12 |
| PUT | `/api/recordings/settings/audio` | `recordings.settings` | ADMIN + auditoría (`recordings.ts:1389`) | sólo ADM | Sin step-up | Bajo | AP-11 |
| GET | `/api/recordings/search` | `recordings.play` | OPERATOR 403; AUDITOR `canPlayback` exacto (`recordings.ts:1411-1423`) | AUD y ADM, SUP (D1); `canPlayback` (R-H); OPERATOR según D2 | No hereda; 404 antes de 403 | Medio (H16, H39) | AP-2 |
| GET | `/api/recordings/calendar` | `recordings.play` | Ídem (`recordings.ts:1452-1472`) | AUD y ADM, SUP (D1); `canPlayback` (R-H); OPERATOR según D2 | No hereda; sin auditoría | Medio | AP-2, AP-11 |
| POST | `/api/recordings/batch-search` | `recordings.play` | Ídem con filtro de lote (`recordings.ts:1498-1524`) | AUD y ADM, SUP (D1); `canPlayback` (R-H); OPERATOR según D2 | No hereda; 404 del NVR antes; `playbackWebUrl` a AUDITOR | Medio | AP-2, AP-7 |
| POST | `/api/recordings/playback` | `recordings.play`; emitir enlace = `recordings.export` | OPERATOR 403; AUDITOR `canPlayback`; `playbackURI` por canal (#186); `downloadUrl` siempre (`recordings.ts:1591-1716`) | ver: `recordings.play`; enlace de descarga: + `canDownload` (D5) | Reproducir ⇒ exportar; `canDownload` no se lee | Medio (H8) | AP-4 |
| GET | `/api/recordings/playback/:sessionId/status` | `self` + `recordings.play` vigente | Dueño o ADMIN (`recordings.ts:1801-1811`) | sesión propia + `recordings.play` revalidado; enlace de descarga sólo con `recordings.export` | No revalida; reentrega `downloadUrl` | Medio (H10) | AP-4, AP-5 |
| GET | `/api/recordings/playback/:sessionId/file.mp4` | `recordings.play` (token de sesión) | Sólo `fileToken` (`recordings.ts:1842-1896`) | `recordings.play` revalidado al servir; token ligado a usuario y cámara | No se corta con la revocación (30 min) | Medio (H10) | AP-5 |
| DELETE | `/api/recordings/playback/:sessionId` | `self` | Dueño o ADMIN (`recordings.ts:1898-1902`) | sólo lo propio | El token de descarga sobrevive | Bajo | AP-4 |
| GET | `/api/recordings/download` | `recordings.export` | Token al portador de 24 h sin usuario (`recordings.ts:1921-1990`) | `recordings.play` + `canDownload` (R-H), revalidado al servir (D5) | No exige permiso; sin auditoría; sobrevive a la revocación; `t` en logs | Medio (H8, H10) | AP-4 |
| GET | `/api/recordings/audit` | `audit.view` | ADMIN (`recordings.ts:1995`) | sólo ADM | — (`limit` sin tope, fuera de esta política) | — | AP-12 |
| POST | `/api/recordings/preview/start` | `recordings.play` | OPERATOR 403; AUDITOR `canPlayback`; `playbackURI` por canal (`recordings.ts:2016-2044`) | AUD y ADM, SUP (D1); `canPlayback` (R-H); OPERATOR según D2 | No hereda (transcodificar para ver sin `canDownload`: conforme) | Medio (H16) | AP-2 |
| GET | `/api/recordings/preview/:sessionId/stream` | `recordings.play` (token) | Sólo `streamToken` (`recordings.ts:2313`) | `recordings.play` revalidado en cada apertura; token ligado a usuario y cámara | No revalida al reabrir (30 min) | Medio (H10) | AP-5 |
| GET | `/api/recordings/preview/:sessionId/status` | `self` | Dueño o ADMIN (`recordings.ts:3257-3327`) | sesión propia; reentregar `streamUrl` exige `recordings.play` vigente | Reentrega `streamUrl` sin revalidar; stderr con usuario/IP del NVR | Medio | AP-5, AP-7 |
| POST | `/api/recordings/diagnostics/playback` | `system.diagnostics` | ADMIN (`recordings.ts:3355`) | sólo ADM | Usuario+IP del NVR en la respuesta | Bajo | PD-PD |
| GET | `/api/recordings/diagnostics/nvr-time` | `system.diagnostics` | ADMIN (`recordings.ts:3670`) | sólo ADM | — | — | AP-12 |
| DELETE | `/api/recordings/preview/:sessionId` | `self` | Dueño o ADMIN (`recordings.ts:3700-3706`) | sólo lo propio | — | — | AP-12 |

#### NVR y configuración de canales

| Método | Ruta | Acción | Chequeo actual | Política | Brecha | Sev. | Arreglo |
|---|---|---|---|---|---|---|---|
| POST | `/api/nvrs/test-connection`, `/detect`, `/scan` | `nvr.admin` | ADMIN (`nvr.ts:77, 139, 217`) | sólo ADM; step-up según D10 | — en rol (credencial guardada a host arbitrario: H27, fuera de esta política) | — | AP-12 |
| GET | `/api/nvrs` | `nvr.list` | Privilegiado todo; resto `getVisibleNvrMap`; fila de cámara recibe sólo `id`/`name` (`nvr.ts:280-331`) | NVR del alcance (R-H); usuario, IP, puertos y serie sólo a quien lo administra (P6) | Una fila de NVR **no administradora** recibe usuario, IP, puertos y serie | Medio | AP-7 |
| GET | `/api/nvrs/:id` | `nvr.read` | `userCanAccessNvrWide` (`nvr.ts:333`) | fila de NVR con `canView`; ADM, SUP (D1) | Usuario/IP del NVR y filas `Camera` completas | Medio | AP-7 |
| GET | `/api/nvrs/:id/status`, `/device-info`, `/storage` | `nvr.read` | `userCanAccessNvrWide` (`nvr.ts:348, 368, 385`) | fila de NVR con `canView`; ADM, SUP (D1) | — (I/O y escritura desde GET, fuera de esta política) | — | AP-12 |
| GET | `/api/nvrs/:id/users` | `nvr.maintain` (lectura de cuentas del dispositivo) | `authorize(['ADMIN','SUPERVISOR'])` (`nvr.ts:435`) | ADM, SUP con fila de NVR (D1) | SUPERVISOR lee las cuentas de cualquier NVR | D1 | AP-8 |
| GET | `/api/nvrs/:id/cameras` | catálogo | `userCanAccessNvr` + `getVisibleNvrMap` (`nvr.ts:470-499`) | unión de `scopeFor` de las acciones de cámara (R-H); proyección mínima (P6) | Hereda (conforme); `fromNvr` con IP y `passwordStatus` de cámaras | Bajo | AP-7 |
| POST | `/api/nvrs/:id/sync`, `/sync-cameras`, `/force-names-sync`, `/validate-health`, `/recording-capabilities/check` | `nvr.maintain` | `authorize(['ADMIN','SUPERVISOR'])` (`nvr.ts:527, 689, 945, 1033, 1371`) | ADM, SUP con fila de NVR (D1) | Sin alcance; `canSync`/`canRevalidate` no se leen; `validate-health` sin auditoría | D1 | AP-8 |
| GET | `/api/nvrs/:id/free-channels` | `nvr.maintain` | Ídem (`nvr.ts:1488`) | ADM, SUP con fila de NVR (D1) | Sin alcance | D1 | AP-8 |
| POST | `/api/nvrs/:id/onboard` | `nvr.maintain` + publicación = `nvr.admin` | Ídem (`nvr.ts:1070`) | ADM, SUP con fila de NVR (D1); publicar streams: sólo ADM | SUPERVISOR publica streams; `sync-streams` es ADMIN | Bajo | AP-8 |
| GET | `/api/nvrs/:id/ip-camera-sources-debug`, `/recording-capabilities/debug` | `system.diagnostics` | ADMIN (`nvr.ts:913, 1454`) | sólo ADM | — | — | AP-12 |
| POST | `/api/nvrs/:id/sync-streams` | `nvr.admin` | ADMIN (`nvr.ts:931`) | sólo ADM; step-up según D10 | — | — | AP-12 |
| POST | `/api/nvrs/:id/reboot` | `nvr.admin` | ADMIN (`nvr.ts:1053`) | sólo ADM; step-up según D10 | Sin step-up | Medio (H23) | AP-11 |
| POST / PUT | `/api/nvrs`, `/api/nvrs/:id` | `nvr.admin` | ADMIN (`nvr.ts:1218, 1287`) | sólo ADM; step-up según D10 | — | — | AP-12 |
| DELETE | `/api/nvrs/:id` | `nvr.admin` | ADMIN (`nvr.ts:1330`) | sólo ADM; step-up según D10 | Sin step-up | Medio (H23) | AP-11 |
| GET | `/api/nvrs/:id/recording-capabilities` | `nvr.read` | `userCanAccessNvrWide` (`nvr.ts:1340`) | fila de NVR con `canView`; ADM, SUP (D1) | — | — | AP-12 |
| PUT | `/api/nvrs/:id/recording-capabilities` | `nvr.admin` | ADMIN (`nvr.ts:1421`) | sólo ADM; step-up según D10 | — | — | AP-12 |
| POST | `/api/nvrs/:id/cameras/adopt` | `nvr.admin` | ADMIN (`nvr.ts:1498`) | sólo ADM; step-up según D10 | — | — | AP-12 |
| POST / PUT / POST / DELETE | `/api/nvrs/:id/users`, `/users/:userId`, `/users/:userId/change-password`, `/users/:userId` | `nvr.admin` | ADMIN (`nvr.ts:1561, 1589, 1617, 1643`) | sólo ADM; step-up según D10 | Sin step-up | Medio (H23) | AP-11 |
| GET | `/api/nvrs/:id/video-audio`, `/video-audio/:channel` | `channel.read` (`live.view` del canal o `nvr.read`) | `userCanAccessNvr` + mapa; `userCanAccessNvrChannel` (`nvr.ts:1669, 1713`) | `live.view` del canal o `nvr.read` (R-H) | Hereda (conforme); la misma lectura en `nvrConfig.ts` usa otro guard | Bajo | AP-1 |
| GET | `/api/nvrs/:id/video-audio/:channel/capabilities` | ídem | `authorize(['ADMIN','SUPERVISOR'])` (`nvr.ts:1737`) | `live.view` del canal o `nvr.read` (R-H) | Guard distinto del de la lectura | Bajo | AP-1 |
| PUT | `/api/nvrs/:id/video-audio/:channel` | `nvr.admin` | ADMIN (`nvr.ts:1760`) | sólo ADM; step-up según D10 | En rol, conforme; `audioEnabled` reemplaza el primer `<enabled>` y puede apagar el canal (integridad) | Alto (H7) | PD-AU, AP-11 |
| GET | `/api/nvrs/:nvrId/channels/:channelId/video-config`, `/channels/video-config`, `…/capabilities` | `channel.read` | `authorize(['ADMIN','SUPERVISOR'])` (`nvrConfig.ts:18, 50, 260`) | `live.view` del canal o `nvr.read` (R-H) | Duplica `nvr.ts` con otra regla; XML crudo | Bajo | AP-1 |
| PUT | `/api/nvrs/:nvrId/channels/:channelId/video-config` | `nvr.admin` | ADMIN (`nvrConfig.ts:102`) | sólo ADM; step-up según D10 | Mismo defecto de `<enabled>`; auditoría sin diff | Alto (H7) | PD-AU |
| POST | `/api/nvrs/:nvrId/channels/:channelId/video-config/restore` | `nvr.admin` | ADMIN (`nvrConfig.ts:168`) | sólo ADM; step-up según D10 | Mismo defecto al restaurar | Alto (H7) | PD-AU |

#### Integraciones, analítica, dashboard y diagnóstico

| Método | Ruta | Acción | Chequeo actual | Política | Brecha | Sev. | Arreglo |
|---|---|---|---|---|---|---|---|
| POST | `/api/onvif/discover`, `/device-information`, `/profiles`, `/stream-uri`, `/ptz/configurations`, `/imaging/get` | `nvr.admin` | ADMIN, sólo con `ONVIF_ENABLED` (`onvif.ts:89-132`) | sólo ADM; step-up según D10 | — | — | AP-12 |
| POST | `/api/onvif/ptz/move`, `/ptz/stop`, `/imaging/set` | `nvr.admin` | ADMIN (`onvif.ts:114, 124, 137`) | sólo ADM; step-up según D10 | Mueve o reconfigura el equipo sin auditoría, fuera de `canPtz`/`ptzEnabled` | Bajo (H28) | AP-11 |
| POST | `/api/hik-connect/token`, `/hls` | `nvr.admin` | ADMIN, sólo con `HIK_CONNECT_ENABLED` (`hikConnect.ts:82, 86`) | sólo ADM; step-up según D10 | `hls` entrega video fuera del modelo de cámaras | Bajo | AP-11 |
| POST | `/api/hik-connect/isapi` | `nvr.admin` | ADMIN (`hikConnect.ts:91`) | sólo ADM; step-up según D10 | Escritura ISAPI arbitraria sin step-up ni auditoría | Medio (H24) | AP-11 |
| POST / GET | `/api/ai/demo/event`, `/recent` | `system.diagnostics` | ADMIN, sólo con `AI_EVENTS_ENABLED` (`aiDemo.ts:76, 85`) | sólo ADM | — | — | AP-12 |
| GET | `/api/dashboard/overview` | `dashboard.view` | `canViewDashboard` (`dashboard.ts:11`) | conteos calculados sobre el alcance del usuario | Totales globales a cualquier rol | Bajo (H38) | AP-9 |
| GET | `/api/analytics/internal/cameras` | `service` | Secreto (`analytics.ts:162`) | secreto + red interna | Publicado en `/api/`; RTSP con credencial si `ANALYTICS_ALLOW_DIRECT_RTSP=true` | Medio (H22) | AP-10 |
| POST | `/api/analytics/internal/events`, `/internal/plates` | `service` | Secreto (`analytics.ts:229, 761`) | secreto + red interna | Snapshots públicos en `/uploads/` | Medio (H21) | AP-9, AP-10 |
| GET | `/api/analytics/config`, `/config/:cameraId` | `detection.configure` | `authorize(['ADMIN','SUPERVISOR'])` (`analytics.ts:353, 358`) | ADM, SUP (alcance D1); auditado | Sin alcance | D1 (H17) | AP-8 |
| PUT | `/api/analytics/config/:cameraId` | `detection.configure` | Ídem (`analytics.ts:364`) | ADM, SUP (alcance D1); auditado | SUPERVISOR configura cámaras cuyos eventos no ve | D1 · Medio (H17) | AP-8 |
| GET | `/api/analytics/events` | `events.view` | ADMIN todo; SUP/AUDITOR filas de cámara (`analytics.ts:396-407`) | `canView` (R-H) (todo evento de análisis tiene cámara: `analytics.ts:25-26`) | No hereda; OPERATOR excluido por rol (D12) | Medio | AP-2, AP-9 |
| GET | `/api/analytics/summary` | `events.view` | ADMIN/SUP + alcance (`analytics.ts:467-516`) | `canView` (R-H) | AUDITOR excluido (en `/events` incluido); no hereda | Bajo | AP-2 |
| GET | `/api/analytics/service-status` | `detection.configure` | `authorize(['ADMIN','SUPERVISOR'])` (`analytics.ts:664`) | ADM, SUP (alcance D1); auditado | Workers de todas las cámaras | D1 · Bajo | AP-8 |
| GET | `/api/analytics/live-frame/:cameraId` | `live.view` | ADMIN/SUP + alcance (`analytics.ts:725-730`) | OP y ADM, SUP (D1); `canView` (R-H); AUDITOR según D2 | OPERATOR excluido aunque vea el vivo; no hereda | Medio | AP-2 |
| GET | `/api/analytics/plates` | `events.view` (dato personal) | `authorize(['ADMIN','SUPERVISOR'])` sin alcance (`analytics.ts:781`) | `canView` (R-H) sobre la cámara de cada patente | Todas las cámaras | Medio (H17) | AP-9 |
| GET | `/api/diagnostics/camera-health/:cameraId` | `system.diagnostics` | ADMIN (`diagnostics.ts:22`) | sólo ADM | — | — | AP-12 |
| GET | `/api/diagnostics/stream-sessions` | `system.diagnostics` | ADMIN (`diagnostics.ts:143`) | sólo ADM | `visibleCamerasCount` ignora filas de NVR | Bajo | AP-2 |

#### Usuarios, identidad, alertas y sistema

| Método | Ruta | Acción | Chequeo actual | Política | Brecha | Sev. | Arreglo |
|---|---|---|---|---|---|---|---|
| GET | `/api/users/audit/activity` | `audit.view` | ADMIN (`users.ts:88`) | sólo ADM | — | — | AP-12 |
| GET | `/api/users`, `/api/users/:id` | `users.manage` | ADMIN (`users.ts:114, 132`) | sólo ADM | — (`canManageUsers` no se lee: D4) | — | AP-12 |
| POST | `/api/users` | `users.manage` | ADMIN (`users.ts:173`) | sólo ADM | Crear ADMIN sin step-up | Bajo (H23) | AP-11 |
| PUT | `/api/users/:id` | `users.manage` | ADMIN (`users.ts:222`) | sólo ADM | Cambio de rol o `active=false` no revoca; sin step-up al elevar; sin guarda del último ADMIN | Medio (H9, H23, H37) | AP-5, AP-11 |
| DELETE | `/api/users/:id` | `users.manage` | ADMIN + step-up (`users.ts:261`) | sólo ADM | Sólo corta WS | Medio (H9) | AP-5 |
| GET | `/api/users/:id/permissions` | `self` o `users.manage` | ADMIN o propio (`users.ts:278`) | el propio usuario o sólo ADM | `featurePermissions` crudo vs resuelto | Bajo | AP-1 |
| PUT | `/api/users/:id/permissions` | `users.manage` | ADMIN, atómico con revocación (`users.ts:310-376`) | sólo ADM | Upsert de NVR con `cameraId: null as any` probablemente falla (no verificado); no admite `canPtz`; persiste flags sin efecto; no borra ausentes | Medio (H18, H19) | AP-1 |
| GET | `/api/users/:id/effective-permissions` | `self` | ADMIN o propio (`users.ts:385`) | sólo lo propio | No calcula herencia ni el bypass de SUPERVISOR | Medio | AP-1 |
| POST | `/api/users/:id/permissions` (legado) | `users.manage` | ADMIN; borra y recrea 4 flags (`users.ts:440-477`) | sólo ADM | Resetea granulares; la web reenvía filas de NVR con `cameraId: null`, que el esquema rechaza | Medio (H19) | AP-1 |
| POST | `/api/users/:id/feature-permissions` | `users.manage` | ADMIN (`users.ts:483`) | sólo ADM | 13 de 15 flags sin efecto; una fila pisa todos los defaults del rol (`services/totp.ts:129-139`) | Medio (H18) | AP-1 |
| POST | `/api/users/:id/reset-2fa` | `users.manage` | ADMIN + step-up (`users.ts:503`) | sólo ADM | Sin WS ni grants | Medio (H9) | AP-5 |
| POST | `/api/users/:id/unlock` | `users.manage` | ADMIN (`users.ts:534`) | sólo ADM | — | — | AP-12 |
| GET | `/api/users/:id/sessions` | `users.manage` | ADMIN (`users.ts:549`) | sólo ADM | — | — | AP-12 |
| DELETE | `/api/users/:id/sessions` | `users.manage` | ADMIN (`users.ts:565`) | sólo ADM | El access token y los grants siguen | Medio (H9) | AP-5 |
| GET | `/api/auth/me` | `self` | `authenticate`; `userMeSelect` con `nvr: true, camera: true` (`auth.ts:55-61, 907`) | sólo lo propio | Usuario, contraseña cifrada e IP del NVR; persistido en `localStorage`; no mira `active` | **Alto** (H4) | PD-PD |
| POST | `/api/auth/ws-ticket` | `self` | `authenticate` + `active` + sesión (`auth.ts:934`) | sólo lo propio | — (modelo de actor vigente) | — | AP-12 |
| varios | `/api/auth/login`, `/2fa/*`, `/mfa/enroll/*`, `/step-up`, `/refresh`, `/logout`, `/forgot-password`, `/reset-password` | `public` / `self` | `auth.ts:68-906` (fuera del inventario; no evaluadas aquí) | login y recuperación: sin sesión; el resto: sólo lo propio | Clasificar en el contrato | — | AP-12 |
| POST / GET / DELETE / DELETE | `/api/auth/change-password`, `/sessions`, `/sessions`, `/sessions/:sessionId` | `self` | `authenticate` (`auth.ts:491, 536, 582, 564`) | sólo lo propio | `change-password` y el cierre de sesiones propias no revocan WS, grants ni el access token (§7.2) | Medio (H9) | AP-5 |
| GET | `/api/profile` | `self` | `authenticate` (`profile.ts:23`) | sólo lo propio | — (modelo de proyección mínima) | — | AP-12 |
| PUT | `/api/profile` | `self` | `authenticate` (`profile.ts:36`) | sólo lo propio | Email de recuperación sin reautenticación ni auditoría | Bajo (H35) | AP-11 |
| PUT | `/api/profile/password` | `self` | Contraseña actual (`profile.ts:61`) | sólo lo propio | Sin WS, grants ni auditoría | Medio (H9) | AP-5 |
| POST | `/api/profile/avatar` | `self` | `authenticate` (`profile.ts:103`) | sólo lo propio | — | — | AP-12 |
| GET | `/api/security/settings` | `security.settings` | ADMIN (`security.ts:28`) | sólo ADM, con step-up | — | — | AP-12 |
| PUT | `/api/security/settings` | `security.settings` | ADMIN + step-up + auditoría (`security.ts:34`) | sólo ADM, con step-up | — (patrón a seguir) | — | AP-12 |
| GET | `/api/admin/debug/transcodes`, `/diagnostics/recording-playback-capacity`, `/diagnostics/transcodes` | `system.diagnostics` | ADMIN (`admin.ts:19, 87, 147`) | sólo ADM | — (`canViewDiagnostics` no se lee: D4) | — | AP-12 |
| GET | `/api/alerts/summary`, `/api/alerts`, `/unread-count` | `events.view` | `resolveAlertScope`: ADMIN todo; resto filas de cámara + sin cámara (`alerts.ts:15-24, 42, 61, 84`) | `canView` (R-H); alertas sin cámara según D8 | No hereda; alertas de NVR a todos, con IP del NVR en `detail` | Medio (H11, H16) | AP-2, AP-9, AP-7 |
| POST | `/api/alerts/read-all` | `alerts.ack` | Alcance (`alerts.ts:93`) | alerta visible; lectura por usuario | `readAt` global: marca para todos; sin auditoría | Medio (H12) | AP-9 |
| POST | `/api/alerts/:id/read` | `alerts.ack` | `alertVisible` (`alerts.ts:104`) | alerta visible; lectura por usuario | `readAt` global; 404/403 | Bajo | AP-9 |
| PUT | `/api/alerts/:id/resolve` | `alerts.resolve` | `authorize(['ADMIN','SUPERVISOR'])` + `alertVisible` (`alerts.ts:122`) | ADM, SUP (D1) sobre alertas visibles; auditado | Sin auditoría; SUP resuelve alertas de NVR sin acceso a ese NVR | Medio (H28) | AP-9, AP-11 |
| GET | `/api/alerts/settings`, `/settings/deliveries` | `alerts.settings` | ADMIN (`alertSettings.ts:40, 63`) | sólo ADM | — | — | AP-12 |
| PUT | `/api/alerts/settings` | `alerts.settings` | ADMIN (`alertSettings.ts:77`) | sólo ADM | Sin step-up ni auditoría | Medio (H23, H29) | AP-11 |
| POST | `/api/alerts/settings/test-email` | `alerts.settings` | ADMIN (`alertSettings.ts:99`) | sólo ADM | Error SMTP crudo (H32) | Bajo | AP-7 |
| GET | `/api/integrations/status` | `authenticated` | `authenticate` (`integrations.ts:23`) | cualquier sesión válida; sin datos sensibles | — | — | AP-12 |
| GET | `/api/appearance` | `public` | Sin auth, lista blanca (`appearance.ts:92`) | sin sesión; lista blanca de campos | — | — | AP-12 |
| PUT | `/api/appearance` | `appearance.manage` | ADMIN o `canManageAppearance` (`appearance.ts:68-90, 119`) | sólo ADM (D4) | Habilitable por flag a cualquier rol; sin auditoría | Medio (H26) · D4 | PD-BR, AP-11 |
| POST | `/api/appearance/upload` | `appearance.manage` | Ídem (`appearance.ts:132`) | sólo ADM (D4) | Posible XSS de mismo origen (no demostrado) | Alto (H6, a confirmar) | PD-BR |
| GET | `/metrics` | `service` | `METRICS_TOKEN` opcional (`metrics.ts:99-110`) | secreto + red interna | Abierto sin token | Bajo (H40) | AP-10 |
| GET | `/health`, `/api/health` | `public` | Sin auth (`server.ts:318-319`, fuera del inventario) | sin sesión; lista blanca de campos | — | — | AP-12 |
| GET/HEAD | `/uploads/*` (`@fastify/static`) | `public` sólo para `/uploads/branding/*` (imágenes); `events.view` para snapshots y clips de eventos | Sin auth ni RBAC (`server.ts:233`, fuera del inventario); sirve branding y snapshots de analítica por igual | branding: lista blanca de extensiones de imagen, `nosniff` y CSP `sandbox` (#192); medios de eventos: fuera de `/uploads/`, en un endpoint autenticado con `events.view` (R-H) | Snapshots de analítica públicos (H21); XSS almacenado de branding (H6, corregido en #192) | Medio | AP-9, #192 |
| GET | `/api/health/deep` | `service` (propuesto) | Público (`server.ts:321`, fuera del inventario) | secreto + red interna | Expone estado y latencia de DB/Redis | Bajo (H40) | AP-10 |

### 7.5 Prueba de contrato propuesta

Objetivo: que **ninguna ruta registrada** quede sin acción declarada, y que lo declarado sea lo aplicado.

1. **Registro compartido.** Extraer de `server.ts` una función `registerApiRoutes(server)` que usen el
   arranque y la prueba, e incluya **todo** lo que registra rutas: el estático `/uploads/*`
   (`server.ts:233`), los plugins de `server.ts:244-297` y las rutas de salud (`server.ts:318-321`). Hoy
   la lista sólo existe dentro de `server.ts`, que además escucha el puerto (`server.ts:402`).
2. **Inventario de rutas.** La prueba arma una instancia Fastify con `authenticate`, `authorize`,
   `requireStepUp`, `prisma` y `redis` falsos (patrón de `routes/rbac-idor.route.test.ts`), activa
   **todas** las flags opcionales (`NATIVE_PLAYBACK_ENABLED`, `NATIVE_MEDIA_RELAY_ENABLED`,
   `ONVIF_ENABLED`, `HIK_CONNECT_ENABLED`, `AI_EVENTS_ENABLED`, `ANALYTICS_ALPR_ENABLED`) y recolecta cada
   ruta con un hook `onRoute` (método, URL, `config`, `preHandler`). Hoy son 187 rutas: 183 en
   `routes/*.ts`, 3 de salud y el estático `/uploads/*` en `server.ts`.
3. **Falla si**:
   - una ruta (salvo el `HEAD` automático) no tiene `config.policy`;
   - `config.policy.action` no existe en el catálogo exportado por `access-policy.ts`;
   - una acción de recurso (`live.*`, `recordings.*`, `events.view`, `camera.*`, `nvr.read`,
     `nvr.maintain`, `detection.configure`, `views.*`) no lleva en su `preHandler` el guard
     `requireAction` (marcado con un símbolo propio) o un `actionFrom` declarado;
   - una ruta `public` o `service` no está en una lista explícita con justificación;
   - una ruta `service` no exige red interna además del secreto (cubre H22).
4. **Matriz ejecutable.** Una segunda prueba recorre el catálogo × roles × casos de alcance con
   Prisma falso, a partir de la **misma** tabla que genera §2.3: fila de cámara, fila de NVR, fila de
   cámara con `false` bajo una de NVR con `true` (debe conceder), cámara migrada a otro NVR, techo del
   rol que excluye la acción, usuario inactivo y versión de autorización vencida.
5. **Documento sincronizado.** La prueba puede emitir la tabla ruta → acción y compararla con un
   archivo versionado (p. ej. `docs/security/ROUTE_POLICY.generated.md`) para que la tabla de §7.4 no
   se desactualice.
6. Primero corre en **modo informe** (lista lo que falta sin fallar) y pasa a **modo estricto** cuando
   todas las rutas declaran acción (§8.2).

## 8. Decisiones pendientes del dueño y orden de implementación

### 8.1 Decisiones (numeradas; ninguna se da por tomada)

| # | Decisión | Opciones | Recomendación técnica | Relación |
|---|---|---|---|---|
| D1 | Alcance de SUPERVISOR | A global · B acotado por filas | B con siembra (§4.3) | Propuesta §9.5 |
| D2 | Techos de OPERATOR y AUDITOR | ¿OPERATOR reproduce si tiene `canPlayback`? ¿AUDITOR ve vivo (hoy sí por `start-stream`/`hls-auth`, no por `/stream` ni `/snapshot`)? ¿AUDITOR ve la auditoría de grabaciones? | Rol como techo: OPERATOR sin grabaciones (el editor deja de ofrecer `canPlayback` a OPERATOR); AUDITOR sin vivo ni PTZ; auditoría sólo ADMIN | Propuesta §9.9 |
| D3 | Negaciones en la herencia | Sin negaciones (unión) · filas de denegación explícitas | Sin negaciones (R-H 3) | Propuesta §9.6 |
| D4 | Flags granulares y de funcionalidad | Aplicarlos · retirarlos de la UI | Conservar `canView`, `canHighQuality`, `canPtz`, `canPlayback`, `canDownload` en ambos alcances; retirar el resto (§3.3); de los feature flags, conservar `canViewDashboard`; `canManageAppearance` sólo ADMIN (H26); si alguno se conserva, que sea tri-estado (`null` = hereda del rol), porque hoy una fila pisa todos los defaults (`services/totp.ts:129-139`) | Propuesta §9.7 |
| D5 | Exportación | (a) requisito: `canDownload` por cámara con herencia; (b) arranque restrictivo o siembra donde hoy hay `canPlayback`; (c) vigencia del enlace (hoy 24 h); (d) `live.snapshot`: ver o exportar | (a) sí; (b) restrictivo con aviso previo; (c) corta y ligada a usuario; (d) ver (`live.view`), auditado | Propuesta §9.8 |
| D6 | Redirección del servidor a `main`/`main_h264` por compatibilidad (`sub` HEVC) | Cuenta como `live.view` · exige `live.hq` | `live.view` (es compatibilidad, no una elección de calidad). Si el dueño no quiere que así se obtenga la resolución principal, la alternativa es transcodificar a resolución de grilla para quien no tiene `live.hq`, con un costo de CPU que hay que medir | — |
| D7 | Visores | ¿SUPERVISOR publica? ¿OPERATOR/AUDITOR pueden compartir sus visores personales? ¿ADMIN ve y edita personales ajenos? ¿Qué pasa con los visores al borrar al dueño? | Publicar sólo ADMIN; compartir sólo ADMIN/SUPERVISOR; ADMIN ve personales ajenos sólo para soporte y con auditoría; borrar con el dueño (o transferir a ADMIN). (Que haya visores personales para todos los roles dentro de sus cámaras autorizadas **ya lo indicó el dueño**; no es parte de D7) | — |
| D8 | Alertas sin cámara (NVR, HDD) | A todos · a quien tenga algún acceso al NVR · sólo fila de NVR | Alcance de NVR según R-H: fila de NVR o alguna fila de cámara cuyo NVR **actual** (`camera.nvrId` al momento) sea ese NVR; sin IP en `detail`. No usar `userCanAccessNvr` tal como está: su `OR(nvrId, camera.nvrId)` abre el NVR anterior a una cámara migrada (R-H 2) | H11 |
| D9 | Revocación en cada petición | Versión de autorización en `authenticate` · sólo TTL corto | Versión en `authenticate` y `hls-auth` (§7.2): el TTL del access es de 60 min por defecto pero configurable hasta 24 h, así que confiar sólo en el TTL deja ventanas de hasta un día | H9, H10 |
| D10 | Step-up | Qué acciones lo exigen y si el token se liga a la acción | Reinicio y baja de NVR, cuentas del NVR, escritura de video/audio, cambio de rol, permisos y SMTP, con token ligado a la acción | H23 |
| D11 | Diagnóstico para OPERATOR/AUDITOR | Estado mínimo (`camera.status`) · nada | Estado mínimo sin sondas ni datos del NVR | H5, PD-PD |
| D12 | Eventos de análisis para OPERATOR | Excluido por rol (hoy) · con `canView` | Con `canView`: ya ve el vivo y las alertas de esas cámaras | Matriz, "Eventos recientes" |

### 8.2 Orden de implementación sugerido (no implementado)

Cada paso es un PR Draft con CI en verde y pruebas de ruta que reproducen la brecha antes del arreglo;
ninguno autoriza desplegar, migrar ni cambiar permisos reales.

1. **S0**: revisión conjunta y fusión de #182, #186, #189 y #190 (decisión del dueño). Tomar D1–D5
   antes del paso 4.
2. **AP-12 en modo informe** + catálogo de acciones: no cambia comportamiento; muestra qué rutas no
   declaran acción.
3. **PD-PD, PD-AU, PD-BR** (pedidos por el dueño) y **AP-7**: reducen exposición sin depender de decisiones.
4. **AP-1**: módulo único y actor vigente, reproduciendo primero el comportamiento actual donde haya
   decisiones abiertas; prueba de matriz (§7.5 punto 4).
5. **AP-2** herencia R-H, ruta por ruta.
6. **AP-4** reproducir vs exportar (D5).
7. **AP-3** alta calidad y techo del AUDITOR (D2, D6).
8. **AP-5** revocación efectiva (D9).
9. **AP-8** SUPERVISOR (D1); si es B, la siembra va como migración de datos con rollback y
   autorización explícita, verificada antes de desplegar el código que la exige.
10. **AP-6** visores (D7) y **AP-9** alertas y eventos (D8, D12).
11. **AP-10** y **AP-11** (D10).
12. **AP-12 en modo estricto**; recién entonces se conecta la interfaz nueva, que lee
    `GET /api/auth/me/access` y deriva de ella la tabla sección × rol del prototipo #188
    (`apps/web/prototype/model/permissions.ts`).

## 9. Documentos a actualizar

| Documento | Dónde | Qué cambiar |
|---|---|---|
| `SECURITY.md` (raíz) | `:65-70` (tabla RBAC) y sección "Permisos granulares" (`:72-80`) | "SUPERVISOR: Todas" (`:69`) depende de D1; "AUDITOR: Ver cámaras: Solo asignadas" (`:67`) contradice a `docs/PROJECT_DOCUMENTATION.md:386` ("No") y depende de D2; "Config. sistema: Lectura" para SUPERVISOR omite la gestión que hoy ejerce (`PUT /cameras/:id`, `sync`, `onboard`, `PUT /analytics/config/:cameraId`); la lista de 3 flags no describe el código; remitir a esta política. La sección "MediaMTX — Acceso a streams" dice que la petición HLS no revalida el JWT: hoy lo hace `/internal/hls-auth` (sin distinguir calidad) |
| `docs/SECURITY.md` | §2.1 (contrato de alertas) y riesgo #1 de §2 | §2.1 sólo sigue valiendo con D1 = B. El riesgo #1 ("HLS/WebRTC no revalida JWT") quedó desactualizado por `hls-auth`; el residual es la calidad (`_main`) y el rol no vigente |
| `docs/PROJECT_DOCUMENTATION.md` | `:383-386`, `:388-392` y `:400` | "SUPERVISOR: Todas" y "ADMIN/SUPERVISOR sin restricción" dependen de D1; "Config NVR: Lectura" para SUPERVISOR no refleja que hoy sincroniza, hace onboarding y edita cámaras (§4.1); la fila AUDITOR, de D2; la lista de flags granulares presenta como vigentes campos que no se leen (§3.3) |
| `docs/security/USER_PERMISSIONS_MATRIX.md` | `:64`, `:66`, `:67`, `:92` | `canDownload`/`canDownloadRecordings` no están cubiertos por un `authorize(['ADMIN'])` (el de `recordings.ts:1995` es `GET /audit`); `canHighQuality` no es ENFORCED en el camino HLS web y `canViewLive` no queda cubierto por `canView` para AUDITOR (las dos filas citan `liveView.ts:148`, que en `main` es la negociación nativa de `client-capabilities`, bajo flag); clasificar según §3.3 |
| `docs/frigate/NATIVE_INTEGRATION_PROPOSAL.md` | §0 ("no amplía ningún permiso"), §8 E9, §9 puntos 5–10 | La política **amplía** a propósito los visores personales a OPERATOR/AUDITOR y **restringe** la exportación; matizar a "no amplía permisos salvo lo aprobado en `PERMISSIONS_POLICY.md`". Los puntos de §9 pasan a este documento: 5 → D1, 6 → D3 (y R-H), 7 → D4, 8 → D5, 9 → D2; el 10 (visores personales para OPERATOR/AUDITOR) queda **resuelto por el dueño** (2026-10-08: "los visores personales pueden permitirse dentro de las cámaras autorizadas"); lo que sigue abierto de visores es D7 |
| `docs/frigate/SCREEN_FUNCTION_MATRIX.md` | "Cómo leerla" (mismo "no amplía"), filas de vivo, visores y grabaciones, y filas de eventos y alertas (`:276` "Servir snapshots y clips…", SUPERVISOR "r (todo)"; `:324`) | Mismo matiz; las filas de eventos asignan a SUPERVISOR un alcance contrario al contrato vigente y a `:308`/`:310` (`r (canView)`): alinearlas con D1 y D12. Los hallazgos H8, H14–H18 y H31 remiten a §3–§6 |
| `prisma/schema.prisma` (código, no doc) | `:16-19` | Los comentarios del enum `Role` no describen lo aplicado; actualizarlos en el PR de AP-1 |

## 10. Verificaciones del inventario contra el código

| Punto | Resultado |
|---|---|
| Heartbeat: la matriz (sobre `main`) dice "sin RBAC (P0)"; el inventario (sobre `17a8597`) describe `viewableCameraIds` | Ambos correctos para su base: #189 agrega el chequeo (`liveView.ts:37-56`) |
| `UserPermissionsModal` "hereda" y ata `canPlayback = canDownload` | Cierto en el código (`UserPermissionsModal.tsx:234-251`), pero el componente no tiene importadores: hoy no se usa. El editor activo es `UsersPage` → `POST` legado |
| `POST` legado y filas de NVR: "acepta `nvrId` suelto" vs "400 si hay fila de NVR" | Ambos: el esquema acepta `nvrId` sin `cameraId` (`users.ts:28-35`), pero `UsersPage` reenvía las filas de `GET /users/:id` con `cameraId: null` y `z.string().optional()` no acepta `null` (análisis estático, `apps/web/src/pages/UsersPage.tsx:68, 121-125`) |
| `hls-auth` y #190 | `hls-auth` usa `request.jwtVerify()`; la regla `trusted` de #190 rige para esa llamada (`plugins/auth.ts:63, 96-98`): sólo access tokens. El rol sigue saliendo del JWT |
| Bypass de alertas por WS | Lee el rol ADMIN **de la base** (`websocket.ts:49-52`), no del JWT: es el único punto con rol vigente |
| Redirección `sub` → `main`/`main_h264` | Está en `startStream` (`stream-manager.ts:2110-2128`), que usan `reconcileView` y `start-stream` |
| `t` del enlace de descarga en logs | `SECRET_QUERY_PARAMS` no incluye `t` (`lib/log-redact.ts:7`) y el serializador de peticiones usa esa lista (`server.ts:64-68`). Tampoco redacta `retentionToken` |
| Dueño del grant | `services/media/media-grants.ts:275` (el inventario citaba `:272`) |
| Default de `canDownloadRecordings` para SUPERVISOR | `false` en `services/totp.ts:109` |
| `/playback` usado "para ver en MP4" (inventario) vs "código muerto" (matriz) | Gana la matriz: `loadRecordingInSlot` (`RecordingsPage.tsx:1161`) sólo se llama por `loadInSlotRef` desde su propio reintento (`:1250`, asignado en `:1398`); el único camino vivo a `POST /playback` es `triggerMp4Download` (`:1921`) |
| Cita `canHighQuality ENFORCED en liveView.ts:148` | En `main` esa línea está en `POST /client-capabilities` (decisión nativa, sólo con `NATIVE_PLAYBACK_ENABLED`); en `17a8597` se corrió y cae en `GET /capabilities`. En ninguna de las dos bases hay chequeo de calidad en el camino HLS web (`start-stream`, heartbeat, `hls-auth`) |
| Upsert de fila de NVR con `cameraId: null as any` (`users.ts:346-348`) | Sigue **sin verificar** contra PostgreSQL: las pruebas mockean Prisma |
| Duplicados de filas de NVR por `NULL` en la clave única | **Sin verificar** contra una base |
