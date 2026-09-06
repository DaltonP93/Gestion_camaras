# Evidencia de pruebas — VisionCore

> Actualizado: 2026-09-06. Base: `main` = `0f9d1f5`.
> Clasificación: **TESTED_CI** (corre en `.github/workflows/ci.yml`), **TESTED_LOCAL** (ejecutable
> localmente / ejercido por un auditor sin instalar en prod), **NOT_TESTED** (sin cobertura automatizada).
> No se ejecutaron servicios/contenedores/NVR/DB reales al redactar (solo lectura). Los conteos exactos
> de casos por suite deben confirmarse corriendo la suite; aquí se listan las suites y lo que cubren.

---

## 1. Qué prueba cada suite

### apps/api — Vitest (`npm test`, tras `npm run build`/tsc) — TESTED_CI (job `api`)
Cubre lógica pura y de rutas con dependencias mockeadas. Suites destacadas verificadas en el árbol:
- `routes/rbac-idor.route.test.ts` — regresión IDOR / acceso cruzado por recurso (RBAC).
- `services/stream-manager*.test.ts` — lifecycle, ownership y condiciones de carrera del stream.
- `services/recordings/rtsp-url` — construcción de URL RTSP de grabaciones (lógica pura).
- `services/credentials` — cifrado/descifrado AES-256-GCM versionado.
- `services/media/*` — grants (replay/expiry/epoch/scope), validación no tautológica de scope.
No cubre: I/O real contra NVR/MediaMTX; ciclo de vida en el navegador.

### apps/web — Vitest (`npm test`) + `tsc && vite build` — TESTED_CI (job `web`)
Typecheck + build de producción + tests de unidad de componentes/utilidades. No hay e2e de navegador.

### apps/analytics — unittest (stdlib, sin cv2/onnx) — TESTED_CI (job `analytics`)
`python -m compileall -q app` + `python -m unittest discover -s tests -v`. Suites presentes:
`test_frigate_camera_map.py`, `test_frigate_derive.py`, `test_frigate_ingestor.py`,
`test_frigate_normalize.py`, `test_frigate_snapshot_cap.py`, `test_providers.py`, `test_rules.py`.
Cubre normalización/reglas/ingestor Frigate y providers **sin** dependencias pesadas (cv2/onnx).
El pipeline real (YOLOX/ByteTrack con modelo ONNX) NO se ejercita en tests.

### Mutaciones — `node tools/mutation-run.mjs` — TESTED_LOCAL
**19 mutantes conocidos, 19/19** (referencia: `docs/native/C22_MUTATIONS.md` y correctivos). Valida que
las suites detecten mutaciones en el plano de medios/grants.

### npm audit — TESTED_LOCAL (ejecutado por auditor, sin instalar)
- `apps/api` (`--omit=dev`): **0 vulnerabilidades** (223 deps de prod).
- `apps/web`: **4 vulnerabilidades (2 high, 2 moderate)** — axios (prototype pollution + DoS +
  maxBodyLength/NO_PROXY bypass), form-data (CRLF), react-router (open redirect / constructor injection).

---

## 2. Qué corre CI (`.github/workflows/ci.yml`) — 6 jobs

| Job | Qué hace | Clasificación |
|---|---|---|
| `api` | tsc (build) + vitest | TESTED_CI |
| `web` | tsc && vite build + vitest | TESTED_CI |
| `analytics` | compileall + unittest (sin cv2/onnx) | TESTED_CI |
| `compose` | `docker compose config -q` (sintaxis de composición) | TESTED_CI |
| `analytics-image` | build imagen analytics + smoke import cv2/onnx/supervision | TESTED_CI |
| `licenses` | sin GPL/AGPL en deps de producción | TESTED_CI |

## 3. Qué NO corre CI — NOT_TESTED

| Verificación | Estado | Riesgo |
|---|---|---|
| ESLint / lint | NOT_TESTED | Sin gate de estilo/estático |
| `prisma migrate deploy` contra Postgres real | NOT_TESTED | Migración rota (incl. dupes 0009/0031) no se detecta hasta prod |
| Gate de `npm audit` | NOT_TESTED | Vulns HIGH de web llegan a producción |
| SAST / secret-scan | NOT_TESTED | Sin escaneo estático de seguridad ni de secretos |
| Build-gate de imágenes api/web | NOT_TESTED | Solo `compose config`, no se buildean api/web en CI |
| Escaneo de imágenes (trivy) | NOT_TESTED | Sin escaneo de CVE de imágenes |
| E2E de navegador (Playwright/Cypress) | NOT_TESTED | Sin cobertura end-to-end de UI |
| Backup + restore end-to-end | NOT_TESTED | Scripts existen, nunca ejercitados en CI |
| Arranque real del stack / healthchecks efectivos | NOT_TESTED | Requiere `up` (prohibido sin autorización) |

## 4. Pruebas negativas/adversariales propuestas (NO ejecutar sin autorización)

De AGENTE 4 (seguridad), reproducibles en laboratorio aislado:
1. RBAC live-stream por red: cliente sin JWT alcanza MediaMTX y reconstruye `/<nvr>_ch<NN>_sub/index.m3u8`.
2. IDOR NVR laxo: OPERATOR con solo `canPtz` → `GET /api/nvrs/X` debe dar 403 (hoy pasa; extender `rbac-idor.route.test.ts`).
3. JWT stale de rol: degradar ADMIN→OPERATOR en DB; el token viejo aún ejecuta acciones ADMIN hasta expirar.
4. Reúso de refresh token: fuera de la gracia → revoca familia (`TOKEN_REUSE`); dentro → `TOKEN_ROTATED`.
5. Revocación WS cross-worker: 2 workers, logout en worker A no cierra WS en worker B.
6. XSS → robo de JWT de `localStorage` (CSP como defensa; evaluar cookie httpOnly).
7. SSRF ADMIN vía ISAPI: apuntar `test-connection`/`scan` a `169.254.169.254`/loopback/rangos internos.
8. Grants de medios (flags ON en lab): replay/expiry/epoch/scope/fail-closed sin Redis.
