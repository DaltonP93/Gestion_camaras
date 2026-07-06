# Plan técnico — Modos alternativos de Remote Playback (NO implementado)

Este documento diseña dos caminos futuros para reproducir grabaciones cuando
el flujo actual (ISAPI + RTSP playbackURI + FFmpeg fMP4) no alcance.
**Ninguno de los dos está implementado** — el flujo HTML5 actual sigue siendo
el principal y no debe reemplazarse.

Referencias estudiadas (no incluidas en el repo por licencia):
- KVision (GPLv3, C++/Qt): `hikvisionisapi.cpp`, `hikvisionarchiveplayer.cpp`,
  `hikvisiondownloader.cpp`, `HCNetSDK.h`
- Hikvision WebSDK V3.3.1: `webVideoCtrl.js`, `demo.js`

De estas referencias ya se **adoptó la lógica** (no el código) en el backend:
- Búsqueda ISAPI paginada: `maxResults=1000`, tag `searchResultPostion` (sic),
  loop con `responseStatusStrg=MORE`, dedupe, fallback por chunks de tiempo.
- Calendario de disponibilidad: `POST /ISAPI/ContentMgmt/record/tracks/{id}/dailyDistribution`.
- Reescritura de `starttime` en playbackURI para arrancar en el playhead.

## Opción A — Worker nativo HCNetSDK (Linux)

Servicio separado, NUNCA dentro de `apps/api` (node:alpine no tiene glibc y
las `.so` de Hikvision requieren entorno glibc tipo Debian/Ubuntu):

```
services/hikvision-sdk-worker/     # C++ (SDK Linux x64), imagen debian-slim
```

Endpoints internos (red Docker, sin exposición pública):

| Endpoint | SDK usado |
|---|---|
| `POST /sdk/login` | `NET_DVR_Login_V40` (pool de sesiones por NVR) |
| `POST /sdk/search` | `NET_DVR_FindFile_V40` + `NET_DVR_FindNextFile_V50` |
| `POST /sdk/playback/start` | `NET_DVR_PlayBackByTime_V40` + `NET_DVR_SetPlayDataCallBack_V40` → el callback entrega PS-stream, se re-empaqueta a fMP4 (ffmpeg pipe) y se sirve igual que el preview actual |
| `POST /sdk/playback/:id/control` | `NET_DVR_PlayBackControl_V40` (pause/resume/speed) |
| `DELETE /sdk/playback/:id` | `NET_DVR_StopPlayBack` |
| `POST /sdk/download` | `NET_DVR_GetFileByTime_V40` (exportación exacta) |

Ventajas: no depende del RTSP playbackURI (evita los 401 por track), velocidad
de reproducción server-side, descarga exacta por tiempo.
Riesgos: licencia de redistribución del SDK (validar antes de commitear las
`.so`), estabilidad del SDK en contenedor, un canal de fallo más.

Activación propuesta: `RECORDINGS_ENGINE=isapi|sdk` por NVR, con fallback a
ISAPI si el worker no responde.

## Opción B — "Hikvision WebSDK Windows Mode" (opcional, cliente)

Modo alternativo del frontend que usa el plugin oficial (`HCWebSDKPlugin.exe`
+ `webVideoCtrl.js`) para clientes Windows con el plugin instalado:

- Detección: si `window.WebVideoCtrl` inicializa → ofrecer el modo.
- El plugin habla directo con el NVR (login ISAPI del navegador al NVR), por
  lo que requiere visibilidad de red del cliente al NVR — no pasa por la API.
- NO se agrega el plugin ni `jsVideoPlugin` al bundle principal; se cargaría
  desde `/public/websdk/` solo cuando el usuario active el modo.
- Es un modo de contingencia para operadores en Windows; el flujo HTML5
  actual queda como predeterminado para todos los demás.

## Decisión

Quedarse en ISAPI/RTSP/FFmpeg mientras cubra los casos. Escalar a la Opción A
solo si aparecen NVRs cuyos tracks RTSP de playback están deshabilitados o
limitados (síntoma: categoría `RTSP_AUTH_OR_TRACK_DENIED` persistente en los
logs `[recordings-preview] ffmpeg_failed`).
