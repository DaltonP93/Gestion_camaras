# VisionCore VMS — Guía de Despliegue

## Prerrequisitos

- Docker Engine 24+ y Docker Compose v2 (`docker compose version`)
- Git
- Dominio con DNS apuntando al servidor (para HTTPS)
- Puertos abiertos: 80, 443, 554 (RTSP), 8888 (HLS), 8889 (WebRTC)
- Acceso de red a los NVRs (IPs internas de la LAN de cámaras)

---

## 1. Clonar y configurar variables de entorno

```bash
git clone <repo> /opt/visioncore
cd /opt/visioncore
cp .env.example .env
```

Editar `.env` con valores reales:

| Variable | Descripción | Cómo generar |
|---|---|---|
| `JWT_SECRET` | Clave JWT (obligatoria, mín. 32 chars; el API no arranca con un valor público conocido ni con uno no aleatorio) | `openssl rand -hex 64` |
| `NVR_CREDENTIAL_KEY` | Clave AES para contraseñas NVR | `openssl rand -hex 32` |
| `CORS_ORIGINS` | Orígenes permitidos (coma-separados) | `https://camaras.saa.com.py` |
| `COOKIE_SECURE` | `true` solo con HTTPS activo | `false` (HTTP) / `true` (HTTPS) |

> **IMPORTANTE:** Si `COOKIE_SECURE=true` y el sitio es HTTP, el login falla silenciosamente porque las cookies no se envían.

> **JWT_SECRET:** `docker-compose.yml` ya no trae valor por defecto (`docker compose` aborta si falta) y el API
> aborta al arrancar si coincide con un valor público conocido. `setup.sh` lo genera si la línea está vacía
> (nunca pisa un valor existente). Escribilo en una sola línea, sin comillas ni `$` (ASCII, como produce
> `openssl rand -hex 64`). Verificar sin imprimir valores:
> `bash scripts/check-public-secrets.sh --env-file .env --process-env`. Exit 1 **sólo** por JWT_SECRET
> (ausente, público, no apto o "no verificable": una línea que el script no puede leer igual que compose);
> `setup.sh` y los `deploy.sh` abortan con eso antes de tocar contenedores. Las demás variables vigiladas se
> **informan** con su "qué hacer" y no bloquean (`--strict` las vuelve bloqueantes): **no** las reemplaces a
> ciegas en `.env`. `POSTGRES_PASSWORD` exige `ALTER USER` coordinado con `.env` (Postgres sólo la toma en
> initdb), `NVR_CREDENTIAL_KEY` exige re-cifrar las contraseñas de NVR antes de rotarla y
> `JWT_REFRESH_SECRET` se elimina porque el API no la usa. La lista de placeholders genéricos es de mejor
> esfuerzo: lo que garantiza el secreto es generarlo con openssl. Cambiar `JWT_SECRET` invalida todas las
> sesiones (re-login).

Variables opcionales para ajustar límites de streaming:
```env
MAX_STREAMS_PER_USER=16
MAX_STREAMS_GLOBAL=50
STREAM_IDLE_TIMEOUT=90
```

---

## 2. Despliegue inicial

```bash
# Despliegue completo automatizado (build + migraciones + verificación)
bash scripts/deploy.sh main

# O paso a paso manualmente:
docker compose build --no-cache api web
docker compose up -d
docker compose exec -T api npx prisma migrate deploy
docker compose exec -T api npx tsx apps/api/src/seed.ts   # crea usuario admin
```

El script `deploy.sh` realiza backup automático de la DB en `backups/` antes de cada deploy.

---

## 3. Migraciones de base de datos

```bash
# Aplicar migraciones pendientes (seguro, no destructivo)
docker compose exec api npx prisma migrate deploy

# Crear nueva migración tras cambiar schema.prisma
docker compose exec api npx prisma migrate dev --name nombre_cambio

# Ver estado de migraciones
docker compose exec api npx prisma migrate status
```

---

## 4. Habilitar HTTPS (Let's Encrypt)

```bash
# 1. Editar server_name en infra/nginx/nginx.conf con el dominio real
# 2. Obtener certificado (nginx debe estar en HTTP en este momento)
bash infra/certbot/init-ssl.sh

# 3. Actualizar nginx a HTTPS
bash infra/certbot/upgrade-to-https.sh

# 4. Recargar nginx
docker compose exec nginx nginx -s reload

# 5. Activar cookies seguras
# En .env: COOKIE_SECURE=true
docker compose restart api
```

La renovación automática está configurada en el servicio `certbot` del compose (cada 12 horas),
acotada al **linaje canónico `camaras-le`** (`certbot renew --cert-name camaras-le`). nginx recarga
solo cada ~6h y toma el cert renovado del volumen compartido (sin `docker.sock`).

Dominio (SAN): `camaras.saa.com.py`. **Linaje del certificado (lo que sirve nginx): `camaras-le`**
— `init-ssl.sh` emite con `--cert-name camaras-le`, por lo que el cert vive en
`/etc/letsencrypt/live/camaras-le/`. Para cambiar dominio o linaje, editar `DOMAIN`/`CERT_NAME` en
`infra/certbot/init-ssl.sh` y `upgrade-to-https.sh` y las rutas `ssl_certificate(_key)` de
`infra/nginx/nginx.conf` (el guard `scripts/check-cert-lineage.sh` verifica que sigan coincidiendo).

---

## 5. Verificar servicios post-deploy

```bash
docker compose ps                          # todos en estado "running"
curl http://localhost/api/health           # debe responder 200
bash scripts/check-nvrs.sh                # conectividad con los 4 NVRs
docker compose logs -f api --tail 50      # logs del backend
```

Servicios esperados activos: `postgres`, `redis`, `mediamtx`, `api`, `web`, `nginx`, `certbot`.

**IP del cliente detrás de nginx (`TRUSTED_PROXIES`, ver `.env.example`).** Al arrancar,
el API registra `[startup] trust-proxy: sólo el salto inmediato; origen=…`. Si aparece
`[trust-proxy] llegó X-Forwarded-For desde un par de red interna que NO está en
TRUSTED_PROXIES`, nginx quedó en una subred no cubierta: los cupos de rate-limit
vuelven a ser compartidos (comportamiento previo, el HLS no se afecta) hasta agregar la
subred de `visioncore_net`. Comprobación de solo lectura: tras un login, la columna
`ipAddress` de la sesión debe mostrar la IP del cliente y no la de nginx.

Con los cupos por cliente, el 2.º factor ya no depende del cupo de una IP: `/2fa/verify`,
`/step-up` (TOTP o contraseña), `/2fa/disable` y `/2fa/backup-codes/regenerate` comparten
un contador de fallos **por usuario** en Redis (`auth:2fa-fail:<userId>`). Al llegar a
`lockoutMaxAttempts` fallos la cuenta queda bloqueada `lockoutDurationMinutes` (los
mismos ajustes y el mismo `lockedUntil` que el login): el login y el código correcto
reciben `403 ACCOUNT_LOCKED` hasta que vence o hasta `POST /api/users/:id/unlock`, que
también borra el contador. Si Redis no responde, esas cuatro rutas responden 500 sin
verificar el código (fail-closed); el login de usuarios sin MFA no depende de Redis.
El contador limita la adivinación, no la reutilización: sigue abierto MFA-04 (el
tempToken y un código TOTP ya aceptado se pueden reusar mientras sigan vigentes).

Los logs de request del API registran el `Host` y el par TCP (detrás de nginx, la IP
de nginx), igual que antes: ni la IP del cliente ni `X-Forwarded-Host`. La IP del
cliente queda en `Session.ipAddress` y en la auditoría (`AUDIT_RETENTION_DAYS`).

---

## 6. Rollback

```bash
# Ver commits disponibles para revertir
bash scripts/rollback.sh

# Revertir a un commit específico (pide confirmación)
bash scripts/rollback.sh abc1234
```

El script hace checkout del código, rebuild de imágenes y redeploy automático. Para rollback de DB:

```bash
# Los backups están en backups/db_backup_YYYYMMDD_HHMMSS.sql
docker compose exec -T postgres psql -U visioncore visioncore_db \
  < backups/db_backup_<fecha>.sql
```

---

## Servicios y puertos

| Servicio | Puerto interno | Expuesto al host |
|---|---|---|
| postgres | 5432 | 5432 |
| redis | 6379 | 6379 |
| mediamtx | 8554/8888/8889 | idem |
| mediamtx API | 9997 | 9997 (restringir en prod) |
| api | 4000 | 4000 |
| web | 80 (interno) | vía nginx |
| nginx | — | 80, 443 |

> En producción, considerar no exponer los puertos 5432, 6379 y 9997 al exterior.
