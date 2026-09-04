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
| `JWT_SECRET` | Clave JWT (mín. 32 chars) | `openssl rand -hex 64` |
| `NVR_CREDENTIAL_KEY` | Clave AES para contraseñas NVR | `openssl rand -hex 32` |
| `CORS_ORIGINS` | Orígenes permitidos (coma-separados) | `https://camaras.saa.com.py` |
| `COOKIE_SECURE` | `true` solo con HTTPS activo | `false` (HTTP) / `true` (HTTPS) |

> **IMPORTANTE:** Si `COOKIE_SECURE=true` y el sitio es HTTP, el login falla silenciosamente porque las cookies no se envían.

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

La renovación automática está configurada en el servicio `certbot` del compose (cada 12 horas).

Dominio configurado: `camaras.saa.com.py`. Para cambiarlo, editar `infra/certbot/init-ssl.sh` y `upgrade-to-https.sh`.

---

## 5. Verificar servicios post-deploy

```bash
docker compose ps                          # todos en estado "running"
curl http://localhost/api/health           # debe responder 200
bash scripts/check-nvrs.sh                # conectividad con los 4 NVRs
docker compose logs -f api --tail 50      # logs del backend
```

Servicios esperados activos: `postgres`, `redis`, `mediamtx`, `api`, `web`, `nginx`, `certbot`.

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
