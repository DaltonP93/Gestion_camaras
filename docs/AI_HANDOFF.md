# Handoff operativo para IA — VisionCore (ENTRADA CANÓNICA)

> Actualizado: 2026-10-08 (estado vigente en la sección «Estado vigente» de abajo). Las secciones
> §0–§15 conservan la reconstrucción del ciclo C23 (2026-09-06) como **histórico**: donde contradigan
> la sección vigente, manda la sección vigente.
> Alcance: contexto del código versionado. NO describe ni autoriza cambios en producción.
> **Criterio de aceptación de este documento:** otro agente (p. ej. Codex) debe poder
> continuar el trabajo SOLO con la URL del repositorio + este archivo.

---

## Estado vigente (2026-10-09) — leer primero

**Línea base.** `main` = `94305f32ddba17b697b8f28b5fe3ef5108b0bc2c` (merge #179). Desde `0f9d1f5` se
fusionaron, entre otros: #170–#175 (docs C23, SSRF + RBAC centralizado, deps web, plano de grants,
ops/backup, e2e de pantalla completa), canales Slack/Teams/webhook, WebSocket por ticket, JWT en
cookies HttpOnly + CSRF, **auth del HLS por espectador en el borde** (nginx `auth_request`), gate de
ESLint, `migration_lock.toml`, revocación WS cross-worker, #176 (linaje de certificado `camaras-le`),
#177 (X-Original-URI del request padre), #178 (validación de credenciales legacy) y #179
(continuidad de grabaciones). Se verificó por inspección de sólo lectura (2026-09-23) que producción
corría `94305f3`; **re-verificar antes de concluir nada sobre el servidor**.

**Alcance definitivo de la integración (2026-10-08):** adaptar la **interfaz y organización de
configuración de Frigate** dentro de VisionCore con **todas** sus funciones (administración,
seguridad, NVR) además de eventos y detección; no limitar la configuración nueva a detección. Se
mantienen login, roles, NVR y visores de VisionCore; archivo completo sólo en NVR; almacenamiento local
sólo para eventos configurados. Ver `docs/frigate/NATIVE_INTEGRATION_PROPOSAL.md` (rev. 3) y
`docs/frigate/SCREEN_FUNCTION_MATRIX.md`.

**PR abiertos (todos Draft; ninguno fusionado; ninguno desplegado). Base apilada: #182.**

| PR | Rama | Head | Base | Contenido | Estado |
|---|---|---|---|---|---|
| #182 | `fix/api-audit-oct2026` | `546dc63` | `main` | fastify 5.12.5, nodemailer 10, pruebas SMTP loopback incl. AUTH; fast-jwt 6.3.4 (avisos críticos/altos de ≤6.3.3) | CI 11/11 |
| #186 | `fix/recordings-playbackuri-channel-scope` | `45ebda5` | #182 | **Seguridad**: `playbackURI` ligada al canal (playback, preview, diagnóstico); tabla de reglas `Map` (sin propiedades heredadas: `constructor`/`__proto__` ⇒ 400, antes 500) | CI 11/11; API 1686/1686 |
| #189 | `fix/live-heartbeat-rbac` | `a65c7db` | #182 | **Seguridad P0**: RBAC por cámara en `POST /api/live-view/heartbeat` (iniciaba streams de cámaras ajenas); la revocación cierra sub, main y main_h264 (FFmpeg incluido) | Reproducido con prueba; revisión adversarial aplicada |
| #190 | `fix/auth-access-token-only` | `abd2734` | #182 | **Seguridad crítica**: sólo access tokens como credencial (2fa/enroll/step-up sin rol abrían grabaciones de todas las cámaras; refresh servía 7 días) | CI 11/11; reproducido con prueba |
| #191 | `fix/nvr-audio-block-only` | `9169828` | #182 | **NVR**: el audio se escribe/lee sólo dentro de `<Audio>` (antes apagar el audio deshabilitaba el canal); UI con "Sin cambios/Habilitar/Deshabilitar" | CI 11/11 |
| #192 | `fix/branding-upload-xss` | `854f73f` | #182 | **Seguridad**: XSS almacenado de branding **reproducido** en Chromium aislado (`.js` + `.html` del mismo origen saltean la CSP); firma mágica, extensión del tipo detectado, `/uploads/` acotado con CSP `sandbox`, nginx re-declara cabeceras, guard de CI; no borra un archivo que otro campo sigue usando | CI 11/11 |
| #193 | `fix/profile-diagnostics-minimal` | `62d70e0` | #182 | **Seguridad**: `/auth/me` con allowlist y migración del store del navegador (borra credenciales del NVR guardadas); diagnósticos sin usuario/IP del NVR y sólo ADMIN/SUPERVISOR; usuario del NVR sólo a ADMIN; `lastRtspError` redactado | CI 11/11 |
| #195 | `fix/rate-limit-trust-proxy` | `f8c8f33` | #182 | **Seguridad alta (disponibilidad)**: rate limiting por cliente detrás de nginx (`trustProxy` sólo del salto inmediato y sólo si el par está en `TRUSTED_PROXIES`); puertas internas (`hls-auth`, MediaMTX, `media-grant/validate`) por el socket ⇒ **el HLS no se corta** (probado detrás de un proxy que replica nginx); bloqueo por usuario del 2.º factor | CI 11/11; API 1576/1576 |
| #196 | `fix/jwt-known-secrets` | `95d9bef` | #182 | **Seguridad alta**: el API no arranca con un `JWT_SECRET` público conocido (por hash; mensaje sin el valor); compose sin default (`${JWT_SECRET:?}`); `scripts/check-public-secrets.sh` previo al deploy; barrido del historial completo sin valores aceptados. **No hay evidencia de que producción use una clave pública** | CI 11/11; API 1564/1564 |
| #197 | `fix/effective-revocation` | `8c161e9` | #182 | **Seguridad alta**: actor vigente en cada `jwtVerify` (claim `sid`, usuario activo, sesión viva, rol de la base); `file.mp4`, descarga y preview ligados a usuario+sesión+cámara y revalidados; preview adjunto cortado ≤5 s; WS por sesión. Conflicto de una línea con #190 en `trusted` | CI 11/11; API 1571/1571 |
| #194 | `review/security-joint-oct2026` | `e748150` | #182 | **Revisión conjunta extendida** (#182, #186–#193, #195–#197): suite e2e con `server.ts` real; 116 pruebas conjuntas; mutaciones detectadas; defectos opt-in 24 → 13; informe `docs/security/JOINT_REVIEW_182_186_189_190.md`. **No se fusiona** (evidencia) | ver PR |
| #198 | `test/security-joint-suite` | `68bd1c0` | `review/security-joint-base` | **Pruebas permanentes** de #194 sin el informe (sólo `apps/api/src/security-joint/`); base temporal = integración; re-apuntar a #182 cuando se fusionen los PRs | ver PR |
| #199 | `test/playback-real-video` | `8e79d82` | #182 | **Pruebas de reproductor con video real** generado localmente (NVR simulado en loopback: shim de ffmpeg + ISAPI simulado; web real + `server.ts` real + FFmpeg real): continuidad, seek, ±10 s, velocidades, grilla con cámaras bloqueada/cortada/404, liberación, exportación, revocación. 74 invariantes (trinquetes y aislamiento de red del navegador) y 28 defectos medidos opt-in. **No reemplaza las mediciones autorizadas con NVR** | ver PR |
| #187 | `feat/staging-isolation` | `036171f` | #182 | `STAGING_ISOLATION` y flags; ausente = actual, presente vacía/con espacios ⇒ aborta; prueba de arranque real de `server.ts` | CI 11/11; API 1563/1563 |
| #184 | `refactor/nvr-recording-provider-standalone` | `f32cd75` | #182 | Proveedor NVR de grabaciones (web) sin la continuidad de #181 | CI 11/11 |
| #188 | `feat/frigate-ux-prototype` | (ver PR) | #182 | Prototipo navegable con datos simulados (vivo, visores, grabaciones multicámara, eventos, configuración completa, **editor de zonas de Frigate en React 18**). Ajustes del dueño (2026-10-08): selector plegado en tablet vertical y video 16:9; timeline con horas, zoom y huecos; reloj común sin detener a las demás cámaras, con resincronización por celda; marcas de simulado/existente por control; aviso de que **no** demuestra la eliminación de pausas | ver PR |
| #185 | `docs/frigate-native-plan` | (ver PR) | #182 | Propuesta rev. 3, matriz de pantallas/funciones, plan de pruebas rev. 2, runbook, **política única de permisos** (`docs/security/PERMISSIONS_POLICY.md`), este traspaso | Sólo docs; base #182 para que CI (sobre el merge) no herede el `npm audit` rojo de `main` |
| #183 | `refactor/nvr-recording-provider` | `ff6f3ff` | #181 | Proveedor apilado sobre #181 | Conservado; reemplazado por #184 |
| #181 | `feat/nvr-playback-probe` | `3fce40f` | #182 (`7b9ef37`) | Relevo seguro y continuidad por video real | **Pospuesto** (no fusionar ni cerrar) |
| #180 | `fix/live-1x1-high-quality` | `cd251c7` | `main` viejo | Vivo 1×1 en alta calidad automática | **Pospuesto** |

Orden sugerido de revisión: #182 → #190 → #189 → #186 (sin restricción de orden entre ellos; #190 cierra
un salto del 2.º factor que ya existe en `main`) → #196 → #197 (resolver `trusted` con #190 y adaptar los
fixtures como `19e505e` de `review/security-joint-base`) → #195 → #193 → #192 → #191 → #187 → #198 →
#199 → #184 → #188 → #185. Todo revisado junto en #194. Cada uno se re-valida tras fusionar el anterior.

**Seguridad — hallazgos vigentes en `main`** (lista completa, priorizada y con evidencia en
`docs/frigate/SCREEN_FUNCTION_MATRIX.md`, sección de hallazgos):
1. Tokens intermedios y refresh aceptados como credencial → **#190** (reproducido).
2. Heartbeat del vivo sin RBAC → **#189** (reproducido).
3. Acceso cruzado por `playbackURI` → **#186**.
4. `/auth/me` y diagnósticos con credenciales/IP del NVR → **#193**; XSS de branding → **#192**;
   audio que deshabilitaba el canal → **#191**.
5. Prioridad **alta** por impacto (que sean previos no lo reduce): rate-limit detrás de nginx → **#195**;
   `JWT_SECRET` público → **#196**; access y medios de grabación que sobreviven a una revocación →
   **#197**. Sin PR (verificados en #194, informe §4): `canDownload` no aplicado (D5); TOTP/tempToken
   reutilizables (MFA-04); grants del relay nativo (flags NO-GO); **LOG-01** (usuario e IP del NVR en
   logs al arrancar un stream: invariante 6); **STG-01** (decisión pendiente: staging contacta al NVR
   por acciones de usuario); **AUD-BK-01** (restaurar el backup no re-enciende el audio); residuo
   `name`/`size` de #186 (incierto: requiere NVR real autorizado).
6. MediaMTX `authInternalUsers: user: any` → etapa **E0.5**.

**Decisiones técnicas tomadas:** editor de zonas con **React 18 + react-konva 18.2.16 + konva 10.2.3**
(prueba de compatibilidad con controles negativos y mutantes; propuesta §2.4). Grabaciones en grilla:
**no se asume subflujo grabado**; pista archivada por instante, huecos, carga y límites visibles
(plan de pruebas §1.1).

**Producción observada (2026-09-23, sólo lectura):** stack de 8 servicios sano; analítica habilitada
con **0 cámaras activas y 0 eventos**; 144 cámaras / 4 NVR; 36/36 migraciones; VM de 4 vCPU sin GPU ni
acelerador. No verificados: errores de logs 24 h, `visioncore-backup.timer`, vencimiento del certificado.

**Política única de permisos** (`docs/security/PERMISSIONS_POLICY.md`, propuesta en #185): rol = techo,
filas = alcance, herencia NVR→cámara única (R-H), reproducir ≠ exportar, visores personales para todos
dentro de sus cámaras (indicado por el dueño), tabla de conformidad de 187 rutas y prueba de contrato.
**Decisiones del dueño pendientes: D1–D12** (SUPERVISOR global o acotado, techos de OPERATOR/AUDITOR,
exportación, compatibilidad `main_h264`, visores, alertas sin cámara, revocación del access, step-up…).
Resueltas por el dueño: visores personales para todos dentro de sus cámaras; reloj común sin detener a
las demás cámaras, con resincronización por celda.

**Pendientes:** D1–D12 de la política; decidir STG-01; confirmar con NVR reales (mediciones M, con autorización) los defectos del reproductor que #199 mide con NVR simulado (primer GOP perdido, pausa de ~5 s y ~3,9 s perdidos por borde, ±10 s roto, video salteado a 4×, celda cortada liberada a los 60 s, FFmpeg cerrado por SIGKILL); PR para LOG-01 y el resto del punto 5; antes de desplegar #195–#197 (con autorización): subred de `visioncore_net` en sólo lectura, `scripts/check-public-secrets.sh` en el servidor y el 401 único de los access previos; dependencias sólo de desarrollo con
avisos (`vitest`, `source-map-js`) y `react-router` 6 (moderado, prod); confirmar con NVR reales la
gramática de `playbackURI` (#186) y el inventario de pistas archivadas (M9); `.gitignore` de `main`
contiene marcadores de conflicto sin resolver (`<<<<<<<`/`>>>>>>>`, líneas 14–18).

**Prohibido sin autorización expresa:** merge, Ready, deploy, migración, activar Frigate o flags en
producción, borrar ramas, force-push.

---

## 0. Empezá por aquí (para el próximo agente)

1. `git status --short` (debe estar limpio) y `git log -1` para confirmar el HEAD.
2. Confirmar la línea base con la sección «Estado vigente» (arriba). *Histórico C23 (2026-09-06):
   `main` era `0f9d1f5` y el trabajo C23 estaba en PRs Draft; desde entonces se fusionó (ver arriba).*
   No confundir "existe un PR" con "está en main".
3. Leer, en este orden: esta sección, §1 (propósito), §4 (estado real por capa),
   `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/SECURITY.md`,
   `docs/DEPLOYMENT.md`.
4. **No asumir que `main` == estado del servidor.** No hay despliegue verificado desde este entorno.
5. Primera tarea recomendada: ver §12. No fusionar, no desplegar, no migrar sin autorización expresa.

- `apps/api`: Node.js, Fastify, TypeScript y Prisma.
- `apps/web`: React 18, Vite, TypeScript, Tailwind y Zustand.
- `apps/analytics`: ingesta y normalización de eventos; incluye integración opt-in con Frigate.
- `apps/native`: núcleo compartido y skeleton Tauri/Rust para el cliente nativo; no equivale a binarios validados.
- PostgreSQL y Redis para datos/estado; MediaMTX para RTSP → HLS/WebRTC; Nginx como proxy.
- Las integraciones ONVIF, Hik-Connect, Frigate, IA y el relay nativo están protegidas por flags que permanecen **OFF por defecto**.
- `prisma/`, `infra/`, `scripts/` y `docker-compose.yml` describen la operación.
- Fuentes de contexto: `docs/PROJECT_DOCUMENTATION.md`, `docs/audits/ROBUSTNESS_CYCLE2.md`, `docs/native/C22_DELIVERY.md`, `docs/native/C22_2_CORRECTIVE.md`, `docs/native/TRACK3_VALIDATION.md`, `docs/audits/LEADERSHIP_SYNTHESIS.md`, `docs/frigate/DEPLOYMENT.md`, `STREAMING.md`, `SECURITY.md` y `DEPLOY.md`.
- `docs/audits/ROBUSTNESS_CYCLE2.md` es anterior a las correcciones del Ciclo 2. Contrastar sus hallazgos con el código y la sección vigente de `docs/PROJECT_DOCUMENTATION.md`.
**Vocabulario de estados usado en todos los docs canónicos:**
`MERGED_VERIFIED` (en main + cubierto por tests/lógica pura testeada),
`MERGED_UNVERIFIED` (en main, cableado, sin cobertura suficiente o sin ejercicio contra hardware real),
`OPEN_PR_DRAFT` (existe en un PR Draft OFF de `main`, NO fusionado), `PARTIAL`, `SIMULATED_ONLY`,
`BLOCKED_HARDWARE`, `BLOCKED_SPEC`, `PLANNED`, `NOT_VALIDATED` (código presente y con tests, pero
NO ejercido contra el servicio/hardware real que lo haría fiable — p. ej. atomicidad Postgres sin PG real),
`NOT_PRESENT` (no existe en el repo, con evidencia de ausencia), `SUPERSEDED`, `REJECTED`.
Nunca se declara "completo" sin archivo + evidencia. **Distinguir siempre:** *merged* (en `main`) ≠
*OPEN_PR_DRAFT* (en un PR sin fusionar) ≠ *simulado* (mock/in-memory) ≠ *NOT_VALIDATED* (real no ejercido)
≠ *PLANNED* (aún no ejecutado).

---

- Rama principal: `main`.
- HEAD observado: `0f9d1f54c525f3959e75730689f943f4602ff921`.
- PR [#162](https://github.com/DaltonP93/Gestion_camaras/pull/162), fusionado el 2026-09-04: importó C22 (188 archivos, 30 commits), incluidos grants/revocación, Frigate opt-in, ONVIF/Hik-Connect, IA/analytics, núcleo nativo y trabajo preparatorio de A1.
- PR [#164](https://github.com/DaltonP93/Gestion_camaras/pull/164), fusionado el 2026-09-04: primer lote del Ciclo 2, con hardening de logs, arranque, sesiones, métricas, Redis, Frigate, CORS, imágenes y despliegue.
- PR [#166](https://github.com/DaltonP93/Gestion_camaras/pull/166), fusionado el 2026-09-04: seed demo opt-in, rate-limit Redis, pruebas IDOR, CSP estricta y alcance de alertas por `canView`.
- PR [#168](https://github.com/DaltonP93/Gestion_camaras/pull/168), fusionado el 2026-09-06: alcance de Analítica por permiso de cámara (3 archivos, 2 commits, 281 adiciones y 5 eliminaciones).
- El PR #168 restringe `GET /analytics/events`, todas las agregaciones de `GET /analytics/summary` y `GET /analytics/live-frame/:cameraId` según `canView`. ADMIN conserva acceso global; SUPERVISOR/AUDITOR solo ven datos de cámaras autorizadas en los endpoints que su rol ya puede usar.
- Cambios observables aprobados: los usuarios no administradores dejan de ver analítica de cámaras sin permiso. `/config*` y `/internal/*` no cambiaron.
- Estos merges no prueban ni autorizan despliegue, migración, reinicio o activación de flags.

## Validación y checks observados

- GitHub Actions, ejecución [CI #202](https://github.com/DaltonP93/Gestion_camaras/actions/runs/34009962149) sobre el head del PR #168 `a7abaea`: **success**.
- Jobs verdes: Web (typecheck, tests y build), Licencias (sin GPL/AGPL), API (Prisma, typecheck y tests), Analytics (syntax y tests), imagen de Analytics (smoke test de dependencias nativas) y `docker compose config`.
- La descripción del PR registra además `tsc --noEmit` sin errores y 1.281 pruebas Vitest en 85 archivos, incluidos 13 casos nuevos de rutas Analytics. Tratarlo como evidencia declarada del desarrollo, no como validación de datos o producción.
- GitHub no registró reviews, comentarios de conversación ni comentarios inline en el PR #168.
- No se observaron contexts de status separados ni una ejecución asociada todavía al SHA de merge `0f9d1f5`.

## Estado GO/NO-GO

- Código C22 y Ciclo 2 en `main`: **fusionado**.
- Despliegue o cambio de producción: **NO-GO**.
- Relay autenticado A1 / `NATIVE_MEDIA_RELAY_ENABLED`: **NO-GO**.
- Frigate, ONVIF, Hik-Connect, IA y capacidades nativas: implementadas o preparadas detrás de flags, pero **NO-GO para habilitar en producción** hasta validar el entorno real y recibir autorización expresa.
- Las funciones nuevas deben seguir apagadas por defecto. No convertir un merge de código en una decisión operativa.

## Comportamiento de seguridad vigente

- Alertas: ADMIN conserva acceso global; los demás roles solo listan, cuentan, marcan, resuelven y reciben por WebSocket alertas de cámaras con `canView`. Las alertas sin `cameraId` continúan siendo globales.
- Analítica:
  - `GET /events`: no-admin solo obtiene eventos de sus cámaras; pedir una cámara ajena produce un conjunto vacío.
  - `GET /summary`: el filtro solicitado se intersecta con `canView` y todas las agregaciones quedan bajo el mismo scope.
  - `GET /live-frame/:cameraId`: sigue reservado a ADMIN/SUPERVISOR; un SUPERVISOR sin `canView` recibe 403 antes de consultar configuración o servicio.
  - `/config*` conserva su política ADMIN/SUPERVISOR y `/internal/*` continúa protegido por secreto; no fueron parte del PR #168.
- IDOR: existen pruebas de regresión para cámara, PTZ, grabaciones y rutas de Analítica. No tratarlas como auditoría exhaustiva de todos los endpoints.
- CSP: `script-src` no permite `unsafe-inline` y `script-src-attr` es `none`; estilos inline siguen permitidos de forma acotada por theming/React.
- Rate-limit: con `REDIS_URL` usa contador compartido; sin ella conserva memoria local. Si Redis falla, degrada permitiendo solicitudes para priorizar disponibilidad.
- Seed: usuarios demo solo se crean con `SEED_DEMO_USERS=true`.

## Precauciones operativas

- Definir `CORS_ORIGINS` para cualquier frontend autorizado que no sea same-origin/localhost.
- Definir `POSTGRES_PASSWORD` y custodiar `SEED_ADMIN_PASSWORD` antes de desplegar. Mantener `SEED_DEMO_USERS=false` en producción.
- Monitorizar Redis: el fail-open del rate-limit preserva disponibilidad, pero reduce protección mientras Redis no responde.
- Producción requiere una `NVR_CREDENTIAL_KEY` válida; verificar compatibilidad/migración de credenciales legacy y rollback sin registrar valores.
- Las imágenes están fijadas a versiones concretas; futuras actualizaciones deben ser deliberadas y probadas.

## Riesgos y pendientes confirmados

- Revocar permisos no cierra una conexión WebSocket ya abierta; el scope actualizado se aplica al siguiente broadcast.
- MediaMTX sigue sin healthcheck interno; cambiarlo requiere decidir estrategia/imagen.
- Validar RBAC/Analítica con usuarios y datos reales autorizados; las pruebas del PR usan entorno controlado.
- Validar CSP en navegador real y todos los flujos permitidos.
- Validar atomicidad `EVAL` con Redis real y la ruta N1 contra un MediaMTX vivo.
- Compilar/probar Tauri/Rust y el cliente nativo; no hay binarios validados por este handoff.
- Validar ONVIF y Hik-Connect con hardware/cuenta autorizados, y Frigate end-to-end con configuración real.
- Adoptar `waitForCapacity` en un llamador real y resolver la sesión activa durable para escenarios multi-worker.
- No asumir que `main` coincide con el servidor; comprobar el SHA desplegado antes de diagnosticar o proponer cambios.
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
**Ningún servicio usa digest `@sha256:`.** `node:20-alpine` (api), `python:3.11-slim` (analytics),
`nginx:alpine` (interno de la imagen de web) y varios tags de compose **flotan por patch**: NO son
reproducibles bit-a-bit aunque tengan un tag "fijo". El PR Draft **#174** agrega `npm ci` en los
Dockerfiles (reproducibilidad de las *dependencias npm*), pero **NO** fija las imágenes base por digest;
el pin por digest queda como follow-up. No describir el stack como "totalmente reproducible".
CI usa Node 22 (leve desalineación con Node 20 de las imágenes).

---

## 4. Estado real por capa (merged / rama / simulado / ausente)

Detalle completo con archivo/PR/commit/test en `docs/IMPLEMENTATION_STATUS.md`.

**MERGED en `main` (verificado por tests o lógica pura):**
- RBAC por rol + cámara (ADMIN/SUPERVISOR/OPERATOR/AUDITOR). Test: `routes/rbac-idor.route.test.ts`.
- PTZ (ISAPI `PTZCtrl/.../continuous` + vía ONVIF).
- 2FA TOTP obligatoria por política, step-up, rotación de refresh con detección de reúso, AuditLog.
- Alertas/notificaciones por WebSocket + email (`services/notification.service.ts`, `healthWorker`).
  **Contrato RBAC de alertas (inequívoco, verificado en `routes/alerts.ts`):**
  *lectura/listado* de alertas y eventos = **todos los roles autenticados, pero limitados a su scope
  `canView`** (ADMIN sin restricción; el resto solo alertas de sus cámaras + alertas sin `cameraId`);
  *resolución* (`PUT /api/alerts/:id/resolve`) = **solo ADMIN/SUPERVISOR** (`authorize(['ADMIN','SUPERVISOR'])`,
  `routes/alerts.ts:122`). Un **OPERATOR o AUDITOR NO puede resolver ni una alerta de una cámara que sí
  puede ver.** (Observación de Codex sobre #169, verificada.)
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
  **Al cierre del ciclo C23 `main` sigue en este SHA: NADA del C23 se fusionó.**

### 5.1 PRs Draft del ciclo C23 (todos OFF de `main`, SIN fusionar — `OPEN_PR_DRAFT`)

| PR | Rama | Head | Hito | Contenido (resumen) | Validación |
|---|---|---|---|---|---|
| **#171** | `fix/nvr-ssrf-authz` | `6e633df` | Hito 1 | SSRF profundo (`maxRedirects:0` en clientes ISAPI, `/scan` rechaza redes reservadas, IP-literal-only anti-rebinding, metadata de proveedor bloqueada) + RBAC centralizado (`services/access-policy.ts`, `GET /api/nvrs` con `canView`, `video-audio[/:channel]`, scoping por cámara/NVR) | vitest **1342**, mutación **19/19**; tests conductuales con servidor HTTP real + `fastify.inject` |
| **#173** | `fix/grant-plane-c23` | `ab5a48b` | Hito 2 | Tiempo atómico Redis (`redis.call('TIME')`), outbox de revocación durable (migración `0033_media_revoke_outbox`, fail-closed `REVOKE_PENDING`), readiness por path unificada (`grant-derivation.ts`) | vitest **1295**, mutación **19/19**; **Redis real validado**. Atomicidad Postgres `SKIP LOCKED` = **NOT_VALIDATED** (sin servidor PG) |
| **#174** | `fix/ops-backup-ci-c23` | `fe51727` | Hito 7 | `deploy.sh` fail-fast, backup/restore **validado real** contra Postgres efímero, guard CI de prefijos de migración, `npm ci` en Dockerfiles, job CI de `npm audit` prod, checksum sha256 del modelo YOLOX | analytics **93/93**; backup/restore ejercido contra PG efímero |
| **#172** | `fix/web-deps-high` | `e82bb28` | deps web | 5/6 vulns HIGH de `apps/web` resueltas | **1 HIGH pendiente = `vite` (solo dev-server), requiere major** → follow-up |
| **#170** | `docs/state-reconstruction` | — | Hito 8 | Docs canónicos (ESTE PR). No abrir PR nuevo | — |
| **#169** | `docs/update-ai-handoff-pr-168` | — | — | Handoff auto-generado (2 observaciones de Codex). **SUPERSEDED por #170** — su contenido válido está incorporado aquí; cerrar solo con autorización del propietario (§12.1) | — |

- **Hitos aún NO ejecutados en C23 (`PLANNED`, pendientes de decisión de foco):** Hito 3 (relay A1
  real), Hito 4 (cliente nativo Tauri), Hito 5 (E2E web), Hito 6 (IA productiva). No existe código de
  estos en ningún PR C23; no describirlos como en progreso.

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
MFA; rate-limit Redis; refresh con detección de reúso). Riesgos residuales vigentes (estado **de `main`**;
los "aborda" refieren a PRs Draft NO fusionados — el riesgo sigue vigente en `main`):
1. **P1 — RBAC de live view depende de la frontera de red.** MediaMTX acepta `user: any`; HLS/WebRTC no
   revalida JWT y el `streamPath` es determinista. Quien alcance `/hls/` reconstruye cualquier cámara.
   *No hay fix en C23; sigue siendo blocker P0 para habilitar lo nativo (§12).*
2. **P1 — Vulns HIGH en `apps/web`** (axios prototype-pollution/DoS/bypass; form-data CRLF). CI no las bloquea.
   *#172 (Draft) resuelve 5/6; queda 1 HIGH = `vite` (solo dev-server, requiere major) como follow-up.*
3. **P1 — SSRF en ISAPI Hikvision** (`services/hikvision.ts`): destino elegible por ADMIN sin allowlist.
   *#171 (Draft) lo aborda a fondo (`maxRedirects:0`, rechazo de redes reservadas, anti-rebinding). No en `main`.*
4. **P1/P3 — `userCanAccessNvr` laxo** (`routes/nvr.ts:267`): no exige `canView`.
   *#171 (Draft) centraliza RBAC en `services/access-policy.ts` con `canView`. No en `main`.*
5. **P2 — JWT en `localStorage`** (exfiltrable por XSS); **token WS en la URL**.

---

## 7. Estado DevOps (top; detalle en `docs/DEPLOYMENT.md` y `docs/BACKUP_RESTORE.md`)

Maduro: secretos con fail-fast, MediaMTX atado a loopback, apagado elegante, imágenes fijadas **por tag**
(NO por digest), healthchecks, rate-limit multi-worker-safe. Huecos reales (estado de `main`):
- **Imágenes fijadas por tag pero NO por digest** (`node:20-alpine`, `python:3.11-slim`, `nginx:alpine`
  interno de web y tags de compose **flotan por patch**): no es reproducibilidad total. Pin por digest = follow-up.
- **Sin backup programado/offsite; RPO/RTO indefinidos.** Único backup = manual pre-deploy en `scripts/deploy.sh`.
  *#174 (Draft) valida backup/restore real contra Postgres efímero y agrega `deploy.sh` fail-fast; NO en `main`.*
- `deploy.sh` **raíz** (distinto de `scripts/deploy.sh`) silencia fallos de migración (`migrate deploy 2>/dev/null || true`).
- CI no aplica migraciones contra DB real, no corre lint/SAST/`npm audit` gate; `migration_lock.toml` ausente.
  *#174 (Draft) agrega guard CI de prefijos de migración + job de `npm audit` prod; NO en `main`.*
- Builds de deps npm no reproducibles (`npm install`); modelo de analytics se descarga de GitHub en runtime.
  *#174 (Draft) migra a `npm ci` y agrega checksum sha256 del modelo YOLOX; NO en `main`.*

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

### 12.0 Estado P0 — distinción explícita (reemplaza el viejo "P0: ninguno")

Decir "P0 ninguno" era engañoso. La lectura correcta se separa en 4 categorías:

**(a) Seguro HOY** — porque las flags nativas están OFF y el plano de medios es **inerte**:
`NATIVE_PLAYBACK_ENABLED` / `NATIVE_MEDIA_RELAY_ENABLED` OFF en `main`. Mientras estén OFF, los grants de
medios, el relay y el cliente nativo no procesan tráfico: no hay P0 explotable por esa vía en la config por defecto.

**(b) Blocker P0 para HABILITAR lo nativo** — NO encender las flags nativas sin resolver, todos, estos:
1. **Relay A1 real NO implementado** (Hito 3 = `PLANNED`; no hay relay autenticado funcional en ningún PR C23).
2. **MediaMTX `user: any`** — sin auth por path, el aislamiento del live/relay depende solo de la frontera de red.
3. **Atomicidad Postgres del outbox de revocación = `NOT_VALIDATED`** — el `SKIP LOCKED` del outbox de #173
   (Draft) NO se ejerció contra un Postgres real (no había servidor PG); su fail-closed depende de esa atomicidad.

**(c) Probado con mocks / in-memory** (correcto para lógica, insuficiente como prueba de producción):
outbox de revocación en implementación **InMemory**; ejecución de scripts Lua vía **wasmoon** (no un Redis con
Lua nativo); suites de rutas con dependencias mockeadas. Sirve para regresión de lógica, no valida el runtime real.

**(d) Probado contra REAL** (evidencia fuerte):
- **Redis real** (en #173, Draft): grants, revocación y readiness por path.
- **Postgres efímero** (en #174, Draft): backup/restore end-to-end.
- **Navegador / toolchain** (E2E web, build de imágenes, arranque del stack): **aún NO** ejercido.

### 12.1 #169 SUPERSEDED por #170

El PR **#169** (`docs/update-ai-handoff-pr-168`, handoff auto-generado) queda **`SUPERSEDED` por #170**
(este PR de docs canónicos): sus 2 observaciones válidas de Codex (RBAC de resolución de alertas =
solo ADMIN/SUPERVISOR — §4; imágenes que "flotan" y NO están pinneadas por digest — §3/§7) ya están
incorporadas aquí. **No cerrar #169 automáticamente: requiere autorización expresa del propietario.**

### 12.2 Backlog por prioridad

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
2. Mantener RBAC: un usuario solo ve cámaras, grabaciones, alertas, analítica y PTZ permitidos.
3. Un stream se libera únicamente cuando ya no tiene espectadores/sesiones vivos; no depender solo de temporizadores.
4. Cambios de viewport deben invalidar timers, colas, solicitudes y respuestas obsoletas.
5. Mantener explícito el ciclo de vida de FFmpeg/MediaMTX y los intentos terminales de cierre.
6. Nunca registrar ni versionar IPs internas reales, usuarios, contraseñas de NVR, JWT, cookies, claves ni videos.
7. No usar `make clean`, borrar volúmenes, reiniciar servicios, migrar, desplegar, fusionar o hacer
   force-push sin autorización expresa.

---

## 14. Método de trabajo obligatorio

1. Confirmar `git status --short`, `git log -1`, SHA desplegado y PRs abiertos antes de concluir el estado.
2. Leer documentación y código; diferenciar informes pre-corrección de la línea base actual.
3. Preferir verificaciones de solo lectura y pruebas reproducibles; declarar claramente lo no ejecutado.
4. Para streaming, comprobar simultáneamente UI, API, MediaMTX y navegador.
5. Antes de una modificación operativa, pedir autorización explícita y preparar rollback comprobable.
6. No habilitar flags, crear usuarios demo, usar credenciales reales ni conectar hardware/cuentas externas sin aprobación.

## Validación mínima

- Ejecutar los typechecks/tests reales del área afectada y `docker compose config` cuando cambie la composición.
- Para RBAC, comprobar usuario ADMIN y no-admin con cámara permitida, ajena, sin permisos y filtros vacíos.
- Para Analítica, verificar `events`, `summary` y `live-frame`; confirmar que conteos/agregaciones usan exactamente el mismo scope.
- Para alertas, comprobar listado, conteos, mutaciones y WebSocket con cámara permitida, ajena y alerta sin `cameraId`.
- Para CSP, probar build y navegador; revisar consola, theming y flujos dinámicos.
- Para CORS/deploy/seed, validar allowlist, variables requeridas, ausencia de usuarios demo y rollback en un entorno no productivo.
- Para integraciones, validar primero con flags OFF y mocks; separar esas pruebas de la validación real autorizada.
- Usar `make status` solo para consulta; cualquier `up`, `restart`, `migrate` o `down` requiere aprobación si apunta a un entorno no local.

## Qué debe responder Claude al comenzar una tarea

Primero resumir: objetivo, HEAD de `main`, estado desplegado si está comprobado, archivos/servicios implicados, flags, invariantes, evidencia disponible, riesgos y siguiente paso de solo lectura. Debe distinguir entre código fusionado, pruebas observadas y comportamiento realmente validado en producción.
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
