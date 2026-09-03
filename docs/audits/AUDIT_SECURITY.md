# Auditoría de seguridad — VisionCore

> Analista de seguridad (solo lectura). Fecha: 2026-09-03.
> Rama: `claude/multi-agent-project-audit-hf14wq` (estado c22, `0b3c2f8` ≈ `9fbb01f` sobre `main`).
> Alcance: código versionado de `apps/api`, `apps/web` (parcial), docs e infra. NO describe ni autoriza cambios en producción.
> Ninguna evidencia de este informe transcribe secretos: solo `archivo:línea` y tipo.

## Resumen ejecutivo

La postura de seguridad del **plano de aplicación propio es sólida**: RBAC con filtrado por
recurso bien implementado en cámaras/NVR/grabaciones (`userCanAccessCamera` / `userCanAccessNvr`
con filtro por `userPermission` para roles no privilegiados), bcrypt(12) para contraseñas,
rotación de refresh tokens con compare-and-swap + detección de reúso, hashing sha256 de tokens
en DB, TOTP + step-up MFA, cifrado AES de credenciales NVR nunca devuelto al frontend,
enmascaramiento de RTSP en logs, FFmpeg invocado con args en array (sin shell), Prisma con
consultas raw solo vía `Prisma.sql` parametrizado, y un **plano de grants de medios bien
diseñado** (hash-only, comparación timing-safe, uso único atómico, epoch de revocación,
fail-closed). Las flags nuevas están OFF por defecto.

Los riesgos materiales se concentran en tres focos: (1) **dependencias con vulnerabilidades
conocidas** — 10 hallazgos (`npm audit`), 7 de severidad *high*, incluyendo un bypass de path
traversal/route-guard en `@fastify/static` que sirve `/uploads/`; (2) **el plano de medios en
vivo (MediaMTX) no revalida autorización por petición** y los `streamPath` son deterministas y
adivinables, de modo que el RBAC de vista en vivo depende íntegramente de la frontera de red;
(3) **gestión de la clave de cifrado de credenciales NVR** — clave por defecto embebida
`'visioncore_key'` duplicada en 4 archivos, fallback a `JWT_SECRET` (acopla dos secretos) y KDF
débil de `crypto-js`. Además se versionó topología de red interna real en documentación,
violando el invariante #6 del handoff.

No se hallaron: inyección SQL explotable, inyección de comandos, XXE activo (el XML ISAPI se
parsea por regex, no por un parser con expansión de entidades), ni secretos criptográficos
(claves, JWT, contraseñas) transcritos en el repositorio.

## Tabla de hallazgos por severidad

| Sev | Categoría (OWASP/CWE) | Título | Detalle | Evidencia | Recomendación |
|---|---|---|---|---|---|
| **P1** | A06:2021 Componentes vulnerables / CWE-1395 | Dependencias con vulns conocidas (7 high) | `npm audit --omit=dev` reporta 10 vulns (7 high, 3 moderate). Destaca `@fastify/static` **≤10.1.1** con *route guard bypass via path traversal* (GHSA-83w8-p2f5-377r, CVSS 7.5) y *auth bypass via non-canonical URL* — y el API monta `@fastify/static` para servir `/uploads/`. También `find-my-way`, `fast-uri`, `form-data`, `nodemailer`, `axios`, `brace-expansion` (high). | `apps/api/package.json`; `apps/api/src/server.ts:176` (registro static `/uploads/`); salida `npm audit` | Actualizar deps: `@fastify/static`≥10.1.3 (semver-major, revisar breaking), `axios`≥1.18, `nodemailer`, `find-my-way`/`fastify`. Validar en CI. Confirmar que `/uploads/` no permite escapar de `UPLOADS_DIR` tras el fix. |
| **P1** | A01:2021 Broken Access Control / A05 / CWE-284 | RBAC de vista en vivo depende solo de la red; `streamPath` adivinable | MediaMTX acepta `user: any`; la petición HLS/WebRTC posterior **no revalida JWT/permiso**. El `streamPath` es determinista: `nvr_<nvrId>_ch<NN>_sub`. Quien alcance `/hls/` puede reconstruir el path de cualquier cámara y verla sin pasar por RBAC. Contradice el invariante de negocio #2 salvo por firewall/red. Es limitación **documentada y aceptada** (A1/relay autenticado = NO-GO), pero sigue siendo el mayor riesgo residual. | `apps/api/src/services/stream.ts:889-906` (path determinista); `SECURITY.md:158-177`; `docs/security/THREAT_MODEL_NATIVE_MEDIA.md` | Mantener 8554/8888/8889/9997 fuera del firewall (solo red confiable). Priorizar N1 (relay con validación de grants efímeros) antes de exponer clientes nativos. No tratar el path como credencial. Considerar path con componente aleatorio no adivinable como mitigación intermedia. |
| **P2** | A02:2021 Fallos criptográficos / CWE-321, CWE-798 | Clave de cifrado de credenciales NVR embebida y acoplada | Clave por defecto embebida `'visioncore_key'` **duplicada en 4 módulos**; fallback a `JWT_SECRET` cuando `NVR_CREDENTIAL_KEY` no está definido (comprometer JWT_SECRET ⇒ descifra credenciales NVR). Además `crypto-js` `AES.encrypt(plain, passphrase)` usa KDF OpenSSL (MD5, 1 iteración) — débil; librería en modo mantenimiento. | `apps/api/src/services/credentials.ts:8-9`; `apps/api/src/services/nvrSync.ts:64`; `apps/api/src/routes/nvrConfig.ts:14`; `apps/api/src/routes/cameras.ts:16` | Exigir `NVR_CREDENTIAL_KEY` obligatoria (fail-fast si falta, como JWT_SECRET) y eliminar el literal `'visioncore_key'`. Centralizar en `credentials.ts` (los otros 3 lo re-implementan). Migrar a AES-256-GCM nativo (`node:crypto`) con KDF fuerte y clave separada del JWT. |
| **P2** | A05:2021 Misconfiguration / CWE-942 | CORS reflectante con credenciales cuando `CORS_ORIGINS` no está | Si `CORS_ORIGINS` no está definida, `origin: true` refleja cualquier Origin **con `credentials: true`**. Cualquier sitio podría emitir peticiones credenciadas y leer respuestas. Se usan cookies (refresh, `COOKIE_SECURE`), lo que amplía el impacto. | `apps/api/src/server.ts:119-125` | Requerir `CORS_ORIGINS` explícito en cualquier despliegue expuesto; no permitir `origin:true`+`credentials:true`. Fail-fast o degradar a `credentials:false` si la lista está vacía. |
| **P2** | A01/CWE-200 Info disclosure | Topología de red interna real versionada | IPs internas de NVR (p.ej. tres NVR secundarios), su conteo de canales y roles, y un relay SMTP interno sin auth (host:puerto) documentados en el repo. Viola el invariante #6 del handoff ("nunca versionar IPs internas reales"). | `HIKVISION_ISAPI.md:127-129`; `STREAMING.md:23-25`; `NOTIFICATIONS.md:92` | Reemplazar por placeholders (`10.0.0.x`, `nvr-secundario-A`). Purgar del historial si son reales. Revisar que scripts de diagnóstico no impriman topología. |
| **P2** | A10:2021 SSRF / CWE-319 | ISAPI sobre HTTP en claro; destino controlable por ADMIN | El cliente Hikvision usa `http://<ip>:<port>` (no TLS): credenciales Digest y datos viajan en claro por la red interna. `test-connection`/`detect`/`scan` toman `ipAddress` del body (solo ADMIN) ⇒ un ADMIN puede dirigir el servidor a hosts internos arbitrarios (SSRF de privilegio alto). | `apps/api/src/services/hikvision.ts:149-156`; `apps/api/src/routes/nvr.ts:56,115,190` | Documentar/forzar red segmentada NVR↔API. Para el futuro provider Hik-Connect/ISAPI-proxy, aplicar allowlist de destinos, bloquear rangos link-local/metadata (169.254/loopback) y validar egress. |
| **P3** | CWE-208 Timing | Comparación de `METRICS_TOKEN` no timing-safe | El token de `/metrics` se compara con `!==` (los secretos de analytics y media-relay sí usan `timingSafeEqual`). Canal lateral de temporización menor. | `apps/api/src/routes/metrics.ts:103` | Usar `crypto.timingSafeEqual` con longitudes normalizadas (igual que `analytics.ts:120`). |
| **P3** | A01/CWE-613 Sesión | JWT de acceso no refleja cambios de rol/permiso hasta expirar | El RBAC de rutas REST usa `user.role` del JWT (TTL ≤60m). Revocar permisos o degradar rol no invalida el access token vigente; solo el plano de medios tiene `authorizationEpoch`. | `apps/api/src/plugins/auth.ts:88-93`; `middleware/requireAuth.ts:15,43` | Considerar epoch/`tokenVersion` por usuario verificado en `authenticate`, o TTL de acceso más corto para acciones sensibles (ya existe step-up). |
| **P3** | A05/CWE-1021 | CSP con `'unsafe-inline'` en script/style | La CSP de Helmet permite `script-src 'unsafe-inline'`, debilitando la defensa ante XSS. | `apps/api/src/server.ts:106-107` | Migrar a nonces/hashes y quitar `'unsafe-inline'` de `scriptSrc`. |
| **P3** | CWE-1188 | `JWT_REFRESH_SECRET` anunciado pero no usado | El plugin registra `@fastify/jwt` solo con `JWT_SECRET`; los refresh tokens se firman con la MISMA clave pese al warning de arranque que sugiere separación. Impacto bajo: el refresh se valida además contra la sesión en DB (hash), así que un JWT forjado no basta. | `apps/api/src/plugins/auth.ts:57-62`; `apps/api/src/routes/auth.ts:607`; `server.ts:76-78` | Usar realmente un secreto separado para refresh, o eliminar la env var y el warning para no dar falsa sensación de aislamiento. |
| **P3** | CWE-611 (preventivo) | XML ISAPI parseado por regex | El XML de Hikvision se extrae con regex (`xmlGet`/`xmlGetAll`), no con un parser con DTD ⇒ **sin XXE hoy**, pero frágil. El futuro ONVIF/SOAP requerirá un parser real. | `apps/api/src/services/hikvision.ts:186-201` | Al portar ONVIF/SOAP usar un parser con `resolveExternalEntities:false`, sin DTD/DOCTYPE, y límites de tamaño/anidamiento (anti billion-laughs). |
| **P3** | A01/CWE-284 | Test de IDOR ausente y check de acceso NVR laxo | `userCanAccessNvr` acepta cualquier fila de permiso sobre el NVR (no `canView` específico) ⇒ un OPERATOR con solo `canPtz` en una cámara puede leer `device-info`/`storage` del NVR. Falta test automatizado de acceso cruzado (ya señalado en la matriz existente). | `apps/api/src/routes/nvr.ts:267-274`; `docs/security/SECURITY_AUDIT.md:10` | Añadir tests de acceso cruzado por cámara/NVR. Endurecer `userCanAccessNvr` a `canView`. |

## Evaluación del plano de grants de medios y RBAC

**Plano de grants (C22, `services/media/`): diseño robusto.** Verificado en código:
- Secreto de 256 bits (`randomBytes(32)`), almacenado **solo como `sha256`** (`media-grants.ts:29-72`); el secreto viaja una única vez en la emisión.
- Comparación de hash **timing-safe** (`timingSafeEqualHex`, `media-grants.ts:32-35`).
- **Uso único atómico**: `validateAndClaim` lineariza expiración + claim + scope en una transición (Lua/Redis o memoria mono-proceso); replay ⇒ `REPLAYED` (`grant-store`).
- **Revocación durable por epoch** (`revokeAllForUser`/`bumpUserEpoch`) con **fail-closed** ante backend caído (`media-grants.ts:182-195`).
- Scope ligado a `cameraId`/`streamPath`/`mediaInstanceId` server-derivados; el servidor no confía en campos del cliente.
- **Correctamente inerte por defecto**: rutas `mediaGrants` solo se registran con `NATIVE_PLAYBACK_ENABLED=true` (`server.ts:202-204`) y la emisión de relay falla cerrado sin Redis (`GRANT_ATOMICITY_UNAVAILABLE`).

Limitación honesta ya documentada: el relay que valida grants (N1) no está cableado; con
`NATIVE_MEDIA_RELAY_ENABLED=false` el transporte nativo directo sigue deshabilitado — correcto,
porque habilitarlo con MediaMTX `user: any` reintroduciría el P1 de acceso a medios.

**RBAC del plano de aplicación: bien implementado.** Cada ruta sensible filtra por
`userPermission` para roles no privilegiados (`cameras.ts:53-152`, `nvr.ts:237-330`,
`recordings.ts:1394,1443,1493,1578,1991` con `canPlayback`; PTZ con `canPtz` en
`cameras.ts:352`). ADMIN/SUPERVISOR ven todo por diseño (coincide con `SECURITY.md`). Las URLs
de stream devueltas no contienen credenciales NVR. Debilidades: (a) el RBAC en vivo se apoya en
la frontera de red (P1); (b) `userCanAccessNvr` demasiado laxo (P3); (c) sin tests de IDOR (P3).

## Superficie de ataque (SSRF/inyección) de las integraciones ONVIF/Hik-Connect previstas

**Estado actual:** las integraciones ONVIF y Hik-Connect **aún no existen** en el código
(`services/providers/` solo contiene `email.provider.ts`). La superficie real hoy es el cliente
ISAPI Hikvision (`services/hikvision.ts`, `services/nvr-config/hikvision.ts`), cuyos destinos se
derivan de `nvr.ipAddress`/`nvr.port` almacenados en DB (configurables solo por ADMIN).

**Riesgos a prever al portar los patrones externos (prioridad del usuario):**

1. **SSRF (ISAPI-proxy / Hik-Connect):** un proxy que reenvíe rutas o URLs derivadas de input de
   usuario hacia el NVR/nube es el vector más peligroso. Requisitos mínimos: allowlist estricta
   de host/puerto contra la tabla `nvrs`; bloquear `127.0.0.0/8`, `169.254.169.254`,
   `::1`, y redirecciones (`maxRedirects: 0`, ya usado en `hikvision.ts:590`); no permitir que el
   cliente elija el host de destino; validar el esquema (solo `http/https` esperados).
2. **Manejo de secretos del token cloud (Hik-Connect):** el token/refresh cloud debe cifrarse
   igual que las credenciales NVR (tras corregir el P2 de la clave), nunca loguearse ni
   devolverse; TTL corto; y **jamás** incluir credenciales/URLs RTSP en respuestas al frontend
   (mantener el patrón HLS temporal actual).
3. **XXE/inyección XML (ONVIF WS-Discovery/SOAP):** al reemplazar el parseo por regex por un
   parser SOAP, deshabilitar DTD/entidades externas y limitar tamaño/anidamiento.
4. **Inyección de comando/URL en construcción RTSP:** mantener credenciales fuera de logs
   (`maskUrlCredentials` ya existe) y construir URLs sin interpolar input sin validar;
   los `playbackURI` del NVR ya se restringen con `z.string().startsWith('/')`
   (`recordings.ts:1325,1335`) — mantener esa validación al integrar nuevas fuentes.
5. **Transporte en claro:** preferir HTTPS hacia dispositivos donde el firmware lo soporte;
   documentar la segmentación de red como control compensatorio (P2 actual).

## Notas de método

Solo lectura; no se modificó código ni configuración. `npm audit` se ejecutó en
`apps/api` (`--omit=dev`) sin instalar ni actualizar nada. No se ejecutaron servicios, migraciones
ni contenedores. No se accedió a NVR, MediaMTX ni base de datos reales.
