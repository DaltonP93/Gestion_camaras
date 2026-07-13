# VisionCore — Auditoría de seguridad

Estado por control. ✅ implementado · 🟡 parcial/mejorable · ⬜ pendiente.

| Área | Estado | Detalle |
|---|---|---|
| AuthN (JWT + refresh) | ✅ | access/refresh; mutex de refresh en `apps/web/src/lib/api.ts` (un solo refresh activo, reintento único, logout si falla) |
| 2FA TOTP | ✅ | `services/totp.ts` |
| RBAC + permisos por NVR/cámara | ✅ | `middleware/requireAuth`, checks por recurso en rutas |
| IDOR | 🟡 | checks presentes en playback/preview/cámaras; **falta test automatizado** de acceso cruzado |
| Credenciales NVR | ✅ | AES (`services/credentials.ts`), nunca en respuestas ni logs (enmascaradas) |
| Path traversal (descargas) | ✅ | validación de contención real contra CACHE_DIR/VOD_TEMP_DIR |
| Command injection (FFmpeg) | ✅ | args como array (sin shell) |
| SSRF | 🟡 | ISAPI/MediaMTX apuntan a hosts configurados; sin fetch de URLs arbitrarias de usuario |
| Endpoints internos analytics | ✅ | secreto compartido con comparación timing-safe |
| `/metrics` | ✅ | `METRICS_TOKEN` opcional (Bearer/`?token`), sin secretos; advertir si abierto |
| Rate limiting | ✅ | login/reset (`@fastify/rate-limit`) |
| CORS / Helmet | ✅ | `server.ts` (CORS por env, CSP básica) |
| Manejo de errores | ✅ | `setErrorHandler` global: ZodError→400, sin stack al cliente |
| Secretos en logs | ✅ | máscara de RTSP en stream/preview; no se loguean tokens |
| Redis: sin secretos | ✅ | registry/tokens sin credenciales ni URLs RTSP |
| Retención de datos | ✅ | purga diaria de alerts/deliveries/audit/analytics (env-config) |
| Uploads (snapshots) | 🟡 | tamaño/MIME acotados en multipart; snapshots de analítica validados por tamaño |

## Recomendaciones abiertas (no bloqueantes)

1. Tests de permisos/IDOR por cámara y NVR (marcado en la matriz).
2. Rotación documentada de `JWT_SECRET`/`NVR_CREDENTIAL_KEY`/`ANALYTICS_SECRET`.
3. Definir `METRICS_TOKEN` y `CORS_ORIGINS` explícitos en despliegues expuestos.
4. Revisión periódica de `license-checker` en CI (ya presente) al sumar deps.

## Nunca

Registrar contraseñas, tokens, cookies, secretos ni URLs RTSP con credenciales.
Exponer endpoints internos sin secreto o red interna.
