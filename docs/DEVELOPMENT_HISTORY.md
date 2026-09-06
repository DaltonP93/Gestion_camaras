# Historia de desarrollo — VisionCore

> Actualizado: 2026-09-06 (ciclo C23). Base: `main` = `0f9d1f5` (INTACTO; nada del C23 fusionado —
> ver §2.5). Reconstruido de `git log` de `main` y de los
> documentos de trabajo (`docs/native/*`, `docs/audit*`, `phase-a1-*`). Sin transcripciones de chat.
> "Qué pidió el propietario → qué se implementó → PR/commit → tests → qué quedó incompleto/reemplazado."

---

## 1. Línea de tiempo de PRs fusionados a `main` (#159–#168)

Merge commits verificables en `git log` de `main`:

| PR | Merge commit | Contenido | Estado / notas |
|---|---|---|---|
| #159 | `e612350` | A1: invalidación por epoch de viewport | Aislamiento de cambios de viewport |
| #160 | `ad4d4da` (2026-08-19) | A1: transición de viewport atómica (token por transacción) | Base citada por el handoff anterior |
| #161 | `620c893` | Lifecycle de live view C1–C20 auditado sobre main (`b00bbc5`) + entrypoints de Claude Code | Rama `codex/a1-c20-audited-main` |
| #162 | `6e5bb09` | **Lote grande multi-agente:** import c22 (`0b3c2f8`), Ciclo 1 de robustez, ONVIF (`ece5524`), Hik-Connect (`3ade2f5`), Frigate ingestor (`fe02f2d`), grants de medios atómicos (`8f4dc95`,`a58bd4f`,`0a93c27`,`5b6ab8f`), relay A1·F0 (`a8570ed`,`7091b13`,`70780a8`), **AES-256-GCM credenciales** (`08682bf`), fix backup deploy.sh (`450e254`), MediaMTX loopback (`be4b230`), apagado elegante (`ffcf089`), bump de deps API a 0 vulns (`a1bc7a8`) | El PR de mayor alcance del historial reciente |
| #164 | `1d5454f` | Ciclo 2 de robustez: bundle seguro + infra/CORS/defaults (`a40000c` sin defaults inseguros Postgres/admin, `7fc780f` CORS, `0e650e3`/`973ab41`/`66594b8` infra, `7a3b2fb` pin de imágenes) | — |
| #166 | `28039bc` | Sub-lote de robustez: seed DEMO gateado (`1b44ff6`), rate-limit Redis (`a683bc2`), **test IDOR** (`3f473c5`), CSP estricta (`326b3f5`), scope de alerts por `canView` (`96de362`) | — |
| #168 | `0f9d1f5` | Scope de eventos de analítica por cámara/`canView` (`dbb3a9d`, `a7abaea`) | **Tip actual de `main`** |

Notas: los números de PR #163, #165, #167 no aparecen como merge commits en el log de `main`
(probablemente squash/cerrados sin merge o de otra rama); no se los describe para no inventar.

## 2. Trabajo pendiente SIN fusionar y SIN PR

Rama `claude/multi-agent-project-audit-hf14wq`, 3 commits por delante de `main` (estado
"pendiente en rama, sin PR" — **NO forma parte de `main`**):

| Commit | Cambio | Observación |
|---|---|---|
| `b2a3f88` | feat(ws): cerrar conexiones WebSocket al revocar permisos | Aborda el riesgo de revocación WS in-process (parcial: sigue por-proceso) |
| `2e11493` | chore(compose): healthcheck de MediaMTX con variante `-ffmpeg` | En `main` la imagen es `bluenviron/mediamtx:1.9.3` (sin `-ffmpeg`) |
| `0df8886` | docs: cerrar 2 pendientes menores | Documental |

## 2.5 Ciclo C23 (2026-09-06) — PRs Draft, NADA fusionado a `main`

> **`main` sigue INTACTO en `0f9d1f5`.** Todo el C23 vive en PRs **Draft** OFF de `main` (`OPEN_PR_DRAFT`).
> No confundir "PR existe" con "está en `main`". Diferenciar siempre: *merged* ≠ *Draft* ≠ *simulado*
> (mock/in-memory) ≠ *NOT_VALIDATED* (real no ejercido) ≠ *PLANNED*.

| PR | Rama | Head | Hito | Contenido | Validación real / límites |
|---|---|---|---|---|---|
| **#171** | `fix/nvr-ssrf-authz` | `6e633df` | Hito 1 | SSRF profundo (`maxRedirects:0` en clientes ISAPI, `/scan` rechaza redes reservadas, IP-literal-only anti-rebinding, metadata de proveedor bloqueada) + RBAC centralizado (`services/access-policy.ts`, `GET /api/nvrs` con `canView`, `video-audio[/:channel]`, scoping por cámara/NVR) | vitest **1342**, mutación **19/19**; tests conductuales con **servidor HTTP real** + `fastify.inject` |
| **#173** | `fix/grant-plane-c23` | `ab5a48b` | Hito 2 | Tiempo atómico Redis (`redis.call('TIME')`), outbox de revocación durable (migración `0033_media_revoke_outbox`, fail-closed `REVOKE_PENDING`), readiness por path unificada (`grant-derivation.ts`) | vitest **1295**, mutación **19/19**; **Redis real validado** (grants/revocación/readiness). Atomicidad Postgres `SKIP LOCKED` = **NOT_VALIDATED** (sin servidor PG) |
| **#174** | `fix/ops-backup-ci-c23` | `fe51727` | Hito 7 | `deploy.sh` fail-fast; backup/restore **validado real** contra **Postgres efímero**; guard CI de prefijos de migración; `npm ci` en Dockerfiles; job CI de `npm audit` prod; checksum sha256 del modelo YOLOX | analytics **93/93**; backup/restore ejercido contra PG efímero. `npm ci` fija deps npm, **NO** las imágenes base por digest |
| **#172** | `fix/web-deps-high` | `e82bb28` | deps web | 5/6 vulns HIGH de `apps/web` resueltas | **1 HIGH pendiente = `vite` (solo dev-server, requiere major)** → follow-up |
| **#170** | `docs/state-reconstruction` | — | Hito 8 | Docs canónicos (ESTE PR) | — |
| **#169** | `docs/update-ai-handoff-pr-168` | — | — | Handoff auto-generado (2 observaciones de Codex) | **SUPERSEDED por #170** (ver abajo) |

**Hitos NO ejecutados en C23 (`PLANNED`, pendientes de decisión de foco):** Hito 3 (relay A1 real),
Hito 4 (cliente nativo Tauri), Hito 5 (E2E web), Hito 6 (IA productiva). No hay código de estos en
ningún PR C23; no describirlos como "en progreso".

**#169 SUPERSEDED por #170.** El handoff auto-generado #169 queda **`SUPERSEDED`** por este PR (#170):
sus 2 observaciones válidas de Codex se incorporaron a los docs canónicos —
(i) resolución de alertas = **solo ADMIN/SUPERVISOR** (lectura = todos los roles dentro de su `canView`),
(ii) las imágenes base **flotan y NO están pinneadas por digest** (`npm ci` de #174 fija deps, no imágenes).
**Cerrar #169 requiere autorización expresa del propietario — no cerrarlo automáticamente.**

## 3. Ciclos de auditoría multi-agente (contexto)

- **Ciclo 1** (`docs/audits/*`, base `0b3c2f8`, 2026-09-03): brief compartido + reportes Dev/Arch,
  Seguridad, DevOps + síntesis del líder. Fusionado dentro de #162.
- **Ciclo 2 de robustez** (`docs/audits/ROBUSTNESS_CYCLE2.md`, 2026-09-04): correcciones de infra/CORS/
  defaults. Fusionado en #164/#166.
- **Auditoría "sistema actual"** (`docs/audit/*`, base `c4d7c72`): `CURRENT_SYSTEM_AUDIT`, `FEATURE_MATRIX`,
  `MISSING_FEATURES`, `TECHNICAL_DEBT` — histórico, superado por los canónicos actuales.
- **Reconstrucción de estado** (2026-09-06, este set de docs): 4 auditorías nuevas (funcional, DevOps,
  inventario doc, seguridad) + consolidación del líder → este snapshot canónico.

## 4. Cluster nativo / C22 (histórico — no duplicar)

Línea de trabajo de reproducción nativa en vivo y plano de medios/grants. Documentada en
`docs/native/` (14 archivos: `ADR-0001-native-live-playback.md`, `A1_RELAY_DESIGN.md`,
`C22_DELIVERY.md`, `C22_MUTATIONS.md`, `C22_1/2_CORRECTIVE.md`, `TRACK2_CAPSTONE.md`,
`TRACK3_VALIDATION.md`, `LIVE_CLIENT_ARCHITECTURE.md`, `METRICS_LIVE_STARTUP.md`, `N1_N2_WIRING.md`).

Resumen del arco:
- **Pedido:** reproducción de baja latencia/nativa además del live web, con evidencia de seguridad.
- **Implementado (en `main`, flag OFF):** shared-core TS del cliente + plano de grants de medios
  (hash-only, uso único atómico vía Lua/Redis, `authorizationEpoch` durable, scope server-derivado),
  auth-hook de MediaMTX y grant de sesión de relay. Mutaciones 19/19 (`docs/native/C22_MUTATIONS.md`).
- **Incompleto / bloqueado:** cliente Tauri/Rust = skeleton **NO compilado** (`BLOCKED_SPEC`); relay A1
  autenticado = **NO-GO** mientras MediaMTX corra `user: any` (documentado en `A1_RELAY_DESIGN.md`).
- **Decisión:** ADR-0001 fija el enfoque; A1 relay queda como diseño no habilitado.

## 5. Trabajo A1 de viewport (histórico)

PRs #159/#160 + ramas `claude/a1-*`: aislamiento atómico de cambios de NVR/página/layout, cancelando
trabajo transitorio para que una respuesta vieja no publique estado nuevo (invariante #4).
Detalle en `docs/phase-a1-session-heartbeat-truth.md`.

## 6. Qué quedó incompleto / reemplazado / bloqueado (resumen)

- **Incompleto:** playback (estados implícitos, reversa no viable web); analítica sin productor real;
  Telegram/WhatsApp y ALPR simulados; detección de caídas planeada.
- **Reemplazado / superado:** cifrado NVR crypto-js → AES-256-GCM (#162); CORS reflectante → allowlist;
  auditorías `docs/audit/*` superadas por los canónicos de 2026-09-06.
- **Bloqueado:** Tauri (spec/compilación), relay A1 (MediaMTX `user: any`), backup programado (decisión infra).
