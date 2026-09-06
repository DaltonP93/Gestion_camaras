# Matriz de permisos de `UserPermissionsModal` — clasificación de enforcement

> Parte de PR #171 (revisión de RBAC). Clasifica CADA permiso que muestra
> `apps/web/src/components/UserPermissionsModal.tsx` según si el **backend** lo
> aplica de verdad. Objetivo: distinguir el control real de la casilla decorativa,
> para no dar por protegido lo que no lo está.
>
> Alcance: estado del código en la rama `fix/nvr-ssrf-authz`. Evidencia por
> `archivo:línea`. No autoriza cambios de comportamiento por sí mismo.

## Vocabulario

- **ENFORCED_BACKEND** — el API (`apps/api/src`) LEE el campo para permitir/denegar
  o filtrar datos. Es un control real.
- **SUPERSEDED** — su intención la cumple hoy OTRO mecanismo: el rol vía
  `server.authorize([...])` (`plugins/auth.ts`) o el scoping por `canView` de
  `services/access-policy.ts` / `services/camera-scope.ts`. El campo es redundante
  como control independiente (no se lee).
- **UI_ONLY** — se almacena y a lo sumo lo usa el frontend para mostrar/ocultar UI,
  pero el API NO lo lee para nada. Una petición fabricada lo evade ⇒ **no es un
  control de seguridad**.
- **UNUSED** — nada fuera del schema y el propio modal lo referencia.

## Hallazgo principal

`NvrPermission` y `CameraPermission` del frontend son **una sola** tabla Prisma
`UserPermission` (`prisma/schema.prisma:268`), diferenciada por `nvrId` vs
`cameraId`. El PUT/GET (`routes/users.ts:307-320` upsert, `:400-419` echo) sólo
**guarda y devuelve** estos campos — eso NO es enforcement.

Del lado del servidor sólo se leen para gatear acciones **4 campos del modal**:
`canView`, `canPlayback`, `canHighQuality` (por recurso) y `canManageAppearance`
(feature). El resto se gatea —si acaso— por **rol** (`server.authorize([...])`,
`plugins/auth.ts:86-115`) o por el scoping de `canView`.

Los helpers de feature del frontend (`canFeature` / `canViewRecordings` /
`canManageUsers` / `canConfigureNVR` en `stores/authStore.ts:213-239`) son **código
muerto** (sin llamadas). El ruteo/nav del frontend gatea por **rol**
(`App.tsx:57-108`, `Sidebar.tsx:191`), nunca por estos flags.

> **Riesgo (P2/P3, follow-up con autorización):** los campos **UI_ONLY** sugieren
> un control que no existe. No se “arreglan” en este PR (sería un cambio de
> comportamiento); se documentan para que el propietario decida entre (a) hacerlos
> ENFORCED_BACKEND o (b) quitarlos del modal para no prometer lo que no cumplen.

## NVR-scoped (`NVR_FIELDS`, pestaña "NVRs")

| Campo | Clasificación | Evidencia / mecanismo real |
|---|---|---|
| `canView` | **ENFORCED_BACKEND** | `services/access-policy.ts:31,54,71,76,92`; gate real de lectura de NVR |
| `canViewCameras` | SUPERSEDED | No se lee; lista de cámaras scopeada por `canView` (`access-policy.ts:88` `getVisibleNvrMap`, `camera-scope.ts:11`) |
| `canViewRecordings` | SUPERSEDED | Grabaciones gateadas por `canPlayback` (`routes/recordings.ts:1413`) + rol `authorize(['ADMIN','SUPERVISOR','AUDITOR'])` (`recordings.ts:1376`) |
| `canManage` | SUPERSEDED | Gestión de NVR por rol `authorize(['ADMIN'])` (`routes/nvr.ts:1277` PUT, `:1320` DELETE) |
| `canEditVideoAudio` | SUPERSEDED | Edición video/audio por rol `authorize(['ADMIN'])` (`routes/nvr.ts:1748`) |
| `canSync` | SUPERSEDED | Sync por rol `authorize(['ADMIN','SUPERVISOR'])` (`routes/nvr.ts:517,679`) |
| `canRevalidate` | SUPERSEDED | Validate-health por rol `authorize(['ADMIN','SUPERVISOR'])` (`routes/nvr.ts:1023`) |
| `canRestart` | SUPERSEDED | Reboot de NVR por rol `authorize(['ADMIN'])` (`routes/nvr.ts:1043`) |

## Camera-scoped (`CAM_FIELDS`, pestaña "Cámaras")

| Campo | Clasificación | Evidencia / mecanismo real |
|---|---|---|
| `canView` | **ENFORCED_BACKEND** | `services/camera-scope.ts:11`, `routes/cameras.ts:42-46,90`, `routes/liveView.ts:148`, `routes/mediaGrants.ts:61`, `services/media/native-readiness.ts:79`, `routes/websocket.ts:54`, `routes/search.ts:49` |
| `canViewLive` | SUPERSEDED | Live gateado por `canView` (`liveView.ts:148`, `native-readiness.ts:88`) |
| `canPlayback` | **ENFORCED_BACKEND** | `routes/recordings.ts:1413,1462,1512,1597,2010` (`where { canPlayback: true }`) |
| `canDownload` | SUPERSEDED | Export gateado por `canPlayback` (`recordings.ts:1597,2010`) + rol `authorize(['ADMIN'])` (`recordings.ts:1976`) |
| `canHighQuality` | **ENFORCED_BACKEND** | `routes/liveView.ts:148`, `routes/mediaGrants.ts:61`, `native-readiness.ts:80,89` (main/HD lo exige) |
| `canUseMainStream` | SUPERSEDED | HD/main decidido por `canHighQuality` (`native-readiness.ts:80`), no por este campo |
| `canUseTranscode` | **UI_ONLY** ⚠ | Sólo en `routes/users.ts` (Zod `:74`, echo `:417`); sin lectura de gate. Transcode se decide por códec/cupo (`services/transcode-profile.ts`, `live-playback-decision.ts`) ⇒ evadible |
| `canAddToViews` | SUPERSEDED | Vistas por rol `authorize(['ADMIN','SUPERVISOR'])` (`routes/views.ts:75,102,137`) |
| `canReceiveAlerts` | SUPERSEDED | Visibilidad de alertas scopeada por `canView` (`services/alert-query.ts:61`, `routes/alerts.ts:26,54`) |

## Feature (`UserFeaturePermissions`, `FEATURE_DEFS`)

Guardados por `routes/users.ts:317`; devueltos (resueltos contra defaults de rol)
por `routes/auth.ts:868` / `users.ts:166`. Sólo `canManageAppearance` se lee para gatear.

| Campo | Clasificación | Evidencia / mecanismo real |
|---|---|---|
| `canViewDashboard` | **UI_ONLY** ⚠ | `/dashboard/overview` abierto a cualquier autenticado (`routes/dashboard.ts:10`) |
| `canViewLive` | **UI_ONLY** ⚠ | `/live` abierto a todo autenticado (`App.tsx:60`); datos por `canView` de recurso |
| `canViewRecordings` | SUPERSEDED | Rol `authorize(['ADMIN','SUPERVISOR','AUDITOR'])` (`recordings.ts:1376`); helper front muerto (`authStore.ts:220`) |
| `canViewAlerts` | **UI_ONLY** ⚠ | `/alerts` abierto a todo autenticado (`App.tsx:68`); filas por `canView` de recurso |
| `canViewDiagnostics` | SUPERSEDED | Rol `authorize(['ADMIN'])` (`routes/diagnostics.ts:22,143`) |
| `canManageNVRs` | SUPERSEDED | Rol `authorize(['ADMIN'/'SUPERVISOR'])` (`routes/nvr.ts:1208,1277,1320`); helper front muerto (`authStore.ts:234`) |
| `canManageCameras` | SUPERSEDED | Rol `authorize(['ADMIN','SUPERVISOR'])` (`routes/cameras.ts:714,724`) |
| `canManageUsers` | SUPERSEDED | Rol `authorize(['ADMIN'])` (`routes/users.ts:88,114,132,306,429`); helper front muerto (`authStore.ts:227`) |
| `canManageAppearance` | **ENFORCED_BACKEND** | `routes/appearance.ts:82` vía `services/appearance-policy.ts:16-22` — el único feature-flag aplicado |
| `canResolveAlerts` | SUPERSEDED | Rol `authorize(['ADMIN','SUPERVISOR'])` (`routes/alerts.ts:122`) |
| `canRestartStreams` | SUPERSEDED | Rol `authorize(['ADMIN','SUPERVISOR'])` (`routes/cameras.ts:281`) |
| `canTranscode` | **UI_ONLY** ⚠ | Sólo Zod (`users.ts:48`) + plantillas de rol; sin gate ⇒ evadible |
| `canDownloadRecordings` | SUPERSEDED | Rol `authorize(['ADMIN'])` (`recordings.ts:1976`) + `canPlayback` |
| `canManageViews` | SUPERSEDED | Rol `authorize(['ADMIN','SUPERVISOR'])` (`routes/views.ts:75,102,137`) |
| `canManageSettings` | SUPERSEDED | Rol `authorize(['ADMIN'])` (`routes/security.ts:34`, `alertSettings.ts:23,46,60,81`) |

## Campos de schema NO renderizados por el modal (nota)

- **`canPtz`** (`schema.prisma:280`): ausente del modal, pero SÍ enforced —
  `routes/cameras.ts:346` (`userCanAccessCamera(..., 'canPtz')`) y arg válido de
  `requireCameraAccess` (`middleware/requireAuth.ts:39`). Sólo lo escribe la grilla
  legacy `pages/UsersPage.tsx:80,205,215` (columna reetiquetada "Gestionar"), no el
  modal. ⇒ ENFORCED_BACKEND pero inalcanzable desde `UserPermissionsModal`.

## Resumen

- **ENFORCED_BACKEND (4):** `canView`, `canPlayback`, `canHighQuality`,
  `canManageAppearance`. (+`canPtz`, fuera del modal.)
- **UI_ONLY / evadibles (5):** `canUseTranscode`, `canTranscode`,
  `canViewDashboard`, `canViewLive` (feature), `canViewAlerts`.
- **SUPERSEDED por rol o por `canView` (el resto).**
- **UNUSED:** ninguno estricto; los SUPERSEDED se guardan pero no gatean.

El endurecimiento (hacer ENFORCED o quitar del modal los UI_ONLY) queda como
follow-up con autorización explícita del propietario — no se ejecuta en este PR.

## Decisión propuesta por cada campo UI_ONLY (P2 — requiere autorización)

Los cinco campos **UI_ONLY** son controles EVADIBLES: sugieren protección que el
backend no aplica. **No constituyen RBAC**. Propuesta concreta por campo
(implementación en un PR aparte, con autorización; NO en este PR):

| Campo | Ámbito | Decisión propuesta | Justificación |
|---|---|---|---|
| `canUseTranscode` | cámara | **ELIMINAR del modal** | No existe un gate "por cámara" de transcode: el HD/main_h264 se decide por códec/cupo y el acceso HD ya lo gobierna `canHighQuality` (ENFORCED). Mantenerlo promete un control inexistente. |
| `canTranscode` | feature | **ELIMINAR del modal** | Duplica a `canUseTranscode` a nivel feature y tampoco se lee. Sin semántica de gate propia. |
| `canViewDashboard` | feature | **ENFORCE backend** | `/dashboard/overview` (`routes/dashboard.ts:10`) está abierto a cualquier autenticado y agrega conteos NVR/cámara/alerta. Gate mínimo: exigir el flag resuelto (`resolveFeaturePermissions`) en la ruta. |
| `canViewLive` (feature) | feature | **ELIMINAR del modal** | El acceso a vivo ya está gateado POR CÁMARA por `canView` (ENFORCED en `liveView.ts`/`native-readiness.ts`). El flag feature no se lee y da falsa sensación de control. |
| `canViewAlerts` | feature | **ELIMINAR del modal** | Las alertas ya se filtran por `canView` de recurso (`alert-query.ts:61`). El flag feature no se lee. |

Regla general de la propuesta: **enforcement backend** cuando el recurso es
NVR-wide/agregado y hoy queda abierto (dashboard); **eliminación del modal** cuando
el control real ya lo cumple `canView`/`canHighQuality`/rol y el flag sólo aparenta
proteger. En ningún caso se declara RBAC completo por estos campos.
