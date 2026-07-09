# Auditoría de licencias — VisionCore SAA

Última revisión: 2026-07-09 (rama `claude/debug-chat-history-X0TND`).
Objetivo: uso comercial cerrado sin obligaciones copyleft fuertes (GPL/AGPL).

## Resultado

✅ **Sin dependencias GPL ni AGPL en producción.** Verificado con
`license-checker --production` en `apps/api` y `apps/web` (los únicos
"UNKNOWN/UNLICENSED" son los paquetes privados del propio proyecto).

## Resumen por componente

| Componente | Licencia | Nota |
|---|---|---|
| Node deps API (Fastify, Prisma, zod, crypto-js…) | MIT / ISC / Apache-2.0 / BSD / BlueOak | 223 paquetes, todos permisivos |
| Node deps Web (React, Vite, axios, zustand…) | MIT / ISC / BSD / Apache-2.0 | 148 paquetes, todos permisivos |
| Roboflow Supervision | MIT | tracking, zonas, anotación |
| YOLOX (código y pesos ONNX, Megvii) | Apache-2.0 | detector — elegido A PROPÓSITO en vez de ultralytics |
| ONNX Runtime | MIT | inferencia CPU/GPU |
| OpenCV / opencv-python-headless | Apache-2.0 | captura RTSP + JPEG |
| FastAPI / Uvicorn / httpx / numpy / pydantic | MIT / BSD-3 | servicio analytics |
| PostgreSQL | PostgreSQL License (permisiva) | |
| Redis 7.x | BSD-3-Clause | (8.x cambió a AGPL/RSAL dual — quedarse en 7.x o migrar a Valkey BSD si se actualiza) |
| MediaMTX | MIT | |
| Nginx | BSD-2-Clause | |
| FFmpeg (binario del sistema) | LGPL-2.1+ (build típico con GPL si incluye libx264) | Se invoca como PROCESO EXTERNO (spawn), no se enlaza como librería: no contamina el código propio. No distribuimos el binario modificado. |

## Reglas para mantener esto limpio

1. **NUNCA agregar `ultralytics` (YOLOv8/v11)** — es AGPL-3.0: obligaría a
   liberar todo el código del sistema o comprar licencia comercial de
   Ultralytics. Los modelos alternativos Apache-2.0 (YOLOX, RT-DETR de
   Baidu/PaddleDetection, D-FINE) cubren lo mismo vía ONNX.
2. No actualizar Redis a 8.x sin revisar licencia (dual RSAL/SSPL/AGPL);
   alternativa drop-in: Valkey (BSD-3).
3. Antes de agregar una dependencia nueva, correr:
   ```bash
   npx license-checker --production --csv | grep -iE "agpl|,GPL" | grep -v LGPL
   ```
   (también corre en CI — el job falla si aparece GPL/AGPL).
4. Los pesos de modelos también tienen licencia: usar solo pesos publicados
   bajo Apache-2.0/MIT (los de YOLOX en los releases de Megvii lo son).
