# Auditoría DevOps / SRE — VisionCore

> Solo lectura. Estado auditado: rama `claude/multi-agent-project-audit-hf14wq`,
> commit `0b3c2f8` (c22, equivalente a `9fbb01f` sobre `main`). Fecha: 2026-09-03.
> No se ejecutó `docker compose config` (Docker no disponible en el entorno de
> auditoría); la validación de composición se hizo por lectura estática. El CI sí
> ejecuta `docker compose config -q` en cada push/PR.

## Resumen ejecutivo

La composición Docker es en general sólida: separación por red bridge interna,
bind de PostgreSQL/Redis/API/MediaMTX-API a `127.0.0.1`, healthchecks con
`condition: service_healthy` en `postgres`/`redis`/`api`, y `depends_on` que hace
esperar a nginx hasta que el API esté sano. El pipeline de CI es notablemente
completo (typecheck vía build, tests API/web/analytics, `prisma validate`,
`docker compose config`, build de imagen de analytics con smoke test de imports
nativos y verificación de licencias GPL/AGPL).

Sin embargo hay **varios defectos operativos que rompen garantías que la
documentación afirma tener**, y que son peligrosos precisamente porque fallan en
silencio:

1. **El backup automático de DB está roto** (`pg_dump` apunta a una base
   inexistente) — DEPLOY.md promete backup antes de cada deploy y rollback desde
   esos backups; ninguno existe realmente.
2. **`setup.sh` no genera los secretos JWT** (los patrones `sed` no coinciden con
   el placeholder real de `.env.example`) — la instalación queda con un
   `JWT_SECRET` placeholder conocido y públicamente versionado.
3. **`upgrade-to-https.sh` sobrescribe `nginx.conf`** con una versión que
   reintroduce fugas de tokens en el access log, rompe el preview de grabaciones
   (buffering) y re-expone CORS `*` en HLS.
4. **Puertos de medios de MediaMTX (8554/8888/8889) expuestos a todas las
   interfaces sin autenticación** (`user: any`).
5. **Sin apagado elegante (SIGTERM)** en el API → hooks `onClose` y ciclo de vida
   de FFmpeg no se ejecutan en cada deploy/restart.

Ninguno bloquea el arranque, pero varios comprometen la protección de evidencia
de grabaciones (invariante 1) y el ciclo de vida explícito de FFmpeg
(invariante 5) que el propio proyecto declara como no negociables.

## Hallazgos por severidad

| Sev | Área | Título | Detalle | Evidencia | Recomendación |
|---|---|---|---|---|---|
| P1 | Backups | Backup automático de DB apunta a base inexistente | `pg_dump ... visioncore` pero la base es `visioncore_db`. El error se suprime con `2>/dev/null` y se degrada a un `warn` ("puede ser primera vez"). El archivo `.sql` queda vacío/ausente. DEPLOY.md afirma que el deploy hace backup y que el rollback restaura desde él. | `scripts/deploy.sh:60`; base real en `docker-compose.yml:8,79`; promesa en `DEPLOY.md:54,120-126` | Corregir a `pg_dump -U visioncore visioncore_db`; quitar `2>/dev/null`; abortar el deploy si el backup falla y tiene datos. |
| P1 | Secretos | `setup.sh` no genera los secretos JWT (sed sin efecto) | Los `sed` buscan `cambiar_este_secreto_por_uno_muy_largo_y_aleatorio` y `cambiar_este_refresh_secreto_tambien`, cadenas que **no existen** en `.env.example` (el placeholder real es `cambiar_por_clave_segura_minimo_32_caracteres`, y no hay línea `JWT_REFRESH_SECRET`). El instalador reporta "Secrets JWT generados ✓" pero el `.env` conserva el placeholder versionado. | `setup.sh:50-54` vs `.env.example:5` | Alinear el patrón `sed` con la clave real (o mejor, generar el `.env` por reemplazo de línea `^JWT_SECRET=`); validar post-condición de que el valor cambió. |
| P1 | Red / MediaMTX | Puertos de medios sin auth expuestos a toda interfaz | `8554` (RTSP), `8888` (HLS), `8889` (WebRTC) se publican como `"8554:8554"`… (0.0.0.0) mientras MediaMTX corre con `user: any` con permisos `read/publish/playback/api`. Cualquiera con acceso de red al host puede leer o **publicar** (overridePublisher) cualquier path. Choca con la restricción dura del brief (relay = NO-GO mientras exista `user: any`). | `docker-compose.yml:53-56`; `infra/mediamtx/mediamtx.yml:18-24,86-90` | Bind de HLS a `127.0.0.1` (solo nginx lo consume vía red docker); RTSP/WebRTC solo si se exponen deliberadamente, idealmente tras auth por path; nunca dejar `publish` global. |
| P1 | Nginx / SSL | `upgrade-to-https.sh` sobrescribe `nginx.conf` con una config regresiva | El heredoc reemplaza el archivo endurecido por uno que: (a) vuelve a `log_format` con `$request` completo → **fuga de JWT** en query (`?token=`) en el access log; (b) **elimina** `location /api/recordings/preview/` con `proxy_buffering off` → preview fMP4 en blanco; (c) reañade `Access-Control-Allow-Origin *` en `/hls/` (incompatible con `withCredentials`, y deshace el `proxy_hide_header`); (d) elimina `/uploads/` y los bloques de seguridad (`/\.`, rutas de ataque); (e) baja `proxy_read_timeout` de `/api/` a 60s. | `infra/certbot/upgrade-to-https.sh:17-131` vs `infra/nginx/nginx.conf:25-27,74-104,142-181` | No regenerar el archivo; mantener un único `nginx.conf` versionado con dos `server{}` (80/443) y activar HTTPS por variable/inclusión. Nunca duplicar la config en un script. |
| P2 | Ciclo de vida | Sin apagado elegante (SIGTERM/SIGINT) del API | No hay `process.on('SIGTERM'…)` ni `server.close()`. `dumb-init` reenvía SIGTERM a Node, que sale de inmediato sin ejecutar los hooks `onClose` (p.ej. `srcPoller.stop()`) ni drenar Fastify. En cada `restart`/deploy los FFmpeg/preview en curso quedan huérfanos en vez de cerrarse por su ruta terminal. Afecta invariante 5. | `apps/api/src/server.ts:284,292` (onClose registrado pero nunca disparado); ausencia confirmada por grep | Registrar SIGTERM/SIGINT → `server.close()` con timeout; asegurar que la terminación de FFmpeg corre en el path de cierre. |
| P2 | CI | Backup/aplicación real de migraciones no se prueba; sin lint | CI hace `prisma validate` (schema) pero **no** aplica `migrate deploy` contra una DB real (no hay `services: postgres`), por lo que un SQL de migración roto no se detecta hasta producción. Tampoco corre ESLint (no existe script `lint` en `apps/web` ni `apps/api`). | `.github/workflows/ci.yml:23-35`; `apps/web/package.json` (sin `lint`) | Añadir job con `services.postgres` que ejecute `migrate deploy` + `migrate status`; añadir lint. |
| P2 | Resiliencia | Migraciones solo hacia adelante, sin backup pre-migrate en el arranque | El `CMD` del contenedor corre `prisma migrate deploy` antes de `node dist/server.js` en cada arranque, sin backup previo. No hay migraciones `down`; un rollback de código no revierte el schema. `rollback.sh` reconoce que la DB requiere restauración manual. | `apps/api/Dockerfile:47`; `scripts/rollback.sh:64` | Backup automático (funcional) inmediatamente antes de `migrate deploy`; documentar procedimiento de rollback de schema. |
| P2 | Backups | Sin backups programados ni retención/offsite | El único backup es el (roto) de `deploy.sh`, disparado a mano. No hay cron de `pg_dump`, ni copia fuera del host, ni política de retención. PostgreSQL es un contenedor único con un volumen único (punto único de fallo para metadatos de evidencia). | `docker-compose.yml:3-23,249`; no hay job de backup en `apps/api/src/jobs/` | Cron de backup con retención y copia offsite; considerar réplica/WAL archiving para la evidencia. |
| P2 | SSL | Certbot renueva pero no recarga nginx | El loop del servicio `certbot` corre `certbot renew` cada 12h pero **nunca** recarga nginx tras una renovación exitosa. El cert renovado no se sirve hasta un reinicio/reload manual → riesgo de expiración en producción. | `docker-compose.yml:246`; único reload manual en `init-ssl.sh:51` | Añadir `--deploy-hook` que ejecute `nginx -s reload` (o un contenedor que señalice a nginx). |
| P2 | Reproducibilidad | Imágenes con tags flotantes (`latest`) | `bluenviron/mediamtx:latest` y `certbot/certbot:latest` no están fijadas. Un `pull` futuro puede introducir cambios de comportamiento (MediaMTX es crítico para streaming). | `docker-compose.yml:46,240` | Fijar versiones exactas y actualizar deliberadamente. |
| P2 | Healthchecks | Servicios críticos sin healthcheck | `mediamtx`, `web` y `analytics` no tienen healthcheck. nginx solo espera a que `mediamtx`/`web` estén "started", no listos → posibles 502/HLS 404 transitorios en el arranque. `analytics` descarga el modelo desde GitHub en el primer arranque (dependencia externa en runtime) sin healthcheck ni reintento visible. | `docker-compose.yml:44-62,174-183,187-211,231-234` | Añadir healthchecks (MediaMTX `/v3/config/global/get` en :9997; web `/`; analytics `/status`); precachear el modelo en la imagen. |
| P3 | Consistencia | Dos scripts de deploy divergentes | `deploy.sh` (raíz, 20 líneas: pull, build sin `--no-cache`, sin backup) coexiste con `scripts/deploy.sh` (completo). DEPLOY.md referencia `scripts/deploy.sh`. Además `scripts/deploy.sh:124` sondea salud en `localhost:3000` (el API es 4000). | `deploy.sh:1-20`; `scripts/deploy.sh:124` | Eliminar el `deploy.sh` raíz o convertirlo en wrapper; corregir el puerto de health. |
| P3 | Observabilidad | `/metrics` abierto por defecto | Con `METRICS_TOKEN` vacío (default), `/metrics` queda sin auth asumiendo red interna; solo se registra un `warn`. Las métricas no filtran secretos (verificado: solo conteos/estados), riesgo bajo, pero expone topología. | `apps/api/src/routes/metrics.ts:94-106`; `docker-compose.yml:136` | Documentar que en prod debe fijarse `METRICS_TOKEN` o restringir el path en nginx (ya bloquea `/actuator` pero no `/metrics`). |
| P3 | Secretos | Defaults inseguros en compose | `JWT_SECRET` cae a `visioncore_default_dev_secret_change_in_production_32c` y `POSTGRES_PASSWORD` es `visioncore_pass` hardcodeado. El API solo *advierte* (no aborta) si `JWT_SECRET` es corto o falta `NVR_CREDENTIAL_KEY`. Con #P1-secretos, el fallback conocido puede quedar activo. | `docker-compose.yml:83,10,79`; `apps/api/src/server.ts:72-84` | Exigir `JWT_SECRET` sin fallback (fallar si ausente); parametrizar `POSTGRES_PASSWORD` por env. |
| P3 | Seed | Credenciales por defecto fijas siempre | El seed crea `admin/Admin123!`, `supervisor/Super123!`, etc. sin guardar por `NODE_ENV`, y el deploy lo ejecuta. Documentado ("cambia las contraseñas"), pero es un default predecible en producción. | `apps/api/src/seed.ts:71-122`; `setup.sh:121-127` | Forzar cambio de contraseña en el primer login o exigir contraseña de admin por env en el seed. |

## Estado de CI/CD y validaciones automáticas

Pipeline en `.github/workflows/ci.yml` (push a `main`, todos los PR, dispatch):

- **api**: `npm ci` → `prisma validate` + `prisma generate` → `npm run build`
  (equivale a `tsc`, cubre typecheck) → `npm test` (vitest). Bien.
- **web**: `npm ci` → `npm test` → `npm run build` (`tsc && vite build`, incluye
  typecheck). Bien.
- **analytics**: `compileall` + `unittest` (tests puros sin cv2/onnx).
- **compose**: `docker compose config -q` (valida sintaxis de la composición).
- **analytics-image**: build de la imagen con smoke test de imports nativos.
- **licenses**: bloquea GPL/AGPL en dependencias de producción.

Fortalezas: buena cobertura de typecheck y tests en las tres apps, validación de
composición y de licencias, y verificación de dependencias nativas de analytics.

Brechas: (1) **sin ESLint** en ninguna app; (2) las migraciones **no se aplican**
contra una DB real en CI (solo `validate` del schema) → un `.sql` de migración
inválido no se detecta; (3) sin escaneo de secretos/SAST; (4) sin gate sobre la
imagen del API (solo se buildea implícitamente vía compose config, no se corre).
Las migraciones tienen prefijos numéricos duplicados (`0009`, `0031`)
documentados como seguros (tocan tablas distintas; el orden es lexicográfico por
nombre completo) — correcto, pero conviene un test de `migrate deploy` que lo
verifique en limpio.

CD: `scripts/deploy.sh` (build `--no-cache` de api/web, up, espera de postgres,
`migrate deploy`, verificación) y `rollback.sh` (checkout de commit, rebuild,
redeploy; DB manual). Son scripts manuales ejecutados en el servidor, no un
pipeline de despliegue automatizado — aceptable para el tamaño, pero el backup
roto (P1) invalida la red de seguridad que ambos asumen.

## Riesgos operativos y de resiliencia

1. **Pérdida de evidencia sin red de seguridad**: PostgreSQL es un único
   contenedor/volumen, sin backups funcionales (P1), sin cron, sin offsite y con
   migraciones solo-hacia-adelante. Un fallo de disco o una migración defectuosa
   compromete metadatos de grabaciones (invariante 1) sin vía de recuperación
   comprobada.
2. **FFmpeg/MediaMTX huérfanos en cada deploy**: la falta de apagado elegante
   (P2) hace que `restart`/deploy maten Node sin cerrar procesos hijos por su
   ruta terminal, contrario al ciclo de vida explícito de FFmpeg (invariante 5).
3. **Superficie de medios abierta**: puertos MediaMTX sin auth en todas las
   interfaces (P1) permiten lectura y publicación de streams por cualquiera con
   acceso de red; `overridePublisher: yes` agrava el riesgo de secuestro de path.
4. **Regresión latente al activar HTTPS**: correr el flujo documentado
   (`upgrade-to-https.sh`) rompe el preview de grabaciones y reintroduce fuga de
   JWT en logs (P1) — el daño ocurre exactamente al pasar a producción.
5. **Renovación TLS sin recarga** (P2): el cert se renueva pero nginx sigue
   sirviendo el viejo hasta reinicio manual → outage por expiración probable a
   los ~90 días si nadie reinicia nginx.

Otros: healthchecks faltantes en MediaMTX/web/analytics (arranque frágil,
502/HLS 404 transitorios); dependencia de GitHub en runtime para el modelo de
analytics; tags `latest` no reproducibles; dos scripts de deploy divergentes.

## Política de auditoría de dependencias (CI, c23 hito 7)

El job `audit` de `ci.yml` corre `scripts/check-npm-audit.sh` sobre `apps/api` y
`apps/web`:

- `npm audit --omit=dev`: **sólo dependencias de PRODUCCIÓN**. Una vulnerabilidad
  en devDependencies (build/test) **no** bloquea el pipeline.
- **Umbral de severidad**: sólo `HIGH`/`CRITICAL` bloquean. `low`/`moderate` se
  reportan pero no frenan.
- **Allowlist de deuda conocida** (por nombre de paquete): `axios`, `form-data`.
  Son HIGH prod transitivos **pre-existentes** en `apps/web` detectados el
  2026-09-06; no rompen CI hoy pero deben remediarse (actualización planificada
  del árbol de `apps/web`). Cualquier paquete de producción **nuevo** con
  HIGH/CRITICAL, fuera del allowlist, **falla** el job.

El allowlist vive en `scripts/check-npm-audit.sh` (variable `ALLOWLIST`) y es por
nombre de paquete a propósito: los IDs GHSA rotan con cada advisory nuevo.

## Verificación de integridad del modelo de analytics (c23 hito 7)

`apps/analytics/app/providers/yolox_onnx.py` descargaba `yolox_s.onnx` de GitHub
en runtime sin verificación. Ahora, tras la descarga, se verifica el **SHA-256**
conocido (`app/model_verify.py`); si no coincide, se borra el archivo y la carga
del provider falla en vez de ejecutar un binario no verificado. El hash esperado
es la constante `EXPECTED_MODEL_SHA256` en `config.py`, override por env
`MODEL_SHA256` (vacío = omitir verificación con warning explícito, sólo para
modelos propios). Hash del `yolox_s.onnx` oficial (release 0.1.1rc0):
`c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`.
