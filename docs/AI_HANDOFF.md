# Handoff operativo para IA — VisionCore (ENTRADA CANÓNICA)

> Actualizado: 2026-09-06. Reconstrucción de estado multi-agente.
> Alcance: contexto del código versionado. NO describe ni autoriza cambios en producción.
> **Criterio de aceptación de este documento:** otro agente (p. ej. Codex) debe poder
> continuar el trabajo SOLO con la URL del repositorio + este archivo.

---

## 0. Empezá por aquí (para el próximo agente)

1. `git status --short` (debe estar limpio) y `git log -1` para confirmar el HEAD.
2. Confirmar la línea base: `main` = `0f9d1f54c525f3959e75730689f943f4602ff921` (fusión del PR #168).
3. Leer, en este orden: esta sección, §1 (propósito), §4 (estado real por capa),
   `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/SECURITY.md`,
   `docs/DEPLOYMENT.md`.
4. **No asumir que `main` == estado del servidor.** No hay despliegue verificado desde este entorno.
5. Primera tarea recomendada: ver §12. No fusionar, no desplegar, no migrar sin autorización expresa.

**Vocabulario de estados usado en todos los docs canónicos:**
`MERGED_VERIFIED` (en main + cubierto por tests/lógica pura testeada),
`MERGED_UNVERIFIED` (en main, cableado, sin cobertura suficiente o sin ejercicio contra hardware real),
`OPEN_PR_*`, `PARTIAL`, `SIMULATED_ONLY`, `BLOCKED_HARDWARE`, `BLOCKED_SPEC`, `PLANNED`,
`NOT_PRESENT` (no existe en el repo, con evidencia de ausencia), `SUPERSEDED`, `REJECTED`.
Nunca se declara "completo" sin archivo + evidencia.

---

## 1. Propósito e identidad del sistema (resuelto)

VisionCore (`Gestion_camaras`) es un **VMS (Video Management System) web para NVR Hikvision**:
vista en vivo, grabaciones/playback, gestión de cámaras/NVR, usuarios, roles, control de acceso
*a la aplicación* (RBAC por cámara), PTZ, analítica de video, alertas y notificaciones.
Protege la continuidad de visualización y la evidencia de grabaciones; no es solo un dashboard.

**NO es un sistema de control de acceso físico.** No existen modelos ni rutas de
puertas/controladoras/tarjetas/PIN/asistencia/multiempresa. Evidencia: `prisma/schema.prisma` no
contiene `Company/Tenant/Organization/Person/Cardholder/Controller/Door/Card/Credential/Schedule/
AccessLevel/Attendance`; grep de `anti-passback|interlock|cardholder|wiegand|torniquete|fichada|
asistencia|MDB|multiempresa|multi-tenant` sobre `apps/api/src`, `apps/web/src`, `prisma/` = 0
coincidencias reales. El enum `Role` (`schema.prisma:15`) es `ADMIN/SUPERVISOR/OPERATOR/AUDITOR`
(roles de VMS). Todo requisito de control de acceso / multiempresa / asistencia / gateway de puertas /
importación MDB es **NOT_PRESENT / N/A** en este repo (detalle en `docs/REQUIREMENTS_TRACEABILITY.md`).

---

## 2. Arquitectura actual

- `apps/api` — Node.js (Fastify + Prisma). Rutas en `src/routes`, servicios en `src/services`,
  jobs in-process en `src/jobs` (`syncWorker`, `healthWorker`, intervalo ~60s).
- `apps/web` — React 18 + Vite + TypeScript + Tailwind + Zustand.
- `apps/analytics` — Python/FastAPI (pipeline YOLOX/ByteTrack; nunca crashea, degrada).
- `apps/native` — cliente nativo (shared-core TS + skeleton Tauri/Rust, NO compilado).
- PostgreSQL (estado/evidencia), Redis (sesiones, rate-limit, grants de medios, registro de consumidores).
- MediaMTX: RTSP → HLS/WebRTC. Nginx: proxy TLS. Docker Compose orquesta todo (Linux).
- Despliegue = **1 proceso Node** (sin cluster/PM2). El estado compartido (rate-limit, sesiones,
  grants) está en Redis, pero varios mapas de sesión de medios y la revocación de WS son **por-proceso**.

Diagramas/detalle: `docs/architecture/SYSTEM_ARCHITECTURE.md`, `STREAMING.md`, `docs/recordings/ARCHITECTURE.md`.

---

## 3. Tecnologías y versiones (verificadas en el árbol)

**apps/api** (`apps/api/package.json`): Fastify `^5.12.1`, `@fastify/jwt ^10.1`, `@fastify/static ^10.1.3`
(parche path-traversal), `@fastify/rate-limit ^10.3`, `@fastify/redis ^7.2`, `@prisma/client ^5.14` /
`prisma ^5.22`, `axios ^1.20`, `nodemailer ^9.1.1`, `otplib ^13.4.1`, `bcryptjs ^2.4.3`, `bullmq ^5.8.1`,
`node-cron ^4.6`, `pino ^9.2`, `zod ^3.23.8`. Dev: TypeScript `^5.5.3`, `vitest ^4.1.10`, `tsx ^4.16`.
**apps/web** (`apps/web/package.json`): React `^18.3.1`, Vite `^5.3.4`, `react-router-dom ^6.24.1`,
`axios ^1.7.2` (⚠ ver riesgos), `zustand ^4.5.4`, `hls.js ^1.5.13`, `react-player ^2.16`, `recharts ^2.12.7`,
Tailwind `^3.4.6`, Radix UI. Dev: TypeScript `^5.5.3`, `vitest ^4.1.10`.
**Imágenes Docker** (`docker-compose.yml`, estado de `main`): `postgres:16.4-alpine`, `redis:7.4-alpine`,
`bluenviron/mediamtx:1.9.3`, `ghcr.io/blakeblackshear/frigate:0.14.1`, `nginx:1.27-alpine`,
`certbot/certbot:v3.0.1`. Imágenes de build: `node:20-alpine` (api/web), `python:3.11-slim` (analytics).
Ningún servicio usa digest `@sha256:`; `nginx:alpine` interno de web y bases de build flotan por patch.
CI usa Node 22 (leve desalineación con Node 20 de las imágenes).

---

## 4. Estado real por capa (merged / rama / simulado / ausente)

Detalle completo con archivo/PR/commit/test en `docs/IMPLEMENTATION_STATUS.md`.

**MERGED en `main` (verificado por tests o lógica pura):**
- RBAC por rol + cámara (ADMIN/SUPERVISOR/OPERATOR/AUDITOR). Test: `routes/rbac-idor.route.test.ts`.
- PTZ (ISAPI `PTZCtrl/.../continuous` + vía ONVIF).
- 2FA TOTP obligatoria por política, step-up, rotación de refresh con detección de reúso, AuditLog.
- Alertas/notificaciones por WebSocket + email (`services/notification.service.ts`, `healthWorker`).
- ONVIF (núcleo SOAP/WS-Discovery testeado; flag `ONVIF_ENABLED` **OFF**).
- Plano de medios C22 (`services/media/*`): grants hash-only, uso único atómico (Lua/Redis), epoch durable.

**MERGED en `main` (sin verificación contra hardware/servicio real):**
- Cámaras/NVR (CRUD, salud, sync ISAPI) y Live view (multiview, heartbeat, lifecycle C1–C21).
- Analítica de video (schema/consulta testeada; el **productor** de eventos es SIMULADO sin pipeline real).
- Hik-Connect (`HIK_CONNECT_ENABLED` OFF, sin validar contra nube real).
- Frigate como ingestor externo (`FRIGATE_ENABLED` OFF).

**PARTIAL / BLOCKED:**
- Grabaciones/playback: fallback 453 validado; reversa/frame-atrás NO viable en web (`RECORDINGS_SDK_PLAN.md`).
- Reproducción nativa (C22): shared-core TS listo y testeado; **Tauri/Rust = skeleton, NO compilado
  (`BLOCKED_SPEC`)**; relay A1 autenticado = **NO-GO** mientras MediaMTX use `user: any`.

**SIMULATED_ONLY:** ALPR/matrículas (`LicensePlateEvent` + scaffold, `ANALYTICS_ALPR_ENABLED=false`, sin OCR);
Telegram/WhatsApp (modelo `NotificationDelivery` soporta el canal, sin integración ni disparador — solo
email + WS funcionan). Detección de caídas = `PLANNED` (scaffold, sin modelo).

**NOT_PRESENT:** control de acceso físico, multiempresa/multi-tenant, asistencia, importación MDB,
gateway de controladoras, apertura remota, tarjetas/PIN, i18n (UI hardcodeada en español, sin `i18next`).

**Sin UI falsa:** `IntegrationsPage.tsx` está cableada real a `onvifApi`/`hikConnectApi` y deshabilita
botones honestamente cuando la flag del backend está OFF (no hay features "próximamente" muertas).

**Hardware:** ver `docs/HARDWARE_STATUS.md`. Resumen: NVR Hikvision vía ISAPI/RTSP = integración de
**software real pero SIN validación con equipo** en este entorno; ONVIF/Hik-Connect/Frigate = flags OFF,
sin validar contra hardware/cuenta; cliente Tauri = `BLOCKED_SPEC`.

---

## 5. Línea base y control de versiones

- Rama principal: `main` = **`0f9d1f54c525f3959e75730689f943f4602ff921`** (tip: "Merge pull request #168").
- **PRs abiertos:** solo **#169** (documentación automática). No hay otros PRs de código abiertos.
- **Trabajo pendiente SIN fusionar y SIN PR** — rama `claude/multi-agent-project-audit-hf14wq`, 3 commits
  por delante de `main`, estado = *"pendiente en rama, sin PR"* (NO forma parte de `main`):
  - `b2a3f88` feat(ws): cerrar conexiones WebSocket al revocar permisos.
  - `2e11493` chore(compose): healthcheck de MediaMTX con variante `-ffmpeg`.
  - `0df8886` docs: cerrar 2 pendientes menores.
- Existen ~decenas de ramas históricas `claude/a1-*` y `claude/fix-*` (trabajo ya fusionado o superado).
- Dependencias entre PRs: ninguna pendiente relevante; #169 es documental y no bloquea código.

---

## 6. Riesgos de seguridad (top; detalle en `docs/SECURITY.md`)

Postura de aplicación **sólida** (0 vulns en `apps/api`; CORS/CSP endurecidos; AES-256-GCM para NVR;
MFA; rate-limit Redis; refresh con detección de reúso). Riesgos residuales vigentes:
1. **P1 — RBAC de live view depende de la frontera de red.** MediaMTX acepta `user: any`; HLS/WebRTC no
   revalida JWT y el `streamPath` es determinista. Quien alcance `/hls/` reconstruye cualquier cámara.
2. **P1 — Vulns HIGH en `apps/web`** (axios prototype-pollution/DoS/bypass; form-data CRLF). CI no las bloquea.
3. **P1 — SSRF en ISAPI Hikvision** (`services/hikvision.ts`): destino elegible por ADMIN sin allowlist.
4. **P1/P3 — `userCanAccessNvr` laxo** (`routes/nvr.ts:267`): no exige `canView`.
5. **P2 — JWT en `localStorage`** (exfiltrable por XSS); **token WS en la URL**.

---

## 7. Estado DevOps (top; detalle en `docs/DEPLOYMENT.md` y `docs/BACKUP_RESTORE.md`)

Maduro: secretos con fail-fast, MediaMTX atado a loopback, apagado elegante, imágenes pinneadas,
healthchecks, rate-limit multi-worker-safe. Huecos reales:
- **Sin backup programado/offsite; RPO/RTO indefinidos.** Único backup = manual pre-deploy en `scripts/deploy.sh`.
- `deploy.sh` **raíz** (distinto de `scripts/deploy.sh`) silencia fallos de migración (`migrate deploy 2>/dev/null || true`).
- CI no aplica migraciones contra DB real, no corre lint/SAST/`npm audit` gate; `migration_lock.toml` ausente.
- Builds no reproducibles (`npm install` en vez de `npm ci`); modelo de analytics se descarga de GitHub en runtime.

---

## 8. Instalación (comandos reales)

```bash
git clone <repo> /opt/visioncore && cd /opt/visioncore
cp .env.example .env            # completar variables (ver §10)
bash setup.sh                   # genera secretos por reemplazo de línea + verificación
docker compose build --no-cache api web
docker compose up -d
docker compose exec -T api npx prisma migrate deploy
docker compose exec -T api npx tsx apps/api/src/seed.ts   # crea admin (SEED_ADMIN_PASSWORD o aleatorio)
```
Validación de composición sin arrancar: `docker compose config -q`. HTTPS: `infra/certbot/init-ssl.sh` +
`upgrade-to-https.sh`. Detalle en `docs/DEPLOYMENT.md`.

---

## 9. Pruebas (comandos reales)

- **apps/api:** `npm run build` (tsc) + `npm test` (vitest). CI job `api`.
- **apps/web:** `npm run build` (tsc && vite build) + `npm test` (vitest). CI job `web`.
- **apps/analytics:** `python -m compileall -q app` + `python -m unittest discover -s tests -v`
  (stdlib, sin cv2/onnx). CI job `analytics`.
- **Mutaciones:** `node tools/mutation-run.mjs` (19 mutantes conocidos, 19/19).
- CI (`.github/workflows/ci.yml`, 6 jobs): `api`, `web`, `analytics`, `compose`, `analytics-image`, `licenses`.
- CI NO corre: lint/ESLint, `prisma migrate deploy` contra Postgres real, e2e de navegador, gate de `npm audit`.
Detalle en `docs/TEST_EVIDENCE.md`.

---

## 10. Variables de entorno (SIN valores; de `.env.example`)

**Obligatorias en producción:** `POSTGRES_PASSWORD`, `JWT_SECRET` (fail-fast si <32 chars),
`NVR_CREDENTIAL_KEY` (obligatoria en prod; si cambia, las contraseñas NVR quedan ilegibles),
`SEED_ADMIN_PASSWORD` (si no, se genera aleatoria fuerte), `CORS_ORIGINS` (sin ella solo se permite localhost).
**Otras relevantes:** `REDIS_URL`, `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `COOKIE_SECURE`,
`ANALYTICS_SECRET`, `METRICS_TOKEN`; flags OFF por defecto: `ONVIF_ENABLED`, `HIK_CONNECT_ENABLED`,
`FRIGATE_ENABLED`, `NATIVE_PLAYBACK_ENABLED`, `NATIVE_MEDIA_RELAY_ENABLED`, `ANALYTICS_ALPR_ENABLED`,
`ANALYTICS_FALL_DETECTION_ENABLED`, `AI_EVENTS_ENABLED`; retenciones (`*_RETENTION_DAYS`) y numerosos
`RECORDINGS_*` / `CAMERA_STREAM_*` de tuning. Lista completa de claves en `.env.example`. **Nunca versionar valores.**

---

## 11. Migraciones y decisiones arquitectónicas

- **34 directorios** en `prisma/migrations/` (`0001_init` … `0032_nvr_playback_capacity`).
  **Números duplicados: `0009_*` (x2) y `0031_*` (x2)**; falta `migration_lock.toml`
  (ver `prisma/migrations/README.md`). Migraciones **solo-hacia-adelante** (sin `down`); rollback de
  schema es manual (psql). `migrate deploy` corre en el arranque del contenedor.
- **ADR-0001** (`docs/native/ADR-0001-native-live-playback.md`): reproducción nativa en vivo.
- **C22**: plano de medios/grants (histórico consolidado en `docs/DEVELOPMENT_HISTORY.md`).
- **A1 relay autenticado = NO-GO** mientras MediaMTX use `user: any` (`docs/native/A1_RELAY_DESIGN.md`).

---

## 12. Backlog priorizado y primera tarea

**P0:** ninguno abierto y directo hoy (secretos con fail-fast; sin migración destructiva pendiente).
**P1:** (a) bump de deps HIGH en `apps/web`; (b) allowlist anti-SSRF en `services/hikvision.ts`;
(c) endurecer `userCanAccessNvr` para exigir `canView` (`routes/nvr.ts:267`); (d) backup/restore probado
+ quitar el silenciado de migración en `deploy.sh` raíz.
**P2:** JWT localStorage→cookie httpOnly (decisión); token WS fuera de URL; CI lint + audit gate + migrate real
contra Postgres + `npm ci`; `migration_lock.toml`; renumerar migraciones duplicadas; checksum del modelo analytics.
**P3:** limpiar `JWT_REFRESH_SECRET` (declarado, no usado); revocación WS cross-worker (Redis pub/sub);
observabilidad (dashboards/alerting versionados); consolidar documentación duplicada.

**Primera tarea recomendada:** P1-a (bump de deps web HIGH) — es segura, reproducible y sin decisión de
diseño; validar con `apps/web` build + tests. En paralelo (archivos distintos) P1-b/P1-c en backend.
**Cada P1 en su propia rama, PR Draft, sin fusionar.**

---

## 13. Invariantes de negocio (NO romper)

1. Nunca fabricar, perder ni declarar inválida una grabación sin evidencia verificable.
2. Mantener RBAC: un usuario solo ve cámaras, grabaciones y PTZ permitidos.
3. Un stream se libera únicamente cuando ya no tiene espectadores/sesiones vivos; no depender solo de temporizadores.
4. Cambios de viewport deben invalidar timers, colas, solicitudes y respuestas obsoletas.
5. Mantener explícito el ciclo de vida de FFmpeg/MediaMTX y los intentos terminales de cierre.
6. Nunca registrar ni versionar IPs internas reales, usuarios, contraseñas de NVR, JWT, cookies, claves ni videos.
7. No usar `make clean`, borrar volúmenes, reiniciar servicios, migrar, desplegar, fusionar o hacer
   force-push sin autorización expresa.

---

## 14. Método de trabajo obligatorio

1. Confirmar `git status --short`, `git log -1` y PRs abiertos antes de concluir el estado.
2. Leer la documentación del subsistema afectado y proponer un plan pequeño con riesgos.
3. Preferir verificaciones de solo lectura y pruebas reproducibles; declarar lo que no se ejecutó.
4. Para streaming, comprobar simultáneamente UI, API, MediaMTX y navegador; una descarga exitosa NO prueba
   que el reproductor HTML5 sea correcto.
5. Antes de una modificación operativa, pedir autorización explícita y preparar rollback comprobable.
6. `make status` solo para consulta; cualquier `up`, `restart`, `migrate` o `down` requiere aprobación si
   apunta a un entorno no local.

## 15. Qué debe responder Claude al comenzar una tarea

Primero resumir: objetivo, archivos/servicios implicados, invariantes afectados, evidencia disponible,
riesgo y siguiente paso de solo lectura. No asumir que el estado de `main` equivale al estado del servidor.
