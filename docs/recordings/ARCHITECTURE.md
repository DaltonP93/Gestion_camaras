# Grabaciones — Arquitectura

Reproducción remota estilo iVMS-4200 sin esperar a generar un MP4 completo.

## Flujo

1. **Búsqueda** (ISAPI): `routes/recordings.ts` + `services/hikvision.ts`
   paginan resultados por cámara y rango (tag `searchResultPostion`, loop en
   `MORE`, fallback por time-chunks). Calendario de días con grabación.
2. **Preview instantáneo** (fMP4 sobre HTTP): FFmpeg lee el RTSP de playback del
   NVR y emite fMP4 vía `reply.hijack()`. Arranca en 1–3 s.
3. **MP4 bajo demanda**: solo al pedir descarga/exportación se genera el MP4
   completo (cache en disco + token de descarga de 24 h en Redis).

## Selección de stream / variantes

`services/recordings/rtsp-url.ts` (helpers puros, testeados):
- Cadena de variantes `main_full → main_no_name_size → sub_full →
  sub_no_name_size` con preferencia por cámara.
- `classifyRtspError`: **453 (límite de sesiones)** se detecta antes que el ruido
  4XX/DESCRIBE; también auth/track/offline/codec.
- Reescritura del `starttime` del playbackURI y enmascarado de credenciales.

## Máquina de estados de reproducción (formal)

```
idle → searching → loading → playing ⇄ paused
                              playing → buffering → playing
                              playing → continuing → loading   (siguiente bloque)
                              loading → no_recording            (hueco)
                              searching → end_of_results
   cualquiera → error | cancelled
```

### Continuidad automática — se dispara por:
- `ended` del `<video>`; o
- **timer esperado** = `clipEnd − effectiveStart` (+margen), re-armado en
  resume/seek/cambio de velocidad, cancelado en pausa/frame-step; o
- **error cerca del final** (dentro de la cola del clip → fin natural).

Considera: siguiente bloque por metadata, `sessionId` vigente, cámara
desmarcada, seek manual del usuario, gap `> CONTINUITY_GAP_MS` → `no_recording`.

## Compartición de streams

Preview/exportación pueden registrarse como consumidor `recording` en el
StreamConsumerRegistry cuando lean vía MediaMTX, para no competir con Live/
Analytics ni provocar borrado de paths (ver `docs/analytics/ARCHITECTURE.md`).

## Límites / requiere SDK nativo (HCNetSDK)

No viables con fMP4/streaming web (documentado, **no** dentro del API principal;
irían en un worker nativo separado):
- reproducción reversa real,
- frame-atrás real,
- decodificación nativa,
- control propietario avanzado,
- reproducción multicanal por SDK.

## Métricas

`visioncore_recordings_preview_sessions`, `visioncore_recordings_vod_sessions`.
