# Handoff operativo para IA — VisionCore

> Actualizado: 2026-09-01. Alcance: contexto del código versionado en `main`. No describe ni autoriza cambios en producción.

## Propósito

VisionCore es un sistema VMS web para administrar NVR Hikvision: vista en vivo, grabaciones, cámaras, usuarios, roles, control de acceso y PTZ. Debe proteger la continuidad de visualización y la evidencia de grabaciones; no es solo un dashboard de video.

## Arquitectura confirmada

- `apps/api`: Node.js, Fastify y Prisma.
- `apps/web`: React 18, Vite, TypeScript, Tailwind y Zustand.
- PostgreSQL y Redis para estado/datos; MediaMTX para RTSP → HLS/WebRTC; Nginx como proxy.
- `prisma/`, `infra/`, `scripts/` y `docker-compose.yml` describen la operación.
- Leer antes de tocar streaming: `README.md`, `STREAMING.md`, `RECORDINGS_SDK_PLAN.md`, `SECURITY.md`, `TROUBLESHOOTING.md` y `DEPLOY.md`.

## Línea base verificada

- Rama principal: `main`.
- Último commit observado al redactar: `ad4d4da` (2026-08-19), fusión del trabajo A1 de transición de viewport atómica.
- A1 mejora el aislamiento de cambios de NVR/página/layout, cancelando trabajo transitorio y evitando que respuestas viejas publiquen estado nuevo. Esa línea de trabajo no implica autorización de despliegue.
- Hay una investigación previa sobre reproducción HTTP de MP4: archivos, metadatos, duración y descarga podían mantenerse correctos mientras el reproductor fallaba por el manejo personalizado de `Range`/HTTP. Revalidar con trazas actuales antes de modificar almacenamiento o borrar evidencia.

## Invariantes que no se deben romper

1. Nunca fabricar, perder ni declarar inválida una grabación sin evidencia verificable.
2. Mantener RBAC: un usuario solo ve cámaras, grabaciones y PTZ permitidos.
3. Un stream se libera únicamente cuando ya no tiene espectadores/sesiones vivos; no depender solo de temporizadores.
4. Cambios de viewport deben invalidar timers, colas, solicitudes y respuestas obsoletas. Una respuesta vieja no puede iniciar, reactivar ni publicar un stream.
5. Mantener explícito el ciclo de vida de FFmpeg/MediaMTX y los intentos terminales de cierre.
6. Nunca registrar ni versionar IPs internas reales, usuarios, contraseñas de NVR, JWT, cookies, claves ni videos.
7. No usar `make clean`, borrar volúmenes, reiniciar servicios, migrar, desplegar, fusionar o hacer force-push sin autorización expresa.

## Método de trabajo obligatorio

1. Confirmar `git status --short`, `git log -1` y PRs abiertos antes de concluir el estado.
2. Leer la documentación del subsistema afectado y proponer un plan pequeño con riesgos.
3. Preferir verificaciones de solo lectura y pruebas reproducibles; declarar claramente lo que no se ejecutó.
4. Para streaming, comprobar simultáneamente UI, API, MediaMTX y navegador; una descarga exitosa no prueba que el reproductor HTML5 sea correcto.
5. Antes de una modificación operativa, pedir autorización explícita y preparar rollback comprobable.

## Validación mínima

- `docker compose config` para validar la composición.
- Revisar los comandos y pruebas reales del área afectada antes de ejecutarlos.
- Usar `make status` solo para consulta; cualquier `up`, `restart`, `migrate` o `down` requiere aprobación si apunta a un entorno no local.

## Qué debe responder Claude al comenzar una tarea

Primero resumir: objetivo, archivos/servicios implicados, invariantes, evidencia disponible, riesgo y siguiente paso de solo lectura. No asumir que el estado de `main` equivale al estado del servidor.
