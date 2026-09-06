# Despliegue — VisionCore (canónico consolidado)

> Actualizado: 2026-09-06. Base: `main` = `0f9d1f5`. Consolida raíz `DEPLOY.md`,
> `docs/frigate/DEPLOYMENT.md` y los hallazgos de la auditoría DevOps (AGENTE 2).
> No autoriza despliegue: cualquier `up`/`migrate`/`restart`/`down` en entorno no local requiere
> aprobación expresa. No hay despliegue verificado desde este entorno.

---

## 1. Prerrequisitos

- Docker Engine 24+ y Docker Compose v2.
- Dominio con DNS al servidor (para HTTPS).
- Acceso de red a los NVRs (LAN de cámaras).
- Puertos al host: **80, 443** (nginx) y **554** (RTSP). Los de MediaMTX **8554/8888/8889/9997 están
  atados a `127.0.0.1`** en el compose — NO abrirlos al exterior. ⚠ El viejo `DEPLOY.md §132-142` los
  listaba como expuestos ("idem"/"9997"); es **stale** y contradice el bind a loopback: no abrir esos puertos.

## 2. Variables de entorno (de `.env.example`; SIN valores)

**Obligatorias en producción** (fail-fast o comportamiento inseguro si faltan):

| Variable | Rol | Nota |
|---|---|---|
| `POSTGRES_PASSWORD` | Password de Postgres | Sin default (ya corregido) |
| `JWT_SECRET` | Firma JWT | Fail-fast si <32 chars (`server.ts:80-96`) |
| `NVR_CREDENTIAL_KEY` | Clave AES-256-GCM de credenciales NVR | Obligatoria en prod (`credentials.ts:37-44`). Si cambia, las credenciales NVR quedan ilegibles |
| `SEED_ADMIN_PASSWORD` | Password del admin sembrado | Si falta, se genera aleatorio fuerte (`seed.ts:82`) |
| `CORS_ORIGINS` | Allowlist de orígenes | Sin ella, solo se permite localhost (no refleja origin arbitrario) |

Otras: `REDIS_URL`, `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `COOKIE_SECURE` (`true` solo con HTTPS),
`ANALYTICS_SECRET`, `METRICS_TOKEN`, retenciones `*_RETENTION_DAYS`, tuning `RECORDINGS_*`/`CAMERA_STREAM_*`.
Flags de integración/nativo OFF por defecto: `ONVIF_ENABLED`, `HIK_CONNECT_ENABLED`, `FRIGATE_ENABLED`,
`NATIVE_PLAYBACK_ENABLED`, `NATIVE_MEDIA_RELAY_ENABLED`, `ANALYTICS_ALPR_ENABLED`, `AI_EVENTS_ENABLED`.

> `SEED_DEMO_USERS` gatea la creación de usuarios demo — dejarlo apagado en prod (evita passwords conocidos).

## 3. Despliegue

```bash
git clone <repo> /opt/visioncore && cd /opt/visioncore
cp .env.example .env            # completar §2
bash setup.sh                   # genera secretos por reemplazo de línea + verificación post-condición
bash scripts/deploy.sh main     # RECOMENDADO: backup pre-deploy + build + migrate + verificación
```
Paso a paso equivalente:
```bash
docker compose build --no-cache api web
docker compose up -d
docker compose exec -T api npx prisma migrate deploy
docker compose exec -T api npx tsx apps/api/src/seed.ts
```

> ⚠ **Usar `scripts/deploy.sh`, NO el `deploy.sh` de la raíz.** El de la raíz (18 líneas) no hace backup,
> buildea sin `--no-cache` y ejecuta `migrate deploy 2>/dev/null || true`, **silenciando fallos de
> migración**. `scripts/deploy.sh` sí hace backup y aborta si el backup falla (`scripts/deploy.sh:58-67`).
> Backlog P1: quitar el silenciado del `deploy.sh` raíz o eliminarlo.

## 4. HTTPS (Let's Encrypt)

```bash
# editar server_name en infra/nginx/nginx.conf
bash infra/certbot/init-ssl.sh          # nginx debe estar en HTTP
bash infra/certbot/upgrade-to-https.sh  # ya NO regenera nginx: solo valida + reload
docker compose exec nginx nginx -s reload
# luego: COOKIE_SECURE=true en .env + docker compose restart api
```
nginx recarga sola cada ~6h para tomar certs renovados (`docker-compose.yml:342`).

## 5. Migraciones

- `docker compose exec api npx prisma migrate deploy` (solo-hacia-adelante; sin `down`).
- **34 directorios** en `prisma/migrations/` con **prefijos duplicados `0009_*` y `0031_*`** y **sin
  `migration_lock.toml`** (ver `prisma/migrations/README.md`). El `migrate deploy` corre en el arranque
  del contenedor (`apps/api/Dockerfile`). Rollback de schema = manual (psql); un rollback de código NO
  revierte la DB.
- ⚠ CI **no** aplica migraciones contra Postgres real (`ci.yml` sin `services: postgres`) — una migración
  rota no se detecta hasta el arranque real.

## 6. Verificación post-deploy

```bash
docker compose ps
curl http://localhost/api/health
docker compose logs -f api --tail 50
```
Servicios esperados: `postgres`, `redis`, `mediamtx`, `api`, `web`, `nginx`, `certbot` (+ `analytics`,
`frigate` según profile). Healthchecks presentes en todos; nginx espera `service_healthy` de api+web.

## 7. Imágenes (pin y reproducibilidad)

`postgres:16.4-alpine`, `redis:7.4-alpine`, `bluenviron/mediamtx:1.9.3`, `frigate 0.14.1`,
`nginx:1.27-alpine`, `certbot v3.0.1`; build api/web `node:20-alpine`, analytics `python:3.11-slim`.
⚠ Sin digest `@sha256:`; api/web usan `npm install` (no `npm ci`) ⇒ builds no reproducibles (backlog P2);
el modelo de analytics se descarga de GitHub en el primer arranque (dep externa en runtime, sin checksum).

## 8. Qué valida CI y qué NO

Valida (6 jobs): `api` (tsc+vitest), `web` (tsc+build+vitest), `analytics` (compileall+unittest),
`compose` (`docker compose config -q`), `analytics-image` (build+smoke import), `licenses` (sin GPL/AGPL).
**No** valida: lint, `migrate deploy` real, gate de `npm audit`, SAST/secret-scan, build-gate de api/web,
escaneo de imágenes, e2e, backup/restore. Detalle en `docs/TEST_EVIDENCE.md`.

## 9. Rollback

```bash
bash scripts/rollback.sh <commit>   # checkout + rebuild + redeploy
# DB: restaurar manualmente desde backups/db_backup_YYYYMMDD_HHMMSS.sql (ver docs/BACKUP_RESTORE.md)
```

## 10. Advertencias operativas (resumen)

- **Sin backup programado/offsite; RPO/RTO indefinidos** — invariante #1 en riesgo. Ver `docs/BACKUP_RESTORE.md`.
- `deploy.sh` raíz peligroso (silencia migración) — usar `scripts/deploy.sh`.
- Migraciones solo-hacia-adelante; CI no las prueba contra DB real; `migration_lock.toml` ausente.
- MediaMTX `user: any` (mitigado por loopback); relay autenticado = NO-GO.
- Despliegue = 1 proceso Node; escalado horizontal NO configurado (jobs in-process se duplicarían).
