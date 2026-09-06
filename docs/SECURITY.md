# Seguridad — VisionCore (documento canónico consolidado)

> Actualizado: 2026-09-06 (ciclo C23). Base: `main` = `0f9d1f5` (INTACTO; nada del C23 fusionado).
> Los riesgos abajo son el estado **de `main`**; donde un PR Draft C23 los aborda se marca "(#N, Draft — NO en `main`)":
> el riesgo sigue vigente en `main` hasta que se fusione. Fuente: AGENTE 4 (auditoría de seguridad)
> verificada contra código. Sin secretos/IPs reales (solo `archivo:línea` y tipo).
> Consolida y reemplaza como entrada canónica a: raíz `SECURITY.md` (stale: describe cifrado con
> crypto-js/fallback JWT_SECRET, ya superado por AES-256-GCM), `docs/security/SECURITY_AUDIT.md` (tabla
> de controles — anexo), `docs/audits/AUDIT_SECURITY.md` (histórico ciclo 1) y
> `docs/security/THREAT_MODEL_NATIVE_MEDIA.md` (modelo de amenazas de medios — anexo, NO duplicar).

---

## 1. Postura actual

El plano de aplicación propio es **sólido** y mejoró de forma medible respecto al ciclo previo:
- **Deps:** `apps/api` `npm audit --omit=dev` = **0 vulnerabilidades**; `@fastify/static 10.1.3`
  (parche path-traversal GHSA-83w8-p2f5-377r); `axios ^1.20`, `fastify ^5.12`, `nodemailer ^9.1`.
- **CORS:** sin `CORS_ORIGINS` solo permite localhost; con la env, allowlist explícita (`lib/cors-config.ts:40-62`).
- **CSP:** `scriptSrc 'self'` (sin `unsafe-inline`), `scriptSrcAttr 'none'` (`lib/security-headers.ts:26-37`);
  `unsafe-inline` residual solo en `styleSrcElem/styleSrcAttr` (theming en runtime, documentado, aceptado).
- **Cifrado credenciales NVR:** **AES-256-GCM + scrypt** con formato versionado (`services/credentials.ts`);
  `NVR_CREDENTIAL_KEY` obligatoria en producción (fail-fast, `credentials.ts:37-44`); literal legacy solo
  para descifrado, nunca para cifrar.
- **Métricas:** comparación timing-safe del `METRICS_TOKEN` (`routes/metrics.ts:107`).
- **AuthN/sesiones:** rotación de refresh con CAS atómico + detección de reúso + revocación de familia
  (`routes/auth.ts:589-673`); tokens hasheados sha256 en DB; bcrypt(12); lockout configurable; MFA TOTP
  obligatoria por política totalmente cableada; rate-limit Redis global + por-ruta.
- **Plano de medios C22 (`services/media/*`):** hash-only, uso único atómico (Lua/Redis), epoch durable
  fail-closed, scope server-derivado; inerte por defecto (flags OFF).
- **Topología interna:** IPs de NVR y relay SMTP reemplazados por placeholders en la doc versionada.

---

## 2. Top riesgos vigentes

| # | Sev | Riesgo | Evidencia | Estado |
|---|---|---|---|---|
| 1 | **P1** | **RBAC de live view depende de la frontera de red.** MediaMTX acepta `user: any`; HLS/WebRTC no revalida JWT; `streamPath` determinista ⇒ quien alcance `/hls/` reconstruye cualquier cámara | `services/stream.ts` (path determinista); `THREAT_MODEL_NATIVE_MEDIA.md` | PRESENTE (documentado/aceptado; relay autenticado = NO-GO). Mayor riesgo residual real |
| 2 | **P1** | **Vulns HIGH en `apps/web`** (axios prototype-pollution/DoS/bypass; form-data CRLF) + moderate react-router. CI no las bloquea | `apps/web/package.json`; `npm audit` | PRESENTE en `main`. **#172 (Draft) resuelve 5/6 HIGH; queda 1 HIGH = `vite` (solo dev-server, requiere major) → follow-up** (NO en `main`) |
| 3 | **P1** | **SSRF en ISAPI Hikvision.** `ipAddress` del body (solo ADMIN) sin allowlist ⇒ SSRF a hosts internos/metadata; además HTTP en claro (Digest sin TLS) | `services/hikvision.ts:150-156`; `routes/nvr.ts` (test-connection/detect/scan) | PRESENTE en `main`. **#171 (Draft): SSRF profundo — `maxRedirects:0` en clientes ISAPI, `/scan` rechaza redes reservadas, IP-literal-only anti-rebinding, metadata de proveedor bloqueada** (NO en `main`) |
| 4 | **P1/P3** | **`userCanAccessNvr` laxo:** acepta cualquier fila de permiso sobre el NVR (sin `canView`) ⇒ un OPERATOR con solo `canPtz` lee device-info/storage | `routes/nvr.ts:267-274` (vs `middleware/requireAuth.ts:18` que sí exige `canView`) | PRESENTE en `main`. **#171 (Draft): RBAC centralizado en `services/access-policy.ts`, `GET /api/nvrs` con `canView`, scoping por cámara/NVR** (NO en `main`) |
| 5 | **P2** | **JWT de acceso en `localStorage`/`sessionStorage`** ⇒ exfiltrable por XSS | `apps/web/src/lib/api.ts:16,27`; `stores/authStore.ts:51` | PRESENTE. Mitigado por CSP; no es cookie httpOnly |
| 6 | **P3** | **Token del WS viaja en la URL** (`/ws/alerts?token=<JWT>`) ⇒ fuga por history/referrer/logs | `routes/websocket.ts:117-121` | PRESENTE. Mitigado: redacción en logs propios |
| 7 | **P3** | **JWT no refleja cambios de rol/permiso hasta expirar** (sin tokenVersion/epoch contra DB en el plano API) | `plugins/auth.ts:65-83`; `middleware/requireAuth.ts` | PRESENTE. Mitigado por TTL corto + step-up + cierre WS + epoch de medios |
| 8 | **P3** | **Revocación de WS solo in-process** (Map local; multi-worker no cierra sockets cross-worker) | `routes/websocket.ts:85-100`; `routes/auth.ts:691` | PRESENTE (grants de medios SÍ cross-worker; WS no). Nota: commit `b2a3f88` en rama sin PR cierra WS al revocar, pero sigue por-proceso |
| — | P3 | `JWT_REFRESH_SECRET` declarado y no usado (refresh se firma con `JWT_SECRET`) | `plugins/auth.ts:57-62`; `server.ts:84-86` | PRESENTE. Impacto bajo (refresh validado contra sesión hasheada) |
| — | P3 | XML ISAPI parseado por regex (sin XXE hoy, frágil para SOAP futuro) | `services/hikvision.ts` | PRESENTE (preventivo) |

---

## 2.1 Contrato RBAC de alertas (observación de Codex #169, verificada — inequívoco)

Para evitar ambigüedad en el próximo agente:
- **Lectura / listado / resumen** de alertas y eventos (`GET /api/alerts`, `/summary`, `/unread`, etc.):
  **todos los roles autenticados**, pero **estrictamente limitados a su scope `canView`** (ADMIN sin
  restricción; el resto solo alertas de sus cámaras + alertas sin `cameraId`) — `resolveAlertScope`, `routes/alerts.ts:16-37`.
- **Resolución** (`PUT /api/alerts/:id/resolve`): **SOLO ADMIN/SUPERVISOR** —
  `preHandler: server.authorize(['ADMIN','SUPERVISOR'])` (`routes/alerts.ts:122`). Un **OPERATOR o AUDITOR
  NO puede resolver ni una alerta de una cámara que sí puede ver.** (Además, dentro de ADMIN/SUPERVISOR, un
  SUPERVISOR queda acotado a su `canView`.) No es un bug: es el contrato vigente. Documentarlo así para no
  "corregirlo" por error hacia un modelo más laxo.

## 3. Reconciliación (sección 7 del mandato)

RESUELTO / PRESENTE / PARCIAL / N-A, con evidencia:

| Ítem del mandato | Estado | Evidencia |
|---|---|---|
| Revalidación WS postergable | **PARCIAL** | Token verificado 1 vez al conectar; revocación cierra socket (`websocket.ts:85-100`) pero solo in-process |
| Sesión no vinculada a JWT `sub` | **RESUELTO** | Refresh embebe `sub`, guardado hasheado; access derivado de `session.user` (`auth.ts:607,884-905`) |
| Asserts `or True`/permisivos | **N/A** | Idiom Python; repo TypeScript |
| Credenciales demo conocidas | **RESUELTO** | Admin: `SEED_ADMIN_PASSWORD` o aleatorio fuerte (`seed.ts:82`); DEMO gateado por `SEED_DEMO_USERS` |
| Secretos inseguros por defecto | **RESUELTO (residual dev)** | `JWT_SECRET` fail-fast <32; `NVR_CREDENTIAL_KEY` obligatoria en prod; fallback solo dev/test |
| PIN en texto plano | **N/A** | No existe control de acceso/PIN |
| JWT en localStorage | **PRESENTE** | Riesgo #5 |
| Token WS en URL | **PRESENTE** | Riesgo #6 |
| Falta CSRF | **N/A / mitigado** | Modelo bearer (token en header/body); sin cookie de sesión del API |
| Falta rate limiting | **RESUELTO** | Global 600/min + por-ruta, store Redis (`server.ts:142-168`) |
| Falta MFA | **RESUELTO** | TOTP + política `mfaRequired` con gracia/enrolamiento (`auth.ts:135-368`, `services/totp.ts`) |
| Falta Redis Pub/Sub | **PARCIAL** | Grants de medios cross-worker (Redis); WS revocation in-process (riesgo #8) |
| Falta doble aprobación | **N/A** | No existe apertura remota |
| Sesiones activas tras suspender empresa | **N/A** | Sin multi-tenant/Company |
| Revocaciones sincronizadas con placa | **N/A** | Sin control de acceso; `LicensePlateEvent` es ANPR de video |
| Anti-passback / interlock / multicard | **N/A** | Sin control de acceso físico |
| Asistencia con TZ/turnos nocturnos | **N/A** | Sin módulo de asistencia |
| Ausencia backup/restore | **PRESENTE (DevOps)** | Sin `pg_dump`/`pg_restore` automatizado; ver `docs/BACKUP_RESTORE.md` |
| Ausencia E2E | **PRESENTE (parcial)** | Sin e2e de navegador; IDOR sí tiene test (`rbac-idor.route.test.ts`) |
| Driver UDP experimental | **N/A** | Transporte RTSP→MediaMTX |
| Eventos físicos / controladora física | **N/A** | Sistema VMS |

---

## 4. Pruebas negativas propuestas (reproducibles, NO ejecutar sin autorización)

Ver `docs/TEST_EVIDENCE.md §4`. Prioritarias: (1) RBAC live-stream por red, (2) IDOR NVR laxo,
(3) JWT stale de rol, (4) reúso de refresh, (5) revocación WS cross-worker, (6) XSS→robo de JWT,
(7) SSRF ADMIN vía ISAPI, (8) grants de medios (flags ON en lab).

## 5. Anexos (no duplicar)

- `docs/security/SECURITY_AUDIT.md` — tabla de controles ✅/🟡/⬜ (anexo).
- `docs/security/THREAT_MODEL_NATIVE_MEDIA.md` — modelo de amenazas del plano de medios.
- Raíz `SECURITY.md` — **stale** (crypto-js/fallback); mantener solo como referencia histórica hasta
  actualizar o degradar. La descripción vigente del cifrado es la §1 de este documento (AES-256-GCM).
