# Handoff operativo para IA — VisionCore

> Actualizado: 2026-09-04. Alcance: contexto del código versionado en `main`; no describe el estado del servidor ni autoriza cambios en producción.

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
- `docs/audits/ROBUSTNESS_CYCLE2.md` es un inventario anterior a las correcciones del Ciclo 2. Contrastar sus hallazgos con el código y la sección actual del Ciclo 2 en `docs/PROJECT_DOCUMENTATION.md`.

## Línea base verificada

- Rama principal: `main`.
- HEAD observado: `28039bc073190b3aef52ef9a89032af3605570eb`.
- PR [#162](https://github.com/DaltonP93/Gestion_camaras/pull/162), fusionado el 2026-09-04: importó C22 (188 archivos, 30 commits), incluidos grants/revocación, Frigate opt-in, ONVIF/Hik-Connect, IA/analytics, núcleo nativo y trabajo preparatorio de A1.
- PR [#164](https://github.com/DaltonP93/Gestion_camaras/pull/164), fusionado el 2026-09-04: primer lote del Ciclo 2 de robustez (25 archivos, 14 commits), con hardening de logs, arranque, sesiones, métricas, Redis, Frigate, CORS, imágenes y despliegue.
- PR [#166](https://github.com/DaltonP93/Gestion_camaras/pull/166), fusionado el 2026-09-04: sub-lote del Ciclo 2 (15 archivos, 6 commits, 837 adiciones y 86 eliminaciones).
- El PR #166 incorpora usuarios demo del seed mediante opt-in, rate-limit compartido con Redis, pruebas de regresión IDOR, CSP de scripts más estricta y alcance de alertas/eventos por permiso `canView`.
- Cambios observables aprobados: los usuarios no administradores dejan de ver/accionar alertas de cámaras sin permiso y los usuarios demo dejan de crearse por defecto.
- Estos merges no prueban ni autorizan despliegue, migración, reinicio o activación de flags.

## Validación y checks observados

- GitHub Actions, ejecución [CI #199](https://github.com/DaltonP93/Gestion_camaras/actions/runs/33920091416) sobre el head del PR #166 `5e6e754`: **success**.
- Jobs verdes: Web (typecheck, tests y build), Licencias (sin GPL/AGPL), API (Prisma, typecheck y tests), Analytics (syntax y tests), imagen de Analytics (smoke test de dependencias nativas) y `docker compose config`.
- La descripción del PR registra además `tsc --noEmit` sin errores, 1.268 pruebas Vitest en 84 archivos y build web exitoso. Tratarlo como evidencia declarada del desarrollo, no como validación de navegador, hardware o producción.
- GitHub no registró reviews, comentarios de conversación ni comentarios inline en el PR #166.
- No se observaron contexts de status separados ni una ejecución asociada todavía al SHA de merge `28039bc`.

## Estado GO/NO-GO

- Código C22 y Ciclo 2 en `main`: **fusionado**.
- Despliegue o cambio de producción: **NO-GO**.
- Relay autenticado A1 / `NATIVE_MEDIA_RELAY_ENABLED`: **NO-GO**.
- Frigate, ONVIF, Hik-Connect, IA y capacidades nativas: implementadas o preparadas detrás de flags, pero **NO-GO para habilitar en producción** hasta validar el entorno real y recibir autorización expresa.
- Las funciones nuevas deben seguir apagadas por defecto. No convertir un merge de código en una decisión operativa.

## Comportamiento de seguridad vigente

- Alertas: ADMIN conserva acceso global; los demás roles solo listan, cuentan, marcan, resuelven y reciben por WebSocket alertas de cámaras con `canView`. Las alertas sin `cameraId` continúan siendo globales.
- IDOR: existen pruebas de regresión para lectura de cámaras, PTZ y búsqueda de grabaciones ajenas con respuestas 403/404. No tratarlas como auditoría exhaustiva de todos los endpoints.
- CSP: `script-src` ya no permite `unsafe-inline` y `script-src-attr` es `none`; estilos inline continúan permitidos de forma acotada por el theming y estilos dinámicos de React.
- Rate-limit: con `REDIS_URL` usa un cliente Redis dedicado y contador compartido; sin esa variable conserva el store en memoria. Si Redis falla, degrada permitiendo solicitudes para priorizar disponibilidad.
- Seed: supervisor, operador y auditor solo se crean con `SEED_DEMO_USERS=true`; si se habilitan sin sus contraseñas explícitas, se generan valores aleatorios mostrados una sola vez.

## Precauciones operativas

- Definir explícitamente `CORS_ORIGINS` para cualquier frontend autorizado que no sea same-origin/localhost; si falta, el default endurecido puede bloquear orígenes externos.
- Definir `POSTGRES_PASSWORD` antes de levantar/desplegar el stack. No recuperar el antiguo valor hardcodeado ni registrarlo.
- Entregar y custodiar `SEED_ADMIN_PASSWORD` de forma segura. Mantener `SEED_DEMO_USERS=false` en producción.
- Monitorizar la disponibilidad de Redis: la degradación fail-open del rate-limit evita caída del servicio, pero reduce protección mientras Redis está indisponible.
- Producción requiere una `NVR_CREDENTIAL_KEY` válida; verificar compatibilidad/migración de credenciales legacy y rollback sin registrar valores.
- Las imágenes están fijadas a versiones concretas; futuras actualizaciones deben ser deliberadas y probadas.

## Riesgos y pendientes confirmados

- Falta scope por cámara en eventos de `/analytics/*`; hoy su autorización continúa siendo por rol.
- Revocar permisos no cierra una conexión WebSocket ya abierta; el alcance actualizado se aplica al siguiente broadcast.
- MediaMTX sigue sin healthcheck interno; cambiarlo requiere decidir estrategia/imagen.
- Validar CSP en navegador real y todos los flujos autorizados; el build de Vite no cubre ejecución completa.
- Validar atomicidad `EVAL` con Redis real y la ruta N1 contra un MediaMTX vivo.
- Compilar/probar Tauri/Rust y el cliente nativo en plataformas objetivo; no hay binarios validados por este handoff.
- Validar ONVIF y Hik-Connect con hardware/cuenta autorizados, y Frigate end-to-end con configuración real.
- Adoptar `waitForCapacity` en un llamador real y resolver la forma durable de la sesión activa para escenarios multi-worker.
- No asumir que `main` coincide con el servidor; comprobar el SHA desplegado antes de diagnosticar o proponer cambios.

## Invariantes que no se deben romper

1. Nunca fabricar, perder ni declarar inválida una grabación sin evidencia verificable.
2. Mantener RBAC: un usuario solo ve cámaras, grabaciones, alertas y PTZ permitidos.
3. Un stream se libera únicamente cuando ya no tiene espectadores/sesiones vivos; no depender solo de temporizadores.
4. Cambios de viewport deben invalidar timers, colas, solicitudes y respuestas obsoletas. Una respuesta vieja no puede iniciar, reactivar ni publicar un stream.
5. Mantener explícito el ciclo de vida de FFmpeg/MediaMTX y los intentos terminales de cierre.
6. Nunca registrar ni versionar IPs internas reales, usuarios, contraseñas de NVR, JWT, cookies, claves ni videos.
7. No usar `make clean`, borrar volúmenes, reiniciar servicios, migrar, desplegar, fusionar o hacer force-push sin autorización expresa.

## Método de trabajo obligatorio

1. Confirmar `git status --short`, `git log -1`, SHA desplegado y PRs abiertos antes de concluir el estado.
2. Leer documentación y código del subsistema; diferenciar informes pre-corrección de la línea base actual.
3. Preferir verificaciones de solo lectura y pruebas reproducibles; declarar claramente lo no ejecutado.
4. Para streaming, comprobar simultáneamente UI, API, MediaMTX y navegador; una descarga exitosa no prueba que el reproductor HTML5 sea correcto.
5. Antes de una modificación operativa, pedir autorización explícita y preparar rollback comprobable.
6. No habilitar flags, crear usuarios demo, usar credenciales reales ni conectar hardware/cuentas externas sin aprobación.

## Validación mínima

- Ejecutar los typechecks/tests reales del área afectada y `docker compose config` cuando cambie la composición.
- Para RBAC/alertas, comprobar listado, conteos, mutaciones y WebSocket con cámara permitida, ajena y alerta sin `cameraId`.
- Para CSP, probar build y navegador; revisar consola, theming y flujos con scripts/estilos dinámicos.
- Para cambios de CORS/deploy/seed, validar allowlist, variables requeridas, ausencia de usuarios demo y rollback en un entorno no productivo.
- Para grants, validar emisión, scope, uso único, expiración, revocación y concurrencia/fallback.
- Para integraciones, validar primero con flags OFF y mocks; separar esas pruebas de la validación real autorizada.
- Usar `make status` solo para consulta; cualquier `up`, `restart`, `migrate` o `down` requiere aprobación si apunta a un entorno no local.

## Qué debe responder Claude al comenzar una tarea

Primero resumir: objetivo, HEAD de `main`, estado desplegado si está comprobado, archivos/servicios implicados, flags, invariantes, evidencia disponible, riesgos y siguiente paso de solo lectura. Debe distinguir con claridad entre código fusionado, pruebas observadas y comportamiento realmente validado en producción.
