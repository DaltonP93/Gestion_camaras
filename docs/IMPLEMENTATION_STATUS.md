# Estado de implementación por módulo — VisionCore

> Actualizado: 2026-09-06 (ciclo C23). Línea base: `main` = `0f9d1f5` (PR #168), **INTACTO — nada del
> C23 fusionado**. El trabajo C23 vive en PRs Draft (`OPEN_PR_DRAFT`); ver `docs/DEVELOPMENT_HISTORY.md §2.5`.
> Estados: MERGED_VERIFIED / MERGED_UNVERIFIED / OPEN_PR_DRAFT (en PR Draft, NO en `main`) / PARTIAL /
> SIMULATED_ONLY / NOT_VALIDATED (real no ejercido) / BLOCKED_HARDWARE / BLOCKED_SPEC / PLANNED / NOT_PRESENT.
> "Verificado" = tests o lógica pura testeada en el repo. Sin ejecución de servicios/NVR/DB reales al redactar.

### Estado C23 por Hito (todo OPEN_PR_DRAFT salvo lo indicado)
- **Hito 1** (#171 `6e633df`): SSRF profundo + RBAC centralizado. OPEN_PR_DRAFT. vitest 1342, mut 19/19.
- **Hito 2** (#173 `ab5a48b`): grant plane atómico + outbox de revocación. OPEN_PR_DRAFT. Redis real validado;
  atomicidad Postgres `SKIP LOCKED` = **NOT_VALIDATED** (sin PG real); outbox también probado **InMemory** (mock).
- **Hito 7** (#174 `fe51727`): ops/backup/CI. OPEN_PR_DRAFT. backup/restore validado contra Postgres efímero.
- **Hito 8** (#170): estos docs. **deps web** (#172 `e82bb28`): 5/6 HIGH resueltas; 1 HIGH `vite` (dev) → follow-up.
- **Hitos 3 (relay A1 real), 4 (Tauri), 5 (E2E web), 6 (IA productiva): `PLANNED`** — no ejecutados en C23.

## Convención de columnas
Estado · Archivo(s) clave · PR/Commit · Test · Limitación · Próximo paso · Definición de terminado (DoD).

---

## A. Dominio VMS de video (sistema real)

| Módulo / Feature | Estado | Archivo(s) | PR/Commit | Test | Limitación | Próximo paso | Definición de terminado |
|---|---|---|---|---|---|---|---|
| RBAC rol+cámara (ADMIN/SUPERVISOR/OPERATOR/AUDITOR) | MERGED_VERIFIED (en `main`) | `prisma/schema.prisma:15`, `UserPermission`, `middleware/requireAuth.ts` | #166 `3f473c5` | `routes/rbac-idor.route.test.ts` | `userCanAccessNvr` (nvr.ts:267) no exige `canView` **en `main`** | **#171 (Draft) centraliza RBAC en `services/access-policy.ts` con `canView`** (NO en `main`) | Todos los recursos scoped + test IDOR verde |
| Cámaras/NVR CRUD + salud + sync ISAPI | MERGED_UNVERIFIED | `routes/nvr.ts`, `routes/cameras.ts`, `services/nvrSync.ts`, `services/hikvision.ts` | histórico | Tests escasos (servicio monolítico) | Sin NVR real; **SSRF ISAPI vigente en `main`** | **#171 (Draft): SSRF profundo (`maxRedirects:0`, rechazo de redes reservadas, anti-rebinding) + tests con servidor HTTP real** (NO en `main`) | Integración validada contra NVR de laboratorio |
| Live view (multiview, HD/HEVC, heartbeat, lifecycle C1–C21) | MERGED_UNVERIFIED | `routes/liveView.ts`, `services/stream-manager.ts`, `pages/LiveViewPage.tsx` | #161 `b00bbc5` | `stream-manager*.test.ts` (lifecycle/ownership/races) | Ciclo de vida en UI sin e2e | Test refcount end-to-end | Refcount live probado navegador incluido |
| Grabaciones / playback (búsqueda, preview fMP4, MP4, fallback 453) | PARTIAL | `routes/recordings.ts`, `services/recordings/rtsp-url.ts`, `pages/RecordingsPage.tsx` | histórico | `rtsp-url` testeado; fallback 453 validado | Máquina de estados implícita; reversa/frame-atrás NO viable web | Formalizar estados + tests | Estados explícitos + suite de playback |
| PTZ | MERGED_VERIFIED | `routes/cameras.ts` `POST /:id/ptz`, `services/hikvision.ts` (ISAPI), ONVIF | histórico | lógica de comando testeada | — | — | Operativo (ya cumple) |
| Analítica de video (schema/consulta) | MERGED_VERIFIED | `routes/analytics.ts`, `CameraAnalyticsConfig`, `AnalyticsEvent`, `pages/AnalyticsPage.tsx` | #168 `dbb3a9d` | scope `/events`/`/summary`/`/live-frame` por `canView` | Dashboard en cero sin productor | Conectar productor real | Eventos poblados por pipeline real |
| Analítica — productor de eventos (pipeline YOLOX/ByteTrack) | SIMULATED_ONLY / MERGED_UNVERIFIED | `apps/analytics/app/pipeline.py`, `main.py` | histórico | `unittest` (rules/providers, sin cv2/onnx) | Modelo se descarga de GitHub en runtime; sin validación runtime | Precache + checksum del modelo | Pipeline validado con modelo local versionado |
| Alertas / notificaciones (WS + email) | MERGED_VERIFIED | `routes/alerts.ts`, `services/notification.service.ts`, `jobs/healthWorker`, `routes/websocket.ts` | #166 `96de362` | scope de alerts por `canView` | Telegram/WhatsApp solo modelo de delivery | Integrar canales extra | Solo email+WS terminados; resto backlog |
| **Contrato RBAC de alertas** (lectura vs resolución) | MERGED_VERIFIED | `routes/alerts.ts:16-37,122` | #166 `96de362` | `authorize(['ADMIN','SUPERVISOR'])` en `/:id/resolve`; scope `canView` en lectura | — | — | **Lectura/listado = todos los roles autenticados dentro de su `canView`; resolución (`PUT /api/alerts/:id/resolve`) = SOLO ADMIN/SUPERVISOR.** OPERATOR/AUDITOR NO resuelven ni una alerta de cámara permitida (obs. Codex #169, verificada) |
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
| Endurecimiento del grant plane C23 (tiempo atómico Redis, outbox de revocación durable, readiness por path) | OPEN_PR_DRAFT (#173 `ab5a48b`, flag OFF) | `services/media/grant-derivation.ts`, migración `0033_media_revoke_outbox` | #173 | vitest 1295, mut 19/19; **Redis real validado**; outbox probado InMemory (mock) | **Atomicidad Postgres `SKIP LOCKED` = NOT_VALIDATED** (sin PG real); fail-closed `REVOKE_PENDING` depende de esa atomicidad | Ejercer outbox contra Postgres real | Outbox atómico verificado contra PG real |
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
| Backup programado/offsite | NOT_PRESENT (en `main`) | Solo dump manual en `scripts/deploy.sh:58-67` | **#174 (Draft): backup/restore validado real contra Postgres efímero + `deploy.sh` fail-fast** (NO en `main`). Cron/offsite = decisión. Ver `docs/BACKUP_RESTORE.md` |
| CI migrate real contra Postgres | NOT_PRESENT | `ci.yml` sin `services: postgres` | Añadir job migrate deploy. #174 (Draft) agrega guard CI de prefijos de migración, no el migrate real |
| `migration_lock.toml` | NOT_PRESENT | Ausente en `prisma/migrations/` | Generar y versionar |
| Builds reproducibles (`npm ci`) | PARTIAL | `npm install` en Dockerfiles api/web (en `main`) | **#174 (Draft): `npm ci`** (fija deps npm, NO imágenes base por digest — pin por digest = follow-up) |
| Checksum del modelo de analytics | NOT_PRESENT (en `main`) | Descarga de GitHub en runtime sin verificación | **#174 (Draft): checksum sha256 del modelo YOLOX** |
| E2E de navegador | NOT_PRESENT | Sin Playwright/Cypress | Backlog; Hito 5 = `PLANNED`, no ejecutado en C23 |
