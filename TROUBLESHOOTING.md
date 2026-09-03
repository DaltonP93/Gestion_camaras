# VisionCore VMS — Solución de Problemas

## 1. NVR online pero cámara sin señal

**Síntoma:** El NVR responde al healthcheck pero los canales aparecen offline o sin imagen.

**Diagnóstico:**
```bash
bash scripts/probe-camera.sh <ip_nvr> <canal> <usuario> <contraseña>
# Verificar directamente vía ISAPI:
curl --digest -u <usuario>:<contraseña> http://<ip_nvr>/ISAPI/ContentMgmt/InputProxy/channels
```

**Causas comunes:**
- La cámara IP está desconectada físicamente del NVR o el canal no fue asignado
- El canal en VisionCore no coincide con el número real del NVR — usar "Sync Cameras" en la UI
- La cámara usa H.265 y el navegador no lo puede decodificar (ver sección 3)
- El healthWorker actualiza el estado cada ~60 segundos; esperar un ciclo completo

---

## 2. RTSP 401 — Autenticación fallida

**Síntoma:** `ffprobe` o los logs de MediaMTX reportan `401 Unauthorized`.

```bash
bash scripts/probe-camera.sh <ip_nvr> <canal> <usuario> <contraseña>
# Prueba directa con curl:
curl -v --digest -u <usuario>:<contraseña> http://<ip_nvr>/ISAPI/System/deviceInfo
```

**Causas:**
- Contraseña incorrecta guardada en VisionCore — actualizar en UI: NVRs → Editar
- La contraseña del NVR fue cambiada directamente en el dispositivo
- La clave `NVR_CREDENTIAL_KEY` en `.env` fue modificada — las contraseñas AES guardadas ya no pueden descifrarse

> Si `NVR_CREDENTIAL_KEY` cambia, todas las contraseñas NVR deben re-ingresarse manualmente desde la UI.

---

## 3. H.265 / HEVC — Video no se reproduce en el navegador

**Síntoma:** Stream conecta pero muestra pantalla negra; `ffprobe` indica `codec: hevc`.

**Causa:** Los navegadores no decodifican H.265 en HLS. MediaMTX retransmite sin transcodificar.

**Solución:**
- En la interfaz web del NVR: Configuración de codificación → Substream → cambiar a H.264
- Verificar codec actual:
```bash
bash scripts/probe-camera.sh <ip_nvr> 1 <usuario> <contraseña>
# La línea "Stream secundario" debe mostrar: Codec: h264
```

VisionCore usa el substream (`{canal}02`) por defecto, que normalmente ya es H.264.

---

## 4. MediaMTX — "no route" / stream no inicia

**Síntoma:** El frontend falla al cargar el stream; logs de MediaMTX muestran `no route found`.

```bash
docker compose logs mediamtx --tail 30
# Listar paths registrados:
curl http://localhost:9997/v3/paths/list | python3 -m json.tool | grep name
```

**Causas:**
- El path no fue registrado — reiniciar el API fuerza el re-registro:
  ```bash
  docker compose restart api
  ```
- El contenedor `mediamtx` no alcanza la IP del NVR (verificar `extra_hosts` en compose):
  ```bash
  docker compose exec mediamtx sh -c "nc -zv <ip_nvr> 554"
  ```
- El bloque `~.*` en `mediamtx.yml` tiene `source: publisher` y captura paths `nvr_*` antes del bloque correcto

---

## 5. HLS 404 al pedir index.m3u8

**Síntoma:** El reproductor HLS recibe 404 al pedir `/hls/<path>/index.m3u8`.

```bash
# Probar directo contra MediaMTX (sin nginx):
curl -v http://localhost:8888/<stream_path>/index.m3u8

# Probar a través de nginx:
curl -v http://localhost/hls/<stream_path>/index.m3u8
```

**Causas:**
- El stream aún no inició — `sourceOnDemandStartTimeout: 15s`, esperar hasta 15 segundos
- El nombre del path en la URL no coincide con el registrado (debe ser `nvr_<cameraId>`)
- `hlsAlwaysRemux: yes` debe estar activo en `mediamtx.yml`
- MediaMTX no está corriendo: `docker compose ps mediamtx`

---

## 6. WebSocket no conecta — alertas en tiempo real no llegan

**Síntoma:** La campana de alertas no recibe notificaciones; consola muestra `WebSocket connection failed`.

```bash
# Verificar que nginx tiene el bloque /ws/ con Upgrade
docker compose exec nginx nginx -T | grep -A8 "location /ws"

# Logs del API
docker compose logs api --tail 50 | grep -i websocket
```

**Causas comunes:**
- El `proxy_read_timeout` para `/ws/` debe ser `3600s`; si fue reducido, restaurarlo
- Un balanceador externo no soporta WebSocket — agregar soporte de upgrade en el LB
- El JWT expiró; el frontend debe reconectarse con un token fresco

---

## 7. SMTP — Correos de alerta no se envían

```bash
export VISIONCORE_TOKEN=<token_admin>
bash scripts/check-smtp.sh operaciones@empresa.com
```

**Verificar en la UI:** Configuración → Alertas → Email

**Causas comunes:**
- `emailEnabled: false` — habilitar en la UI
- Severidad mínima en `CRITICAL` — alertas `HIGH` no se enviarán
- Campo destinatarios vacío
- Puerto SMTP (587/465) bloqueado por el servidor — probar desde el contenedor:
  ```bash
  docker compose exec api wget -O- telnet://<smtp_host>:<puerto> 2>&1 | head -3
  ```

Historial de envíos: `GET /api/alerts/settings/deliveries`

---

## 8. Favicon 404

**Síntoma:** El navegador registra `GET /favicon.ico 404`.

**Causa:** El favicon no está en el build del frontend o el contenedor `web` no se reconstruyó.

```bash
# Verificar que el archivo existe en el build
docker compose exec web ls /usr/share/nginx/html/ | grep favicon

# Reconstruir si no está
docker compose build --no-cache web && docker compose up -d web
```

---

## Comandos de diagnóstico rápido

```bash
docker compose ps                          # estado de todos los servicios
docker compose logs -f api --tail=50       # logs recientes del API
docker compose logs -f mediamtx --tail=50  # logs de MediaMTX
bash scripts/check-nvrs.sh                 # ping + ISAPI a los 4 NVRs
bash scripts/check-mediamtx.sh             # estado de MediaMTX
curl http://localhost:9997/v3/paths/list   # streams activos en MediaMTX
curl http://localhost/api/health           # health check del API
```
