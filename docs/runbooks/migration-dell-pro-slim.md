# Runbook — Migración de VisionCore al Dell Pro Slim (planificación)

> Estado: **PLAN**. No se ejecuta nada de este documento sin autorización expresa del propietario y
> fecha de ventana acordada. Revisión 2 — 2026-10-07. Base: `main` = `94305f3`.
> Nunca versionar valores de `.env`, IPs internas reales, credenciales, certificados ni videos.

## 0. Principios

1. **Un solo primario.** En ningún momento puede haber dos instancias de VisionCore que sondeen los
   NVR, abran streams, envíen notificaciones o acepten escrituras de usuarios. El servidor que no es
   primario queda **cercado** (§6).
2. **Backup final sólo con todos los escritores detenidos** (§5). Así el backup es el estado completo
   y no queda ninguna escritura después de él.
3. **Misma versión en ambos lados.** Durante la ventana, origen y destino corren **el mismo commit**
   y el mismo nivel de migraciones. Prohibido aplicar migraciones nuevas en la ventana: es lo que
   permite volver atrás sin perder datos (§8).
4. **El rollback preserva lo creado después del corte** con el mismo procedimiento que el corte, en
   sentido inverso (§8).

## 1. Origen y destino

| | Servidor actual (`camaras`) | Destino |
|---|---|---|
| Hardware | VM QEMU, 4 vCPU, 7 GB RAM, disco 98 GB, sin GPU real ni acelerador | Dell Pro Slim, Intel Core Ultra 5 235 (iGPU Intel + NPU), RAM ampliable a 32 GB, NVMe 512 GB, UPS |
| SO | Ubuntu, kernel 6.14 | Ubuntu Server LTS + Docker Compose directo + Cockpit |
| Stack | api, web, nginx, mediamtx, postgres, redis, analytics, certbot; Frigate definido bajo profile, apagado | Igual. El motor de detección sólo en staging (propuesta, E7) |

Lo observado del servidor actual proviene de una inspección de sólo lectura del 2026-09-23. El backup,
el timer y el certificado no se pudieron verificar entonces: **re-verificar en §2**.

## 2. Inventario previo (sólo lectura, en el origen)

**Repositorio, contenedores y configuración:**
- [ ] `git rev-parse HEAD` y `git status --porcelain` en `/home/sistemas/Gestion_camaras` (limpio).
- [ ] `docker compose ps` y `docker compose images` (tags **y digests**).
- [ ] Claves de `.env` (`cut -d= -f1 .env`), nunca valores. Decidir qué hacer con las duplicadas
  (`RECORDINGS_PLAYBACK_STREAM`) y las heredadas (`JWT_REFRESH_SECRET`, `ENABLE_HEVC_TRANSCODING`).

**Volúmenes y su destino:**

| Volumen | Contenido | ¿Migrar? |
|---|---|---|
| `postgres_data` | base | Sí, con `pg_dump` (§5), no copiando el directorio |
| `redis_data` | estado efímero (§3) | No (decisión de §3) |
| `certbot_conf` | certificados, linaje `camaras-le` | Sí (tar) |
| `certbot_www` | desafíos ACME | No |
| `uploads_data` | branding (logos, favicon) | Sí (tar) |
| `recordings_cache` | caché regenerable | No |
| `analytics_models` | modelo ONNX con checksum | Sí (tar), o se re-descarga y verifica sha256 |
| `frigate_media` | vacío o inexistente hoy | No |

**Host:**
- Certificado: emisor y vencimiento del linaje `camaras-le`.
- systemd: `visioncore-backup.timer` (último y próximo disparo), crons y logrotate.
- Red: IP, gateway, DNS, firewall, puertos publicados (80/443 y `127.0.0.1:8554`), rutas hacia las
  subredes de NVR, registro DNS de `camaras.saa.com.py` y su TTL.
- Agentes instalados (Desktop Commander, monitoreo): no se replican sin decisión explícita.
- Último backup íntegro, su `sha256` y la prueba de restore más reciente (`docs/BACKUP_RESTORE.md`).

## 3. Inventario de datos: PostgreSQL y Redis

### 3.1 PostgreSQL (fuente de verdad: se migra completo)

Contiene todo el estado durable:
- usuarios, roles y permisos (`User`, `UserPermission`);
- **sesiones de login** (`Session`: refresh tokens rotados con detección de reúso) y
  `UsedRefreshToken`;
- NVR, cámaras y credenciales de NVR **cifradas** con `NVR_CREDENTIAL_KEY`;
- alertas, `NotificationDelivery`, `AuditLog`, configuración (`AlertSettings`, apariencia,
  grabaciones) y analítica;
- el **outbox de revocación** (`media_revoke_outbox`).

Conteos de referencia (2026-09-23, re-medir en el corte): 144 `cameras`, 4 `nvrs`, 5 `sessions`,
1720 `alerts`, 605 `audit_logs`, 554 `notification_deliveries`, 472 `used_refresh_tokens`;
36/36 migraciones aplicadas.

Las sesiones de login viajan con la base. Si `JWT_SECRET` se conserva, los usuarios **no** tienen
que volver a iniciar sesión. Lo que sí se corta durante la ventana son los streams.

### 3.2 Redis (estado efímero: arranca vacío en el destino)

| Uso (código) | Claves | Si arranca vacío |
|---|---|---|
| Rate-limit compartido (`@fastify/rate-limit`) | contadores con TTL | Se reinician los contadores; aceptable |
| Grants del plano de medios nativo (`services/media/grant-store.ts`, Lua) | `vc:mg:*` | Las flags nativas están OFF ⇒ inerte. Si estuvieran ON, se pierden grants **y** epochs a la vez, así que no revalida nada viejo. La revocación durable vive en PostgreSQL (outbox) |
| Tickets de WebSocket (`services/ws-ticket.ts`) | `ws:ticket:*` (vida corta) | Los clientes piden un ticket nuevo al reconectar |
| Bus de revocación de WebSocket (`services/ws-revoke-bus.ts`) | pub/sub, sin persistencia | Nada que migrar |
| Tokens de descarga de grabaciones (`routes/recordings.ts`) | `vc:dltoken:*` (TTL 24 h) | Las descargas en curso se vuelven a pedir |
| Registro de consumidores de streams (`services/stream-consumer-registry.ts`) | `vc:consumers:*` | Correcto que arranque vacío: todos los streams se cortan en la ventana |

**Decisión:** Redis **no se migra**; arranca vacío en el destino. Re-evaluar si para la fecha del
corte se agrega algún uso durable de Redis: el inventario se rehace en §2 con
`redis-cli --scan --count 1000 | cut -d: -f1-2 | sort | uniq -c`, sin leer valores.

## 4. Compatibilidad de hardware, kernel y firmware (destino)

1. **BIOS/UEFI y firmware** al día desde Dell (fwupd/LVFS si el modelo lo soporta). Registrar
   versiones.
2. **Ubuntu Server LTS con kernel HWE.** Verificar:
   - iGPU: `ls /dev/dri` muestra `renderD128`; `vainfo` muestra perfiles H.264/HEVC; el driver
     `i915` o `xe` carga sin errores;
   - NPU: existe `/dev/accel/accel0`, el módulo `intel_vpu` carga y el firmware de la NPU está
     presente (`dmesg | grep -i vpu`);
   - si falta algo, subir kernel o firmware **antes** de continuar. El firmware de la NPU lo carga el
     host; no viene en la imagen del motor de detección.
3. OpenVINO dentro del contenedor del motor se prueba en E7, no en la migración base.
4. Memoria: 32 GB si va a haber detección.
5. **Disco** (NVMe 512 GB, LVM):
   - `/` (SO);
   - `/var/lib/docker`;
   - **volumen dedicado y de tamaño fijo** para medios de eventos y caché de grabaciones;
   - alertas al 80 % y 90 %.
6. Docker Engine + plugin compose del repo oficial; rotación de logs en `daemon.json`; journald con
   `SystemMaxUse`.
7. Cockpit sólo para supervisión del host, escuchando en LAN o VPN, nunca en Internet.

## 5. Backup consistente (todos los escritores detenidos)

**Escritores que hay que detener**, en este orden, antes del backup final:

| # | Escritor | Cómo se detiene | Por qué |
|---|---|---|---|
| 1 | Usuarios (UI y API) | nginx sirve una página de mantenimiento (503) para todo salvo `/.well-known/acme-challenge/` | evita escrituras de usuarios y sesiones nuevas |
| 2 | Timers del host (`visioncore-backup.timer`, crons) | `systemctl stop` (no `disable`) y anotar el estado previo | que no corra un backup a mitad de la ventana |
| 3 | `analytics` | `docker compose stop analytics` | escribe eventos vía la API |
| 4 | `api` (HTTP + `healthWorker` + `syncWorker` + revocación) | `docker compose stop api` | el escritor principal; detiene sondeo, sync y avisos |
| 5 | `certbot` | `docker compose stop certbot` | escribe en `certbot_conf` |
| 6 | `mediamtx`, `web` | `docker compose stop` | sin escrituras durables, pero no deben atender |

PostgreSQL y Redis **siguen arriba** para el dump.

**Comprobar que no quedan escritores:**
- `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();`
  debe dar 0 conexiones de la aplicación;
- `docker compose ps` muestra sólo `postgres` y `redis` arriba.

**Backup final:**
1. `scripts/backup.sh` (cifrado) + `sha256`.
2. `tar` de `certbot_conf`, `uploads_data` y `analytics_models` + `sha256`.
3. Registrar hora, conteos por tabla y `prisma migrate status`.

**Ensayo previo de restore (obligatorio, días antes del corte, en el destino aislado):**
- `scripts/restore.sh` sobre un PostgreSQL limpio;
- `prisma migrate status` sin pendientes;
- conteos iguales;
- login de prueba;
- descifrar una credencial de NVR **en el servidor**, sin imprimirla (valida `NVR_CREDENTIAL_KEY`);
- registrar la duración del restore: es el RTO real.

## 6. Cercado: nunca dos primarios

**Durante el ensayo (destino = staging):**
- `STAGING_ISOLATION=true` en el `.env` del destino (#187): sin sondeo, sync ni registro de streams,
  y sin avisos externos;
- `ANALYTICS_ENABLED=false`;
- `certbot` detenido;
- **además**, firewall de salida que bloquea las subredes de NVR, SMTP y webhooks (defensa en
  profundidad: #187 no cubre acciones iniciadas por un usuario);
- hostname o IP de staging, nunca el DNS de producción.

**En el corte:**
- Después del backup final, el **origen queda cercado antes** de levantar el destino:
  1. `docker compose down`: elimina contenedores, **no** volúmenes. Con `restart: unless-stopped`
     un contenedor detenido a mano no vuelve solo al reiniciar Docker; el riesgo real es un
     `docker compose up` accidental o un script de deploy. Por eso se suman los pasos 2 y 3;
  2. en el `.env` del origen, `STAGING_ISOLATION=true` y `ANALYTICS_ENABLED=false`, para que un
     arranque accidental no sondee NVR ni envíe avisos;
  3. marcador `/home/sistemas/Gestion_camaras/NOT_PRIMARY` con fecha y motivo;
  4. timers del host deshabilitados en el origen.
- Recién entonces se levanta el destino con el `.env` de producción.
- Verificación: sólo el destino aparece en las conexiones de los NVR (ISAPI o el panel del NVR) y en
  el SMTP.

## 7. Corte controlado

1. Anunciar la ventana. Bajar el **TTL del DNS** al menos 24 h antes.
2. Congelar cambios: sin merges, deploys ni migraciones. Ambos servidores en el mismo commit.
3. §5: detener escritores, backup final y comprobación.
4. §6: cercar el origen.
5. En el destino:
   - restore del backup final;
   - `.env` de producción (sin `STAGING_ISOLATION`);
   - quitar el bloqueo de firewall de staging;
   - levantar el stack;
   - `certbot` con el linaje copiado.
6. Cambiar DNS o IP hacia el destino.
7. **Verificación** (GO):
   - `/api/health` = 200 con el commit esperado;
   - HLS anónimo = 401;
   - `nginx -T` pasa `scripts/check-hls-auth-nginx.sh`;
   - login, incluyendo sesión previa sin re-login si se conservó `JWT_SECRET`;
   - vivo 1×1 y 2×2 con usuario real;
   - búsqueda y playback;
   - alerta de prueba por email a un único destinatario interno;
   - `visioncore-backup.timer` activo y un backup manual OK;
   - certificado válido sin `-k`.
8. Si algo falla y no se corrige en el tiempo acordado → §8.

## 8. Rollback al servidor anterior preservando los datos posteriores al corte

El origen **no se borra ni se reinstala** durante un período acordado (sugerido: 14 días). Queda
cercado (§6) con sus volúmenes intactos.

**Rollback = corte inverso, con el mismo procedimiento:**
1. En el destino: detener todos los escritores (§5, mismos pasos), backup final cifrado y `sha256`.
   Tar de `uploads_data` y de `certbot_conf` si hubo renovación.
2. Cercar el destino (§6, mismos pasos).
3. En el origen:
   - quitar el marcador y las flags de cercado;
   - **restaurar el backup del destino** sobre la base del origen;
   - restaurar `uploads_data` y `certbot_conf` si cambiaron;
   - levantar el stack.
4. DNS o IP de vuelta al origen y verificación GO (§7.7).

**Por qué preserva los datos:** por el principio 3, ambos servidores tienen el mismo esquema. El dump
del destino es el estado completo, incluidas alertas, auditoría, sesiones, cambios de configuración y
permisos creados después del corte. Restaurarlo en el origen no pierde nada.

**Si se violó el principio 3** (el destino aplicó una migración nueva): primero desplegar en el
origen **el mismo commit** que el destino y luego restaurar. Si eso no es posible, la vuelta queda
bloqueada: detenerse y decidir con el propietario.

**Ensayar el rollback** (corte inverso con datos de prueba) en el ensayo del §5, antes del día del
corte.

## 9. Control de espacio y retención

- Volumen dedicado y fijo para medios de eventos y caché. La retención la aplica VisionCore (cuota y
  `expiresAt`; ver la propuesta, §7).
- `RECORDINGS_CACHE_MAX_GB` acotado al volumen de caché.
- Rotación de logs de Docker y journald.
- Alertas de disco al 80 % y 90 %, y prueba de que la retención libera espacio.

## 10. UPS (cuando se confirme el modelo)

- **NUT** (Network UPS Tools) si el modelo está soportado (USB HID o SNMP). `upsmon` con umbral de
  batería y tiempo restante mínimo.
- **Orden de apagado:**
  1. página de mantenimiento en nginx;
  2. `docker compose stop api analytics`;
  3. `docker compose stop` del resto, con `postgres` al final;
  4. `shutdown`.
  Probar con el UPS en modo de prueba, no cortando la energía.
- Al volver la energía: arranque del host, `docker compose up -d` y verificación de salud. Eventos del
  UPS en journald.

## 11. Pendientes antes de ejecutar

- [ ] Modelo exacto del UPS y forma de conexión.
- [ ] Ubuntu y kernel validados en el equipo físico (§4).
- [ ] #187 (aislamiento de staging) revisado y fusionado con autorización antes del ensayo.
- [ ] Página de mantenimiento de nginx preparada y probada en staging.
- [ ] Ventana, responsables (quién ejecuta, valida y decide el rollback) y duración máxima.
