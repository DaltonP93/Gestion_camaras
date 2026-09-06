# Handoff operativo para IA — VisionCore

> Actualizado: 2026-09-06. Alcance: contexto del código versionado en `main`; no describe el estado del servidor ni autoriza cambios en producción.

## Propósito

VisionCore es un sistema VMS web para administrar NVR Hikvision: vista en vivo, grabaciones, cámaras, usuarios, roles, control de acceso y PTZ. Debe proteger la continuidad de visualización y la evidencia de grabaciones; no es solo un dashboard de video.

## Arquitectura confirmada

- `apps/api`: Node.js, Fastify, TypeScript y Prisma.
- `apps/web`: React 18, Vite, TypeScript, Tailwind y Zustand.
- `apps/analytics`: ingesta y normalización de eventos; incluye integración opt-in con Frigate.
- `apps/native`: núcleo compartido y skeleton Tauri/Rust para el cliente nativo; no equivale a binarios validados.
- PostgreSQL y Redis para datos/estado; MediaMTX para RTSP → HLS/WebRTC; Nginx como proxy.
- Las integraciones ONVIF, Hik-Connect, Frigate, IA y el relay nativo están protegidas por flags que permanecen **OFF por defecto**.
- `prisma/`, `infra/`, `scripts/` y `docker-compose.yml` describen la operación.
- Fuentes de contexto: `docs/PROJECT_DOCUMENTATION.md`, `docs/audits/ROBUSTNESS_CYCLE2.md`, `docs/native/C22_DELIVERY.md`, `docs/native/C22_2_CORRECTIVE.md`, `docs/native/TRACK3_VALIDATION.md`, `docs/audits/LEADERSHIP_SYNTHESIS.md`, `docs/frigate/DEPLOYMENT.md`, `STREAMING.md`, `SECURITY.md` y `DEPLOY.md`.
- `docs/audits/ROBUSTNESS_CYCLE2.md` es anterior a las correcciones del Ciclo 2. Contrastar sus hallazgos con el código y la sección vigente de `docs/PROJECT_DOCUMENTATION.md`.

## Línea base verificada

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

## Invariantes que no se deben romper

1. Nunca fabricar, perder ni declarar inválida una grabación sin evidencia verificable.
2. Mantener RBAC: un usuario solo ve cámaras, grabaciones, alertas, analítica y PTZ permitidos.
3. Un stream se libera únicamente cuando ya no tiene espectadores/sesiones vivos; no depender solo de temporizadores.
4. Cambios de viewport deben invalidar timers, colas, solicitudes y respuestas obsoletas.
5. Mantener explícito el ciclo de vida de FFmpeg/MediaMTX y los intentos terminales de cierre.
6. Nunca registrar ni versionar IPs internas reales, usuarios, contraseñas de NVR, JWT, cookies, claves ni videos.
7. No usar `make clean`, borrar volúmenes, reiniciar servicios, migrar, desplegar, fusionar o hacer force-push sin autorización expresa.

## Método de trabajo obligatorio

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
