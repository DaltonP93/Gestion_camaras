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
- Fuentes de contexto: `docs/PROJECT_DOCUMENTATION.md`, `docs/native/C22_DELIVERY.md`, `docs/native/C22_2_CORRECTIVE.md`, `docs/native/TRACK3_VALIDATION.md`, `docs/audits/LEADERSHIP_SYNTHESIS.md`, `docs/frigate/DEPLOYMENT.md`, `STREAMING.md`, `SECURITY.md` y `DEPLOY.md`.

## Línea base verificada

- Rama principal: `main`.
- HEAD observado: `6e5bb09f48fa02f9e4a98b154cdaf597143935c2`.
- Origen: PR [#162](https://github.com/DaltonP93/Gestion_camaras/pull/162), fusionado el 2026-09-04: `chore(c22): importar trabajo local c22 (equivalente a 9fbb01f) sobre main`.
- Alcance del merge: 188 archivos, 30 commits, 18.596 adiciones y 294 eliminaciones.
- El merge incorpora el ciclo C22: plano de grants y revocación, hardening de seguridad/operación, ingestor y despliegue opt-in de Frigate, servicios/UI ONVIF y Hik-Connect, base de IA/analytics, núcleo nativo y trabajo preparatorio de A1.
- También mantiene el endurecimiento previo del pipeline C1–C21 y la transición atómica del viewport. Nada de esto demuestra ni autoriza un despliegue.

## Validación y checks observados

- GitHub Actions, ejecución [CI #193](https://github.com/DaltonP93/Gestion_camaras/actions/runs/33884819234) sobre el head del PR `490d4ad`: **success**.
- Jobs verdes: Web (typecheck, tests y build), Licencias (sin GPL/AGPL), API (typecheck y tests), Analytics (syntax y tests), imagen de Analytics (smoke test de dependencias nativas) y `docker compose config`.
- La documentación versionada del PR registra validaciones adicionales de TypeScript/Vitest, mutaciones y pruebas Python. Tratar esos resultados como evidencia declarada del PR, no como validación de hardware o producción.
- No se observaron contexts de status separados ni una ejecución asociada todavía al SHA de merge `6e5bb09`.

## Estado GO/NO-GO

- Código C22 en `main`: **fusionado**.
- Despliegue o cambio de producción: **NO-GO**.
- Relay autenticado A1 / `NATIVE_MEDIA_RELAY_ENABLED`: **NO-GO**.
- Frigate, ONVIF, Hik-Connect, IA y capacidades nativas: implementadas o preparadas detrás de flags, pero **NO-GO para habilitar en producción** hasta validar el entorno real y recibir autorización expresa.
- Las funciones nuevas deben seguir apagadas por defecto. No convertir un merge de código en una decisión operativa.

## Riesgos y pendientes confirmados

- Antes de un despliegue, producción requiere una `NVR_CREDENTIAL_KEY` válida; verificar compatibilidad/migración de credenciales legacy y rollback sin registrar valores secretos.
- Validar atomicidad `EVAL` con Redis real y la ruta N1 contra un MediaMTX vivo.
- Compilar/probar Tauri/Rust y el cliente nativo en plataformas objetivo; no hay binarios validados por este handoff.
- Validar ONVIF y Hik-Connect con hardware/cuenta autorizados, y Frigate end-to-end con configuración real.
- Adoptar `waitForCapacity` en un llamador real y resolver la forma durable de la sesión activa para escenarios multi-worker.
- Mantener pendientes las pruebas automatizadas de acceso cruzado/IDOR y la operación documentada de rotación de secretos.
- No asumir que `main` coincide con el servidor; comprobar el SHA desplegado antes de diagnosticar o proponer cambios.

## Invariantes que no se deben romper

1. Nunca fabricar, perder ni declarar inválida una grabación sin evidencia verificable.
2. Mantener RBAC: un usuario solo ve cámaras, grabaciones y PTZ permitidos.
3. Un stream se libera únicamente cuando ya no tiene espectadores/sesiones vivos; no depender solo de temporizadores.
4. Cambios de viewport deben invalidar timers, colas, solicitudes y respuestas obsoletas. Una respuesta vieja no puede iniciar, reactivar ni publicar un stream.
5. Mantener explícito el ciclo de vida de FFmpeg/MediaMTX y los intentos terminales de cierre.
6. Nunca registrar ni versionar IPs internas reales, usuarios, contraseñas de NVR, JWT, cookies, claves ni videos.
7. No usar `make clean`, borrar volúmenes, reiniciar servicios, migrar, desplegar, fusionar o hacer force-push sin autorización expresa.

## Método de trabajo obligatorio

1. Confirmar `git status --short`, `git log -1`, SHA desplegado y PRs abiertos antes de concluir el estado.
2. Leer la documentación del subsistema afectado y proponer un plan pequeño con riesgos.
3. Preferir verificaciones de solo lectura y pruebas reproducibles; declarar claramente lo que no se ejecutó.
4. Para streaming, comprobar simultáneamente UI, API, MediaMTX y navegador; una descarga exitosa no prueba que el reproductor HTML5 sea correcto.
5. Antes de una modificación operativa, pedir autorización explícita y preparar rollback comprobable.
6. No habilitar flags, usar credenciales reales ni conectar hardware/cuentas externas sin aprobación.

## Validación mínima

- Ejecutar los typechecks/tests reales del área afectada y `docker compose config` cuando cambie la composición.
- Para cambios en grants, validar emisión, scope, uso único, expiración, revocación y concurrencia/fallback.
- Para integraciones, validar primero con flags OFF y mocks; separar esas pruebas de la validación real autorizada.
- Usar `make status` solo para consulta; cualquier `up`, `restart`, `migrate` o `down` requiere aprobación si apunta a un entorno no local.

## Qué debe responder Claude al comenzar una tarea

Primero resumir: objetivo, HEAD de `main`, estado desplegado si está comprobado, archivos/servicios implicados, flags, invariantes, evidencia disponible, riesgos y siguiente paso de solo lectura. Debe distinguir con claridad entre código fusionado, pruebas observadas y comportamiento realmente validado en producción.
