# VisionCore VMS — Guía de Troubleshooting

## NVR aparece online pero cámaras sin señal

**Síntoma:** El NVR responde al healthcheck pero los canales aparecen como offline.

**Causas y soluciones:**

1. La cámara IP no está conectada físicamente al NVR o el cable tiene falla.
2. La cámara fue desactivada en la interfaz web del NVR.
3. El canal en VisionCore no está sincronizado con el NVR:
   ```bash
   # Forzar sincronización de canales desde la UI: NVR → Sync Cameras
   # O verificar directamente vía ISAPI:
   curl -u admin:pass http://192.168.1.10/ISAPI/ContentMgmt/InputProxy/channels
   ```
4. El healthWorker actualiza el estado cada 60 segundos; esperar un ciclo.

---

## RTSP 401 Unauthorized

**Síntoma:** `ffprobe` o MediaMTX reportan error 401 al acceder al stream RTSP.

**Causas:**
- Credenciales incorrectas almacenadas en VisionCore.
- La contraseña del NVR fue cambiada directamente en el dispositivo.
- `NVR_CREDENTIAL_KEY` en `.env` fue modificada después de guardar el NVR (la contraseña AES no puede descifrarse con una clave diferente).

**Diagnóstico:**
```bash
bash scripts/probe-camera.sh 192.168.1.10 1 admin <contraseña> 554
```

**Solución:**
- Actualizar las credenciales del NVR en VisionCore (menú NVRs → Editar).
- Si se cambió `NVR_CREDENTIAL_KEY`, re-guardar todos los NVRs con la nueva clave.

---

## H.265 incompatible con el navegador

**Síntoma:** El stream no se ve en el navegador; ffprobe muestra `codec: hevc`.

**Causa:** Los navegadores no soportan decodificación H.265 en HLS/WebRTC. MediaMTX necesita recibir H.264.

**Solución:** VisionCore usa el substream (`{channel}02`) por defecto, que normalmente es H.264. Verificar y cambiar en el NVR:
- Interfaz web del NVR → Configuración de codificación → Substream → Codec: H.264.

```bash
# Verificar codec del substream:
bash scripts/probe-camera.sh 192.168.1.10 1 admin <pass>
# La línea "Stream secundario" debe mostrar: Codec: h264
```

---

## MediaMTX: "no route" o stream no inicia

**Síntoma:** El frontend muestra error al cargar el stream; los logs de MediaMTX muestran `no route found`.

**Causas y soluciones:**

1. El path no fue registrado en MediaMTX. Los paths se crean al iniciar la API y se re-registran cada 5 minutos:
   ```bash
   docker compose logs mediamtx --tail 30
   docker compose restart api   # fuerza re-registro de paths
   ```

2. Verificar que el path existe en la API de MediaMTX:
   ```bash
   curl http://localhost:9997/v3/paths/list | python3 -m json.tool | grep name
   ```

3. El path tiene `source: publisher` en vez de la URL RTSP. Revisar `infra/mediamtx/mediamtx.yml` — solo el bloque `~^nvr_.*` debe tener `sourceOnDemand`.

---

## HLS 404 al pedir index.m3u8

**Síntoma:** El navegador recibe 404 al pedir `/hls/<path>/index.m3u8`.

**Diagnóstico:**
```bash
# Probar directamente contra MediaMTX (sin nginx):
curl -v http://localhost:8888/<stream_path>/index.m3u8

# Probar a través de nginx:
curl -v http://localhost/hls/<stream_path>/index.m3u8
```

**Causas:**
- El stream aún no inició en MediaMTX (`sourceOnDemand` tarda hasta 15 segundos).
- El nombre del path en la URL no coincide con el registrado (`nvr_<id>_ch<NN>`).
- MediaMTX no está corriendo: `docker compose ps mediamtx`.

---

## WebSocket no conecta (alertas en tiempo real)

**Síntoma:** La campana de alertas no recibe notificaciones; consola del navegador muestra `WebSocket connection failed`.

**Verificaciones:**
```bash
# Verificar que nginx tiene el bloque /ws/ con proxy_set_header Upgrade
docker compose exec nginx nginx -T | grep -A5 "location /ws"

# Logs del API buscando errores de WebSocket
docker compose logs api --tail 50 | grep -i websocket
```

**Causa común:** Proxy timeout. nginx tiene `proxy_read_timeout 3600s` para `/ws/`; si fue modificado, restaurar.

---

## SMTP: las notificaciones de email no se envían

**Diagnóstico completo:**
```bash
export VISIONCORE_TOKEN=<jwt_token>
bash scripts/check-smtp.sh operaciones@empresa.com
```

**Verificaciones manuales:**
1. En la UI: Configuración → Alertas → verificar que "Email habilitado" esté activo.
2. Severidad mínima: si está en `CRITICAL`, no llegarán alertas `MEDIUM` o `HIGH`.
3. Verificar historial de envíos: `GET /api/alerts/settings/deliveries`.
4. Revisar logs del API: `docker compose logs api | grep -i email`.

**Error común: ECONNREFUSED al servidor SMTP**
- Verificar que el host SMTP es alcanzable desde el contenedor `api`:
  ```bash
  docker compose exec api wget -O- http://<smtp_host>:<puerto> 2>&1 | head -5
  ```

---

## Favicon 404

**Síntoma:** El navegador registra `GET /favicon.ico 404`.

**Causa:** El favicon no está en el build del frontend o nginx no sirve archivos estáticos directamente.

**Solución:** Verificar que `apps/web/public/favicon.ico` existe y que el build de Vite lo incluye. Luego reconstruir el contenedor `web`:
```bash
docker compose build --no-cache web && docker compose up -d web
```

---

## Herramientas de diagnóstico general

```bash
# Estado de todos los NVRs
bash scripts/check-nvrs.sh

# Probar RTSP de una cámara específica
bash scripts/probe-camera.sh <ip> <canal> <usuario> <contraseña>

# Verificar MediaMTX
bash scripts/check-mediamtx.sh

# Ver todos los logs en tiempo real
docker compose logs -f

# Reiniciar un servicio específico
docker compose restart <servicio>
```
