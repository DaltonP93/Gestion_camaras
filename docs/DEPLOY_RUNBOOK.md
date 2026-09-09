# Runbook de despliegue — VisionCore

> Procedimiento reproducible para desplegar `main` en el servidor y verificarlo.
> NO autoriza por sí mismo ningún cambio: `deploy`, `migrate`, `restart` requieren
> autorización expresa del propietario (invariante #7). Este runbook describe los
> pasos; ejecutarlos es una decisión operativa.

## 0. Precondiciones

- Estás en el **servidor** (no en un entorno de CI/sandbox): tiene acceso a la red del
  NVR, a los volúmenes de datos y a los secretos reales.
- `main` está verde en CI. Línea base de esta entrega: los PRs #170–#175 fusionados +
  canales de notificación + redacción de IP en logs de stream.
- Tenés una ventana de mantenimiento acordada (el `up`/`migrate` puede cortar sesiones).

## 1. Backup ANTES de tocar nada

```bash
cd /opt/visioncore
bash scripts/backup.sh          # pg_dump -Fc + sha256 (ver docs/BACKUP_RESTORE.md)
```
Confirmá que el archivo de backup existe y su checksum quedó registrado. Sin backup
verificado, no continúes.

## 2. Traer el código

```bash
git fetch origin main
git checkout main
git pull --ff-only origin main
git log -1 --oneline            # confirmá el HEAD esperado
```

## 3. Verificar el `.env` (sin volcar valores)

- **`NVR_CREDENTIAL_KEY` DEBE ser la misma** que ya usa el servidor. Si cambia, las
  contraseñas de NVR guardadas quedan **ilegibles** y hay que re-ingresarlas.
- `JWT_SECRET` ≥ 32 chars, `POSTGRES_PASSWORD`, `CORS_ORIGINS` reales, `REDIS_URL`.
- Flags que deben quedar **OFF** en esta entrega (hay blockers P0 para lo nativo, ver
  `docs/AI_HANDOFF.md` §12): `NATIVE_PLAYBACK_ENABLED`, `NATIVE_MEDIA_RELAY_ENABLED`,
  `ONVIF_ENABLED`, `HIK_CONNECT_ENABLED`, `FRIGATE_ENABLED`, `ANALYTICS_ALPR_ENABLED`,
  `ANALYTICS_FALL_DETECTION_ENABLED`, `AI_EVENTS_ENABLED`.
- Los canales de notificación (Slack/Teams/Webhook) **no** usan variables de entorno:
  se configuran desde la UI (Configuración → Integraciones) y nacen deshabilitados.

## 4. Build + arranque

```bash
docker compose config -q                      # valida la composición
docker compose build --no-cache api web
docker compose up -d
```

## 5. Migraciones (aditivas)

```bash
docker compose exec -T api npx prisma migrate deploy --schema ../../prisma/schema.prisma
```
Esta entrega incluye migraciones nuevas, **todas aditivas** (columnas/ tablas nuevas con
default, sin borrar datos):
- `0033_media_revoke_outbox` — outbox durable de revocación de grants.
- `0034_notification_channels` — 6 columnas en `alert_settings` (Slack/Teams/Webhook),
  idempotente (`ADD COLUMN IF NOT EXISTS`, defaults `false`/`''`).

Por ser aditivas, el binario anterior sigue funcionando contra el schema nuevo (útil para
rollback de app sin tocar la DB).

## 6. Smoke test (solo lectura, no muta nada)

```bash
BASE_URL=https://TU_DOMINIO \
  SMOKE_USERNAME=admin SMOKE_PASSWORD='...' \
  bash scripts/smoke-test.sh
```
Verifica: `/health`, `/api/health/deep` (DB+Redis), login, `/api/auth/me`,
`/api/nvrs` (listado RBAC). No imprime secretos/tokens/IPs.

## 7. Verificación manual (lo que el smoke NO cubre — requiere navegador + NVR real)

Método invariante #4 (comprobar UI + API + MediaMTX + navegador a la vez; una descarga
exitosa NO prueba que el reproductor HTML5 sea correcto):

1. **Login** en la UI con un usuario real.
2. **RBAC:** un usuario *camera-scoped* ve solo sus cámaras; los endpoints NVR-wide
   (device-info/storage/status) le responden **403**.
3. **Live view** de una cámara en el navegador (HLS reproduciéndose, no solo el manifiesto).
4. **Playback** de una grabación real.
5. **Notificaciones:** en Configuración → Alertas, botón *Enviar prueba* de email; luego
   Configuración → Integraciones, cargar **un** webhook (Slack/Teams/genérico) y disparar
   una alerta de prueba. Confirmar entrega y que el **historial de entregas** NO muestra la
   URL con token (solo `canal · host`).

## 8. Rollback

Si el smoke o la verificación fallan:

```bash
docker compose down
git checkout <commit_anterior>      # p. ej. la línea base previa a esta entrega
docker compose up -d
```
Las migraciones 0033/0034 son aditivas: el binario anterior corre contra el schema nuevo.
Si necesitás la DB exactamente como estaba, restaurá el backup del paso 1:

```bash
bash scripts/restore.sh <archivo_de_backup>   # aborta si el checksum no coincide
```

## 9. Post-deploy

- Revisar logs: `docker compose logs -f api` (buscar errores de arranque; el arranque
  hace fail-fast si falta `JWT_SECRET`/`NVR_CREDENTIAL_KEY`).
- `docker compose ps` — todos los servicios `healthy`.

---

## Pendientes conocidos (NO bloquean el deploy, pero decidir antes de exponer al público)

- **MediaMTX `user: any`** (P1) — **mitigado en el borde**: nginx ahora exige
  `auth_request` en `/hls/` (valida la cookie de sesión + `canView` de la cámara vía
  `GET /internal/hls-auth`) antes de proxyear a MediaMTX. **Requisito operativo:
  MediaMTX debe quedar SOLO-INTERNO** (no publicar los puertos 8888/8889 al exterior;
  el único camino público es nginx). `authInternalUsers: user: any` se mantiene porque
  la creación de paths (API :9997) y el publish de FFmpeg lo necesitan; el control por
  espectador vive en el borde. Rollback: comentar la línea `auth_request` en
  `infra/nginx/nginx.conf`. NOT_VALIDATED extremo-a-extremo sin el stack real
  (nginx+MediaMTX+navegador); el endpoint sí está validado por tests y en staging.
  Notas (auditoría): (a) nginx pasa el path NORMALIZADO (`$uri`) al auth-hook para que
  coincida con lo que sirve MediaMTX (evita confusión de cámara por `..`); el endpoint
  además rechaza `..`. (b) UX: si la cookie de acceso expira MIENTRAS se ve en vivo, los
  segmentos HLS dan 401 hasta que una llamada axios normal refresca la cookie (hls.js no
  refresca solo); en la práctica el refresco ocurre pronto por el heartbeat/polling.
  (c) Rendimiento: el auth-hook hace hasta 2 queries por segmento; con muchos
  espectadores conviene un cache corto por (user,nvr,canal) como follow-up.
- **Hardware:** la integración Hikvision (ISAPI/RTSP) es software real **sin validación con
  equipo** en entornos de desarrollo; el paso 7 es la primera validación real.
- **Backup offsite / RPO-RTO** y **pin de imágenes por digest**: follow-ups de DevOps
  (ver `docs/AI_HANDOFF.md` §7).
