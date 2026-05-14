# VisionCore VMS — Guía de Despliegue

## Prerequisitos

- Docker Engine 24+ y Docker Compose v2
- Git
- Puerto 80 y 443 abiertos en firewall
- Acceso de red a los NVRs (192.168.1.10, .110, .111, .112)

```bash
docker compose version   # debe mostrar v2.x
```

## Variables de entorno

Copiar y editar antes de levantar:

```bash
cp .env.example .env
```

Variables obligatorias en `.env`:

```env
# Claves de seguridad (generar con los comandos indicados)
JWT_SECRET=<64 bytes hex>          # openssl rand -hex 64
NVR_CREDENTIAL_KEY=<32 bytes hex>  # openssl rand -hex 32

# JWT expiry (defaults: 60m / 7d)
JWT_EXPIRES_IN=60m
JWT_REFRESH_EXPIRES_IN=7d

# CORS — dominio(s) del frontend separados por coma
CORS_ORIGINS=https://camaras.saa.com.py

# Solo true si el sitio ya tiene HTTPS activo
COOKIE_SECURE=false

# Límites de streaming (opcionales)
MAX_STREAMS_PER_USER=16
MAX_STREAMS_GLOBAL=50
STREAM_IDLE_TIMEOUT=90
```

La variable `DATABASE_URL` y `REDIS_URL` se inyectan directamente desde `docker-compose.yml`; no es necesario definirlas en `.env` salvo entornos externos.

## Primer despliegue

```bash
# 1. Clonar o actualizar el repositorio
git clone <repo> && cd Gestion_camaras

# 2. Levantar todos los servicios
docker compose up -d

# 3. Esperar a que PostgreSQL esté healthy
docker compose ps

# 4. Aplicar migraciones y seed inicial
docker compose exec api npx prisma migrate deploy
docker compose exec api npx ts-node prisma/seed.ts   # crea usuario admin por defecto
```

## Script de despliegue automatizado

```bash
bash scripts/deploy.sh [rama]   # default: main
```

El script realiza: verificación de prerequisitos → git pull → backup de DB → build → `docker compose up -d` → migraciones → verificación de salud.

## SSL / HTTPS

```bash
# Paso 1: obtener certificado Let's Encrypt (nginx debe estar corriendo en HTTP)
bash infra/certbot/init-ssl.sh

# Paso 2: reemplazar nginx.conf con la versión HTTPS
bash infra/certbot/upgrade-to-https.sh

# Paso 3: recargar nginx
docker compose exec nginx nginx -s reload

# Renovación automática: el servicio certbot hace certbot renew cada 12 horas
```

Dominio configurado: `camaras.saa.com.py`. Para cambiar, editar `infra/certbot/init-ssl.sh` y `infra/certbot/upgrade-to-https.sh`.

## Migraciones de base de datos

```bash
# Aplicar migraciones pendientes (safe, no destructivo)
docker compose exec api npx prisma migrate deploy

# Crear nueva migración tras cambios en schema.prisma
docker compose exec api npx prisma migrate dev --name <nombre>

# Ver estado de migraciones
docker compose exec api npx prisma migrate status
```

## Rollback

```bash
# Ver commits disponibles
bash scripts/rollback.sh

# Rollback a un commit específico
bash scripts/rollback.sh <commit_hash>
```

El script pide confirmación, hace checkout del código, rebuild y redeploy. Para rollback de DB, los backups están en `backups/db_backup_YYYYMMDD_HHMMSS.sql`:

```bash
docker compose exec -T postgres psql -U visioncore visioncore_db < backups/db_backup_<fecha>.sql
```

## Verificación post-deploy

```bash
docker compose ps                          # todos los servicios en estado "running"
curl http://localhost/api/health           # debe responder 200
bash scripts/check-nvrs.sh                # estado de los 4 NVRs
docker compose logs -f api --tail 50      # logs del backend
```

## Servicios y puertos internos

| Servicio   | Puerto interno | Expuesto    |
|------------|---------------|-------------|
| postgres   | 5432          | 5432        |
| redis      | 6379          | 6379        |
| mediamtx   | 8554/8888/8889/9997 | idem |
| api        | 4000          | 4000        |
| web        | 80 (interno)  | vía nginx   |
| nginx      | —             | 80, 443     |
