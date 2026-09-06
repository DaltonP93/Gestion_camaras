# Estado de implementación por módulo — VisionCore

> Actualizado: 2026-09-06. Línea base: `main` = `0f9d1f5` (PR #168).
> Estados: MERGED_VERIFIED / MERGED_UNVERIFIED / OPEN_PR_* / PARTIAL / SIMULATED_ONLY /
> BLOCKED_HARDWARE / BLOCKED_SPEC / PLANNED / NOT_PRESENT. "Verificado" = tests o lógica pura testeada
> en el repo. Sin ejecución de servicios/NVR/DB reales.

## Convención de columnas
Estado · Archivo(s) clave · PR/Commit · Test · Limitación · Próximo paso · Definición de terminado (DoD).

---

## A. Dominio VMS de video (sistema real)

| Módulo / Feature | Estado | Archivo(s) | PR/Commit | Test | Limitación | Próximo paso | Definición de terminado |
|---|---|---|---|---|---|---|---|
| RBAC rol+cámara (ADMIN/SUPERVISOR/OPERATOR/OPERATOR/AUDITOR) | MERGED_VERIFIED | `prisma/schema.prisma:15`, `UserPermission`, `middleware/requireAuth.ts` | #166 `3f473c5` | `routes/rbac-idor.route.test.ts` | `userCanAccessNvr` (nvr.ts:267) no exige `canView` | Endurecer scope NVR | Todos los recursos scoped + test IDOR verde |
| Cámaras/NVR CRUD + salud + sync ISAPI | MERGED_UNVERIFIED | `routes/nvr.ts`, `routes/cameras.ts`, `services/nvrSync.ts`, `services/hikvision.ts` | histórico | Tests escasos (servicio monolítico) | Sin NVR real en este entorno; SSRF ISAPI | Test integración ISAPI + allowlist | Integración validada contra NVR de laboratorio |
| Live view (multiview, HD/HEVC, heartbeat, lifecycle C1–C21) | MERGED_UNVERIFIED | `routes/liveView.ts`, `services/stream-manager.ts`, `pages/LiveViewPage.tsx` | #161 `b00bbc5` | `stream-manager*.test.ts` (lifecycle/ownership/races) | Ciclo de vida en UI sin e2e | Test refcount end-to-end | Refcount live probado navegador incluido |
| Grabaciones / playback (búsqueda, preview fMP4, MP4, fallback 453) | PARTIAL | `routes/recordings.ts`, `services/recordings/rtsp-url.ts`, `pages/RecordingsPage.tsx` | histórico | `rtsp-url` testeado; fallback 453 validado | Máquina de estados implícita; reversa/frame-atrás NO viable web | Formalizar estados + tests | Estados explícitos + suite de playback |
| PTZ | MERGED_VERIFIED | `routes/cameras.ts` `POST /:id/ptz`, `services/hikvision.ts` (ISAPI), ONVIF | histórico | lógica de comando testeada | — | — | Operativo (ya cumple) |
| Analítica de video (schema/consulta) | MERGED_VERIFIED | `routes/analytics.ts`, `CameraAnalyticsConfig`, `AnalyticsEvent`, `pages/AnalyticsPage.tsx` | #168 `dbb3a9d` | scope `/events`/`/summary`/`/live-frame` por `canView` | Dashboard en cero sin productor | Conectar productor real | Eventos poblados por pipeline real |
| Analítica — productor de eventos (pipeline YOLOX/ByteTrack) | SIMULATED_ONLY / MERGED_UNVERIFIED | `apps/analytics/app/pipeline.py`, `main.py` | histórico | `unittest` (rules/providers, sin cv2/onnx) | Modelo se descarga de GitHub en runtime; sin validación runtime | Precache + checksum del modelo | Pipeline validado con modelo local versionado |
| Alertas / notificaciones (WS + email) | MERGED_VERIFIED | `routes/alerts.ts`, `services/notification.service.ts`, `jobs/healthWorker`, `routes/websocket.ts` | #166 `96de362` | scope de alerts por `canView` | Telegram/WhatsApp solo modelo de delivery | Integrar canales extra | Solo email+WS terminados; resto backlog |
| 2FA TOTP / step-up / rotación refresh / auditoría | MERGED_VERIFIED | `routes/auth.ts`, `services/totp.ts`, `SecuritySettings`, `AuditLog`, `services/credentials.ts` | #162 `08682bf` | credenciales AES testeadas; rotación con detección de reúso | JWT no refleja cambios de rol hasta expirar | — (mitigado por TTL) | MFA obligatoria cableada (ya cumple) |
| Cifrado credenciales NVR (AES-256-GCM + scrypt) | MERGED_VERIFIED | `services/credentials.ts` | #162 `08682bf` | tests de cripto | `NVR_CREDENTIAL_KEY` obligatoria en prod | — | Formato versionado + fail-fast (ya cumple) |

## B. Integraciones (flags OFF por defecto)

| Módulo | Estado | Archivo(s) | PR/Commit | Test | Limitación | Próximo paso | DoD |
|---|---|---|---|---|---|---|---|
| ONVIF (discovery/StreamUri/PTZ/imaging) | MERGED_VERIFIED (flag OFF) | `routes/onvif.ts`, `services/onvif/*`, `IntegrationsPage.tsx` | #162 `ece5524`,`98f6c42` | núcleo SOAP/WS-Discovery + SSRF testeado | I/O de red real no ejercido | Prueba contra dispositivo ONVIF | Validado contra cámara ONVIF real |
| Hik-Connect (token cloud/HLS/ISAPI-proxy) | MERGED_UNVERIFIED (flag OFF) | `routes/hikConnect.ts`, `services/providers/hik-connect/*` | #162 `3ade2f5`,`4e6c01b` | SSRF de proxy testeado | Sin validación contra nube real | Prueba con cuenta Hik-Connect | Validado contra cuenta real |
| Frigate (ingestor externo de detección) | MERGED_UNVERIFIED (flag OFF) | `apps/analytics/app/frigate/*` | #162 `fe02f2d`,`490d4ad` | `test_frigate_*.py` (map/derive/normalize/snapshot cap) | Sin validación runtime | Prueba con instancia Frigate | Validado contra Frigate real |

## C. Reproducción nativa / medios (C22 / A1)

| Módulo | Estado | Archivo(s) | PR/Commit | Test | Limitación | Próximo paso | DoD |
|---|---|---|---|---|---|---|---|
| Plano de grants de medios (hash-only, uso único atómico, epoch durable) | MERGED_VERIFIED (flag OFF) | `services/media/*`, `routes/mediaGrants.ts` | #162 (`8f4dc95`,`a58bd4f`,`0a93c27`,`5b6ab8f`) | grants testeados; mutaciones 19/19 | Inerte por defecto (`NATIVE_PLAYBACK_ENABLED` OFF) | Prueba con flags ON en lab | Grants probados replay/expiry/epoch/scope |
| Cliente nativo Tauri/Rust | BLOCKED_SPEC | `apps/native/shared/*` (TS), `apps/native/src-tauri/*` | histórico | shared-core TS testeado | Skeleton NO compilado; sin binarios | Compilar Tauri | Binario firmado + reproducción real |
| Relay A1 autenticado | BLOCKED_SPEC (NO-GO) | `docs/native/A1_RELAY_DESIGN.md`, `routes` internas MediaMTX | #162 (`a8570ed`,`7091b13`,`70780a8`) | auth-hook cableado | NO-GO mientras MediaMTX use `user: any` | Rediseñar auth por path en MediaMTX | Relay con auth por path + regresión de red |

## D. Simulado / planeado

| Módulo | Estado | Archivo(s) | Test | Limitación | DoD |
|---|---|---|---|---|---|
| ALPR / matrículas | SIMULATED_ONLY | `LicensePlateEvent`, `routes/analytics.ts GET /plates` | — | `ANALYTICS_ALPR_ENABLED=false`; sin detector/OCR real | Provider con licencia compatible + tests |
| Telegram / WhatsApp | SIMULATED_ONLY | `NotificationDelivery` (modelo) | — | Canal en modelo, sin integración ni disparador | Integración real + UI + tests |
| Detección de caídas | PLANNED | scaffold (`docs/audit/MISSING_FEATURES.md §C`) | — | `ANALYTICS_FALL_DETECTION_ENABLED=false`; sin modelo | Modelo pose + eventos + tests mock |

## E. Ausente / N/A en este repo VMS (evidencia de ausencia)

| Módulo del mandato | Estado | Evidencia de ausencia |
|---|---|---|
| Control de acceso físico (puertas/controladoras) | NOT_PRESENT | Sin `Controller/Door` en `schema.prisma`; 0 grep de dominio |
| Tarjetas / PIN / credenciales | NOT_PRESENT | Sin `Card/Credential/PIN` |
| Multiempresa / multi-tenant | NOT_PRESENT | Sin `Company/Tenant/Organization`; sin `tenantId` |
| Asistencia / fichadas | NOT_PRESENT | Sin modelo ni ruta de asistencia |
| Apertura remota / doble aprobación | NOT_PRESENT | Sin endpoint de apertura; `beginOperation` es de streams |
| Importación legacy MDB/CSV de accesos | NOT_PRESENT | Sin driver MDB ni parser de accesos |
| Gateway de controladoras | N/A | `mediamtxAuth.ts`/`integrations.ts` son gateways de medios |
| i18n (multilenguaje) | NOT_PRESENT | Sin `i18next`/`react-i18next`; UI hardcodeada español |

## F. DevOps / operación

| Ítem | Estado | Evidencia | Próximo paso |
|---|---|---|---|
| Backup programado/offsite | NOT_PRESENT | Solo dump manual en `scripts/deploy.sh:58-67` | Script probado + cron/offsite (decisión) — ver `docs/BACKUP_RESTORE.md` |
| CI migrate real contra Postgres | NOT_PRESENT | `ci.yml` sin `services: postgres` | Añadir job migrate deploy |
| `migration_lock.toml` | NOT_PRESENT | Ausente en `prisma/migrations/` | Generar y versionar |
| Builds reproducibles (`npm ci`) | PARTIAL | `npm install` en Dockerfiles api/web | Migrar a `npm ci` |
| E2E de navegador | NOT_PRESENT | Sin Playwright/Cypress | Backlog P2 |
