# VisionCore — Desarrollo local

Guía general de desarrollo/mantenimiento (no específica de ningún servidor).

## Requisitos

- Node.js 20+ (CI usa 22), npm.
- Python 3.11 (para `apps/analytics`).
- PostgreSQL y Redis (locales o vía `docker-compose`).
- FFmpeg (grabaciones/transcode) y MediaMTX (restream) para el flujo de video.

## Estructura

- `apps/api` — Fastify + Prisma. `apps/web` — React + Vite.
- `apps/analytics` — FastAPI + IA. `prisma` — schema + migraciones.

## API

```bash
cd apps/api
npm ci
npx prisma generate --schema ../../prisma/schema.prisma
npm run build        # tsc
npm test             # vitest
npm run dev          # tsx watch
```

Migraciones: son **aditivas**. Validar con
`npx prisma validate --schema ../../prisma/schema.prisma`. No renombrar/eliminar
columnas sin migración segura.

## Web

```bash
cd apps/web
npm ci
npm run build        # tsc + vite (incluye typecheck)
npm test             # vitest
npm run dev
```

## Analytics (Python)

```bash
cd apps/analytics
python -m compileall app                 # syntax
python -m unittest discover -s tests     # tests puros (sin cv2/onnx)
# con dependencias completas:
pip install -r requirements-dev.txt
pytest -q
```

Correr sin modelo real: `ANALYTICS_PROVIDER=mock`.

## Variables de entorno relevantes (ver `.env.example`)

- API: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `NVR_CREDENTIAL_KEY`, `CORS_ORIGINS`, `MEDIAMTX_URL`, `ANALYTICS_SECRET`,
  `ANALYTICS_URL`, `ANALYTICS_MEDIAMTX_RTSP`, `ANALYTICS_ALLOW_DIRECT_RTSP`,
  `METRICS_TOKEN`, retención (`*_RETENTION_DAYS`).
- Analytics: `API_BASE_URL`, `ANALYTICS_SECRET`, `ANALYTICS_PROVIDER`,
  `MODEL_PATH`, `INPUT_SIZE`, `ANALYTICS_FALL_DETECTION_ENABLED`,
  `ANALYTICS_ALPR_ENABLED`.

## Validación antes de commitear

```bash
(cd apps/api && npm run build && npm test)
(cd apps/web && npm run build && npm test)
(cd apps/analytics && python -m compileall app && python -m unittest discover -s tests)
```

## Convenciones

- Commits pequeños y temáticos; no mezclar cambios no relacionados.
- Reutilizar servicios/componentes/modelos existentes; no duplicar.
- Sin dependencias GPL/AGPL (CI lo verifica).
- Documentar lo que requiere modelo externo o SDK nativo; no afirmar validación
  en producción sin pruebas reales.
