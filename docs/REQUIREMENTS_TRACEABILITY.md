# Matriz de trazabilidad de requisitos — VisionCore

> Actualizado: 2026-09-06. Base: `main` = `0f9d1f5`. Fuente: AGENTE 1 (funcional) verificado contra código.
> Formato: Requisito → Estado → Evidencia → Faltante → Criterio de aceptación.
> Dos bloques: (1) requisitos del MANDATO original (dominio control de acceso físico, mayormente
> NOT_PRESENT/N/A con evidencia de ausencia) y (2) requisitos del SISTEMA REAL (VMS de video).

---

## 1. Requisitos del MANDATO (dominio control de acceso físico) — NOT_PRESENT / N/A

Este repo NO contiene control de acceso físico. Evidencia global de ausencia: `prisma/schema.prisma`
sin modelos de acceso; grep de `anti-passback|interlock|cardholder|door controller|access level|
turnstile|wiegand|apertura remota|torniquete|tarjeta de acceso|fichada|asistencia|MDB|Company|Tenant|
multiempresa|multi-tenant` sobre `apps/api/src`, `apps/web/src`, `prisma/` = 0 coincidencias reales
(2 falsos positivos: `"ISAPI access level"` en `routes/nvr.ts:625` y `services/nvrSync.ts:74`).

| Requisito | Estado | Evidencia | Faltante | Criterio de aceptación |
|---|---|---|---|---|
| Objetivo real (control de acceso físico) | N/A | Todo el árbol es VMS de video; sin dominio de puertas/accesos | El sistema completo | Existiría un dominio de acceso (controladoras/puertas/eventos de paso) |
| Multiempresa / multi-tenant | NOT_PRESENT | `schema.prisma` sin `Company/Tenant/Organization`; sin `tenantId` | Modelo tenant + aislamiento | Modelo Tenant + FK y scoping en todas las queries |
| Roles y permisos (RBAC) | PRESENTE (dominio VMS, no accesos) | `schema.prisma:15`; `UserPermission`, `UserFeaturePermissions` | RBAC es de cámaras/grabaciones | RBAC sobre puertas/niveles (no aplica: dominio ausente) |
| Personas y credenciales (cardholders) | NOT_PRESENT | Sin `Person/Cardholder/Credential` | Todo el submódulo | Alta de personas + credenciales asignables |
| Controladoras y puertas | NOT_PRESENT | Sin `Controller/Door`; `NVR`/`Camera` son video | Todo el submódulo | CRUD de controladoras y puertas |
| Horarios y niveles de acceso | NOT_PRESENT | Sin `Schedule/AccessLevel`; `CameraView` es layout de video | Todo el submódulo | Franjas horarias + niveles |
| Eventos y monitoreo de acceso | N/A | `Alert`/`AnalyticsEvent` son eventos de video/salud | Eventos de paso por puerta | Feed entrada/salida por puerta |
| Apertura remota | NOT_PRESENT | Grep `apertura/abrir puerta/open door`: solo `beginOperation` (stream) | Comando de apertura | Botón→endpoint que comanda controladora |
| Doble aprobación de apertura | N/A | No existe apertura remota | — | — |
| Asistencia / fichada (TZ, turnos nocturnos) | NOT_PRESENT | Sin modelo ni ruta de asistencia | Todo el submódulo | Registro y reporte de asistencia |
| Anti-passback / interlock / multicard | N/A | Sin control de acceso físico | — | — |
| Importación legacy (CSV/MDB) | NOT_PRESENT | Sin lectura `.mdb`/CSV de accesos; sin driver MDB | Importador legacy | Parser MDB→modelos de acceso |
| Reportes de acceso/asistencia | NOT_PRESENT | `analytics.ts`/`recordings.ts` reportan video | Reportería de acceso | Reportes por persona/puerta |
| PIN / tarjetas | NOT_PRESENT | Sin `Card/PIN`; `LicensePlateEvent` es ALPR de video | Todo el submódulo | Emisión/validación de tarjeta/PIN |
| Gateway de controladoras | N/A | `mediamtxAuth.ts`/`integrations.ts` son gateways de medios | Gateway de acceso | Servicio puente hacia controladoras físicas |
| Sesiones activas tras suspender empresa | N/A | Sin modelo Company/tenant | — | — |
| Revocaciones sincronizadas con placa/tarjeta | N/A | Sin credenciales de acceso | — | — |
| Driver UDP experimental (control de acceso) | N/A | Transporte es RTSP→MediaMTX | — | — |
| Validación con controladora física | N/A | Sistema VMS; sin controladora | — | — |
| Diferencias con software legacy de acceso | N/A | No hay legacy de acceso con qué comparar | — | — |
| Internacionalización (i18n) | NOT_PRESENT | Sin `i18next`/`react-i18next`; UI hardcodeada español | Framework i18n + catálogos | Cambio de idioma en runtime |

---

## 2. Requisitos del SISTEMA REAL (VMS de video)

| Requisito | Estado | Evidencia | Faltante | Criterio de aceptación |
|---|---|---|---|---|
| Cámaras / NVR (CRUD, salud, sync) | MERGED_UNVERIFIED | `routes/nvr.ts`, `routes/cameras.ts`, `services/nvrSync.ts`, `services/hikvision.ts`; modelos `NVR`/`Camera` | Tests de integración escasos; sin NVR real | Tests de integración ISAPI contra NVR de laboratorio |
| Live view (multiview, HD/HEVC, heartbeat) | MERGED_UNVERIFIED | `routes/liveView.ts`, `services/stream-manager.ts`, `pages/LiveViewPage.tsx`; `stream-manager*.test.ts` | Cobertura de ciclo de vida en UI | Tests de refcount live end-to-end |
| Grabaciones / playback (búsqueda, preview fMP4, MP4, 453) | PARTIAL | `routes/recordings.ts`, `services/recordings/rtsp-url.ts` (testeado); fallback 453 VALIDADO | Máquina de estados implícita; reversa/frame-atrás no viable web | Formalizar estados + tests |
| PTZ | MERGED_VERIFIED | `routes/cameras.ts POST /:id/ptz`; ISAPI + ONVIF | — | Operativo |
| Analítica de video (YOLOX/ByteTrack, zonas/líneas) | MERGED_UNVERIFIED (schema VERIFIED / productor SIMULATED) | `apps/analytics/app/pipeline.py`, `main.py`; `routes/analytics.ts`; `CameraAnalyticsConfig`/`AnalyticsEvent` | Modelo runtime externo; sin validación de pipeline | Pipeline validado con modelo local + tests |
| Alertas / notificaciones (WS + email) | MERGED_VERIFIED | `routes/alerts.ts`, `services/notification.service.ts`, `healthWorker`, `routes/websocket.ts`; `NotificationDelivery` | Telegram/WhatsApp sin integración | Integrar canales extra |
| ONVIF (discovery/StreamUri/PTZ/imaging) | MERGED_VERIFIED (flag OFF) | `routes/onvif.ts` (`ONVIF_ENABLED`), `services/onvif/*` (con tests), `IntegrationsPage.tsx` | I/O de red real no ejercido | Prueba contra dispositivo real |
| Hik-Connect (token cloud/HLS/ISAPI-proxy) | MERGED_UNVERIFIED (flag OFF) | `routes/hikConnect.ts` (`HIK_CONNECT_ENABLED`), `services/providers/hik-connect/*`, UI | Sin validación contra nube real | Prueba con cuenta real |
| Frigate (ingestor externo) | MERGED_UNVERIFIED (flag OFF) | `apps/analytics/app/frigate/*`; `main.py` gated `FRIGATE_ENABLED` | Sin validación runtime | Prueba con instancia Frigate |
| Reproducción nativa / grants de medios (C22/A1) | PARTIAL / BLOCKED_SPEC | `apps/native/shared/*` (TS testeado); `services/media/*`, `routes/mediaGrants.ts`; Tauri skeleton | Binarios Rust ausentes; relay A1 NO-GO | Compilar Tauri + relay con auth por path |
| ALPR / matrículas | SIMULATED_ONLY | `LicensePlateEvent`; `routes/analytics.ts GET /plates`; `ANALYTICS_ALPR_ENABLED=false` | Provider detector+OCR | Provider con licencia + tests |
| Detección de caídas | PLANNED | scaffold; `ANALYTICS_FALL_DETECTION_ENABLED=false`; sin modelo | Modelo pose + provider | Provider + eventos + tests mock |
| 2FA / seguridad / auditoría | MERGED_VERIFIED | `services/totp.ts`, `SecuritySettings`, `AuditLog`, `routes/auth.ts`; `credentials.ts` (AES-256-GCM) | — (JWT stale de rol, mitigado) | Operativo; test IDOR presente |
| RBAC por cámara (no acceso físico) | MERGED_VERIFIED | `UserPermission`, `middleware/requireAuth.ts`; `rbac-idor.route.test.ts` | `userCanAccessNvr` laxo (nvr.ts:267) | Endurecer scope NVR + test |
| Backup / restore de evidencia (invariante #1) | NOT_PRESENT (programado) / PARTIAL (manual) | `scripts/deploy.sh:58-67` dump manual; `DEPLOY.md:124-126` restore manual | Cron/offsite/RPO/RTO/prueba de restauración | Backup programado + restore probado (ver `docs/BACKUP_RESTORE.md`) |
