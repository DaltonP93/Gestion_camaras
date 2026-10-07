# Runbook — Migración de VisionCore al Dell Pro Slim (planificación)

> Estado: **PLAN**. No se ejecuta nada de este documento sin autorización expresa del propietario y
> fecha de ventana acordada. Fecha: 2026-10-07. Base del repo: `main` = `94305f3`.
> Nunca versionar valores de `.env`, IPs internas reales, credenciales, certificados ni videos.

## 0. Origen y destino

| | Servidor actual (`camaras`) | Destino |
|---|---|---|
| Hardware | VM QEMU, 4 vCPU, 7 GB RAM, disco 98 GB, **sin GPU real ni acelerador** | Dell Pro Slim, Intel Core Ultra 5 235 (iGPU Intel + NPU), RAM ampliable a 32 GB, NVMe 512 GB, UPS |
| SO | Ubuntu, kernel 6.14 | Ubuntu Server LTS + Docker Compose directo + Cockpit para supervisión |
| Stack | 8 servicios compose (api, web, nginx, mediamtx, postgres, redis, analytics, certbot); Frigate definido bajo profile, apagado | Igual; Frigate sólo en staging (ver `docs/frigate/NATIVE_INTEGRATION_PROPOSAL.md`, E5) |

Lo observado del servidor actual proviene de una inspección de sólo lectura del 2026-09-23. El
backup, el timer y el certificado no se pudieron verificar entonces: **re-verificar en la Fase 1**.

## 1. Inventario previo (sólo lectura, en el servidor actual)

Registrar, sin copiar valores secretos al ticket ni al repo:

- [ ] `git rev-parse HEAD` y `git status --porcelain` en `/home/sistemas/Gestion_camaras` (debe estar limpio).
- [ ] `docker compose ps` y `docker compose images` (tags **y digests** en ejecución).
- [ ] Lista de **claves** de `.env` (`cut -d= -f1 .env`), no sus valores. Hoy hay claves duplicadas
  (`RECORDINGS_PLAYBACK_STREAM`) y heredadas (`JWT_REFRESH_SECRET`, `ENABLE_HEVC_TRANSCODING`):
  decidir antes de migrar.
- [ ] Volúmenes: `postgres_data`, `redis_data`, `certbot_conf`, `certbot_www`, `uploads_data`,
  `recordings_cache`, `analytics_models`, `frigate_media` (tamaño con `docker system df -v`).
- [ ] Certificado: linaje `camaras-le` (`/etc/letsencrypt/live/camaras-le/`), emisor y vencimiento.
- [ ] systemd: `visioncore-backup.timer` (activo, último y próximo disparo), crons, logrotate.
- [ ] Red: IP, gateway, DNS, reglas de firewall, puertos publicados (80/443), rutas hacia las subredes
  de los NVR, y el registro DNS de `camaras.saa.com.py` con su TTL.
- [ ] Agentes externos instalados (Desktop Commander, monitoreo): **no** se replican sin decisión
  explícita.
- [ ] Último backup íntegro y su `sha256`, y la prueba de restore más reciente (`docs/BACKUP_RESTORE.md`).

## 2. Compatibilidad de hardware, kernel y firmware (destino, antes de instalar el stack)

El Core Ultra 5 235 trae iGPU Intel y NPU. Ambos dependen de kernel y firmware recientes.

1. **BIOS/UEFI y firmware** al día desde Dell (fwupd/LVFS si el modelo lo soporta, o paquete Dell).
   Registrar versiones.
2. **Ubuntu Server LTS con kernel HWE** (no el GA si no reconoce el hardware). Verificar después de
   instalar:
   - iGPU: `ls /dev/dri` muestra `renderD128`; `vainfo` muestra perfiles de decodificación
     H.264/HEVC; el driver (`i915` o `xe`) carga sin errores (`dmesg | grep -iE 'i915|xe '`).
   - NPU: existe `/dev/accel/accel0`, el módulo `intel_vpu` carga, y el firmware de la NPU está
     presente en `linux-firmware` (`dmesg | grep -i vpu`).
   - Si falta alguno: subir kernel/firmware (HWE más nuevo) **antes** de seguir. Frigate documenta que
     el firmware de la NPU lo carga el host y **no** viene en la imagen.
3. **OpenVINO dentro del contenedor** (prueba en E5, no en la migración base): enumerar dispositivos
   y confirmar `CPU`, `GPU` y `NPU`.
4. **Memoria**: con detección, planificar 32 GB (Postgres + Redis + API + MediaMTX + Frigate con
   `shm_size` acorde a cámaras y resolución).
5. **Disco** (NVMe 512 GB): particionado con volúmenes separados para que la media de eventos no
   pueda llenar el disco del sistema:
   - `/` (SO) ~60 GB;
   - `/var/lib/docker` (imágenes, Postgres, Redis);
   - **volumen dedicado y con tamaño fijo** para medios de eventos y la caché de grabaciones.
   Recomendación: LVM, con alertas al 80 % y 90 %.
6. **Docker**: Docker Engine + plugin compose desde el repo oficial; `log-driver` con rotación
   (`max-size`, `max-file`) en `daemon.json`.
7. **Cockpit**: sólo para supervisión del host (CPU, disco, logs, servicios). Escuchar únicamente en
   LAN/VPN, nunca en Internet. Docker se sigue operando con la CLI.

## 3. Seguridad y conservación de secretos

- **`NVR_CREDENTIAL_KEY` debe migrar idéntica.** Si cambia, las contraseñas de NVR cifradas en
  Postgres quedan ilegibles.
- `POSTGRES_PASSWORD` y `JWT_SECRET`: conservarlos evita invalidar sesiones. Rotarlos es una decisión
  aparte, no parte del corte.
- Transferencia de `.env` y certificados: `scp` sobre SSH entre hosts, verificación con `sha256sum`,
  permisos `600` y propietario `root`. Nunca por chat, ticket ni repo.
- Certificados: copiar `certbot_conf` completo (linaje `camaras-le`). En staging el contenedor
  `certbot` **no** debe renovar: hacerlo cambiaría el certificado o gastaría límites de Let's Encrypt.
- Permisos de la aplicación: usuarios, roles y `UserPermission` viajan dentro de Postgres; no hay
  nada que recrear a mano.

## 4. Backup consistente y restauración ensayada

1. **Backup lógico de Postgres** con `scripts/backup.sh` (cifrado), más `sha256`. `pg_dump` da un
   snapshot consistente sin parar la API.
2. **Volúmenes de archivos**: `uploads_data` (branding), `certbot_conf` y `analytics_models`, con
   `tar` y `sha256`. `recordings_cache` no se migra (es regenerable). Redis no se migra: las sesiones
   se pierden y los usuarios vuelven a iniciar sesión (decisión aceptada; si no, migrar el RDB).
3. **Ensayo de restore en el destino (obligatorio antes del corte)**:
   - `scripts/restore.sh` sobre un Postgres limpio;
   - `prisma migrate status` sin pendientes ni fallidas;
   - conteos por tabla iguales a los del origen (cámaras, NVR, usuarios, permisos);
   - un login de prueba;
   - descifrar una credencial de NVR **en el servidor** (sin imprimirla), lo que valida
     `NVR_CREDENTIAL_KEY`.
4. Registrar la duración del restore: es el RTO real.

## 5. Prueba aislada en el destino (sin duplicar producción)

**Riesgo:** al arrancar, la API levanta `healthWorker` y `syncWorker`, que **consultan los NVR y
generan alertas y notificaciones**. Hoy no existe una flag para apagarlos, y la analítica también se
conecta. Una copia mal aislada duplicaría conexiones RTSP/ISAPI a los NVR y notificaciones reales.

**Medidas (todas antes de `docker compose up` en el destino):**

1. **Aislamiento de red por firewall de salida** en el destino: bloquear las subredes de los NVR,
   SMTP saliente y webhooks salientes (Slack, Teams, webhook genérico). Sólo dejar lo necesario para
   descargar imágenes. Verificar con una prueba de conexión que falle.
2. En la **copia** restaurada de la base (nunca en producción), apagar canales:
   `AlertSettings.emailEnabled`, `slackEnabled`, `teamsEnabled` y `webhookEnabled` en `false`, y
   `ANALYTICS_ENABLED=false` en el `.env` de staging.
3. `certbot` detenido. Usar otro hostname de staging o acceso por IP de LAN, para no competir por el
   DNS de producción.
4. **Propuesta de PR previo (recomendado):** una flag `BACKGROUND_JOBS_ENABLED` / modo
   `NOTIFICATIONS_DRY_RUN` para que el aislamiento no dependa sólo del firewall.
5. **Pruebas en staging:**
   - `scripts/smoke-test.sh`;
   - `docker compose config -q`;
   - `/api/health` = 200 con el commit esperado;
   - HLS anónimo = 401;
   - `nginx -T` pasa `scripts/check-hls-auth-nginx.sh`;
   - login y permisos con un usuario no-admin.
   La prueba con NVR reales se hace sólo en una ventana acordada, con 1 o 2 cámaras y midiendo
   sesiones RTSP por NVR.

## 6. Control de espacio y retención

- Volumen dedicado para medios de eventos con tamaño fijo. La retención la gestiona VisionCore
  (`expiresAt`, cuota por suma de bytes; ver la propuesta, §4).
- `RECORDINGS_CACHE_MAX_GB` acotado al volumen de caché.
- Rotación de logs de Docker y journald (`SystemMaxUse`).
- Alertas de disco al 80 % y 90 % (Cockpit o el `healthWorker`) y prueba de que la retención libera
  espacio.

## 7. Corte controlado

1. Anunciar la ventana. Bajar el **TTL del DNS** con al menos 24 h de anticipación.
2. Congelar cambios: no hacer merges ni deploys durante la ventana.
3. En el origen: backup final (§4) y `sha256`; detener `api` para que no haya escrituras nuevas (el
   vivo se corta durante la ventana); registrar la hora.
4. En el destino: restore del backup final, levantar el **`.env` de producción** (sin las
   restricciones de staging), quitar el bloqueo de firewall de §5 y arrancar `certbot` con el linaje
   copiado.
5. Cambiar el DNS o la IP hacia el destino.
6. Verificación posterior:
   - salud y commit;
   - HLS 401 anónimo;
   - login;
   - vivo 1×1 y 2×2 con usuario real;
   - búsqueda y playback de una grabación;
   - alerta de prueba por email con el SMTP real (un único destinatario interno);
   - `visioncore-backup.timer` activo y un backup manual exitoso en el destino;
   - certificado válido sin `-k`.
7. **Criterio GO:** todo lo anterior en verde dentro de la ventana. Si algo falla y no se corrige en
   el tiempo acordado → rollback.

## 8. Rollback al servidor anterior

- El origen **no se borra ni se reinstala** durante un período acordado (sugerido: 14 días). Queda
  detenido, con sus volúmenes intactos.
- **Rollback:** detener el stack del destino, volver el DNS o la IP al origen y levantar el stack del
  origen (`docker compose up -d`, sin `--build`).
- **Datos creados en el destino** después del corte (alertas, auditoría, cambios de configuración)
  **se pierden en un rollback** salvo que se exporten. Definir de antemano si se aceptan o si se
  re-importan con `pg_dump` de tablas seleccionadas.
- Probar el rollback en el ensayo de §4 (detener el destino y reactivar el origen en la LAN) antes
  del día del corte.

## 9. UPS (cuando se confirme el modelo)

- Usar **NUT** (Network UPS Tools) si el modelo está soportado (USB HID o SNMP). Configurar
  `upsmon` con un umbral de batería y un tiempo restante mínimo.
- **Orden de apagado:**
  1. detener `api` y `analytics` (dejan de escribir);
  2. `docker compose stop` del resto, con Postgres al final para que cierre limpio;
  3. `shutdown` del SO.
  El script de apagado se prueba con el UPS en modo de prueba, no cortando la energía.
- Al volver la energía: arranque automático del host, `docker compose up -d` y verificación de salud.
- Registrar los eventos del UPS en journald. Opcionalmente, VisionCore puede generar una alerta
  interna si el UPS reporta batería.

## 10. Pendientes antes de ejecutar

- [ ] Modelo exacto del UPS y forma de conexión.
- [ ] Versión de Ubuntu/kernel validada con el §2 en el equipo físico.
- [ ] Decisión sobre la flag de jobs y notificaciones (§5.4).
- [ ] Decisión sobre migrar o no la sesión de Redis.
- [ ] Ventana y responsables (quién ejecuta, quién valida, quién decide el rollback).
