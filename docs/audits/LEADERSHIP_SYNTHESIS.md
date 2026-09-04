# Síntesis del Líder — Ciclo 1 de auditoría multi-agente

> Fecha: 2026-09-03 · Rama: `claude/multi-agent-project-audit-hf14wq`
> Base auditada: estado **c22** (equivalente a `9fbb01f`) sobre `main` (620c893).
> Verificación de base: **API 60 archivos / 988 tests ✅**, tsc limpio, prisma OK ·
> **native 6 archivos / 37 tests ✅**, tsc limpio.

Fuentes: `AUDIT_DEV_ARCH.md`, `AUDIT_DEVOPS.md`, `AUDIT_SECURITY.md`,
`PROJECT_DOCUMENTATION.md`.

## Veredicto general

La base c22 es **sólida y bien probada**. El plano de grants de medios está
notablemente bien diseñado (hash-only, timing-safe, uso único atómico, epoch,
fail-closed, inerte por defecto). Con las flags OFF el comportamiento equivale a
C21. El riesgo real **no está en producción hoy** (casi todo lo nuevo está tras
flags OFF), sino en **deuda a cerrar antes de encender el plano nativo** y en
**endurecimiento operativo/dependencias** que sí aplica al despliegue actual.

## Riesgos consolidados (deduplicados y priorizados)

### P0 — ninguno bloqueante en el estado actual (flags OFF).

### P1 — cerrar pronto

| # | Área | Riesgo | Evidencia | Acción | ¿Decisión humana? |
|---|------|--------|-----------|--------|-------------------|
| 1 | Seguridad/deps | 7 vulnerabilidades high; `@fastify/static` ≤10.1.1 path-traversal y el API sirve `/uploads/` | `apps/api/src/server.ts:176` + `npm audit` | Bump de dependencias + verificar en CI | No — fix seguro |
| 2 | Grants/RBAC | `retryPendingUserRevokes` no cableado a reconexión Redis; revocación durable se pierde tras outage → grants viejos re-validan | `services/media/grant-service.ts:68-95`, `plugins/redis.ts` | Cablear a `redis.on('ready')` + barrido periódico | No — robustez tras flags |
| 3 | Seguridad/red | RBAC de live-view depende solo de la red (MediaMTX `user: any`, streamPath adivinable) | `services/stream.ts:889-906` | Es la limitación A1 (relay NO-GO) | **Sí** — confirmar rumbo A1 |
| 4 | DevOps/evidencia | Backup de DB roto (`visioncore` vs `visioncore_db`, errores silenciados); DEPLOY.md promete rollback inexistente | `scripts/deploy.sh:60` | Corregir nombre DB, no silenciar, abortar si falla | No — bugfix de script |

### P2 — endurecimiento

| # | Área | Riesgo | Evidencia | ¿Decisión? |
|---|------|--------|-----------|-----------|
| 5 | Seguridad | Clave de cifrado NVR literal `'visioncore_key'` + fallback a `JWT_SECRET` + KDF débil | `credentials.ts:8-9`, `nvrSync.ts:64`, `nvrConfig.ts:14`, `cameras.ts:16` | **Sí** — hacer `NVR_CREDENTIAL_KEY` obligatoria cambia arranque |
| 6 | Seguridad | CORS reflectante con credenciales cuando `CORS_ORIGINS` no está (`origin:true`+`credentials:true`) | `server.ts:119-125` | No — endurecer default |
| 7 | Grants | `issueGrant` no atómico (awaits secuenciales, sin MULTI/pipeline) | `grant-store.ts:243-250` | No |
| 8 | Grants | Retiro espurio de instancias: `/v3/paths/list` sin paginación tratada como verdad | `source-lifecycle.ts:146-164` | No |
| 9 | Seguridad/docs | Topología interna versionada (IPs NVR, roles, SMTP interno) — viola invariante #6 | `HIKVISION_ISAPI.md:127-129`, `STREAMING.md:23-25`, `NOTIFICATIONS.md:92` | No — redactar |
| 10 | DevOps | `setup.sh` no genera `JWT_SECRET` (sed no coincide con placeholder) | `setup.sh:50-54`, `.env.example:5` | No — bugfix |
| 11 | DevOps/red | Puertos MediaMTX 8554/8888/8889 en 0.0.0.0 sin auth | `docker-compose.yml:53-56`, `infra/mediamtx/mediamtx.yml` | **Sí** — toca infra |
| 12 | DevOps | Sin apagado elegante (SIGTERM) → procesos FFmpeg huérfanos en cada deploy | `server.ts:284,292` | No — robustez |
| 13 | Grants | Sesión única best-effort por proceso, sin `forget()` en logout | `session-policy.ts:22-52` | No (solo si va a prod) |

### P3 — menores

| # | Riesgo | Evidencia |
|---|--------|-----------|
| 14 | Verificación de scope tautológica en `/internal/media-grant/validate` | `routes/mediaGrants.ts:111-118` |
| 15 | `upgrade-to-https.sh` regresiona `nginx.conf` (reintroduce fuga JWT en logs, CORS `*`) | `infra/certbot/upgrade-to-https.sh` |
| 16 | Certbot renueva pero no recarga nginx; tags `latest` no reproducibles; healthchecks faltantes | `docker-compose.yml` |

## Plan de acción (directivas a devs)

**Workstream A (Dev 1) — Seguridad y robustez, sin decisión humana:**
- A1. Bump de dependencias vulnerables (empezando por `@fastify/static`≥10.1.3).
- A2. Apagado elegante SIGTERM/SIGINT → `server.close()` + cierre de FFmpeg.
- A3. Redactar topología interna de la doc (invariante #6).
- Compuerta: `npm audit`, `tsc --noEmit`, `vitest run` en verde antes de commit.

**Workstream B (Dev 2) — Robustez del plano de grants, tras flags:**
- B1. Cablear `retryPendingUserRevokes` a `redis.on('ready')` + barrido.
- B2. `issueGrant` atómico (MULTI/pipeline o Lua).
- B3. Paginar/`/v3/paths/list` y tratar lista truncada como no-verdad en `reconcile`.
- B4. Fix de verificación de scope (P3-14).
- Compuerta: misma que A, más las 19 mutaciones (`tools/mutation-run.mjs`).

**Workstream C (posterior, prioridad del usuario) — Nuevas integraciones tras flags:**
- C1. Service ONVIF (núcleo testeable: builders/parsers SOAP, WS-Discovery, GetStreamUri, PTZ; I/O inyectable). Flag OFF.
- C2. Provider Hik-Connect (token cloud + HLS temporal + ISAPI-proxy). Cuidar **SSRF** y tratar AppKey/SecretKey como secreto. Flag OFF.

**Bugfixes DevOps de script (sin ejecutar):** backup DB (P1-4), `setup.sh` (P2-10).

## Decisiones que requieren al humano (elevadas por separado)

1. **Prioridad**: ¿arrancar por la deuda de seguridad/robustez (A+B) o por las
   integraciones ONVIF/Hik-Connect (C)? Recomendación: A+B primero (pequeño,
   de-riesga todo), C en paralelo con el 2º dev.
2. **Exposición de MediaMTX** (P1-11/P2): ¿autorizás atar los puertos a
   127.0.0.1 en `docker-compose.yml` (nginx los alcanza por la red docker)?
   Toca infra. Recomendación: sí, es el mayor endurecimiento de superficie.
3. **Clave de cifrado NVR** (P2-5): ¿hacer `NVR_CREDENTIAL_KEY` obligatoria con
   fail-fast en producción? Cambia el arranque. Recomendación: sí, con
   compatibilidad en dev (warning) y obligatoria en prod.
4. **Rumbo A1** (P1-3): el RBAC de live-view solo por red y el límite de 2
   transcodes se resuelven de fondo con el relay autenticado A1, hoy NO-GO.
   ¿Mantener NO-GO o autorizar un plan de diseño (sin habilitar) para cerrarlo?

## Estado del equipo

- Escuadra de auditoría (4 agentes solo-lectura): **completada**.
- Documentación integral: **completada** (`docs/PROJECT_DOCUMENTATION.md`).
- Devs (2): pendientes de arrancar sobre A/B (independientes de las decisiones).
- Líder: este documento; elevación de 4 decisiones al humano.
