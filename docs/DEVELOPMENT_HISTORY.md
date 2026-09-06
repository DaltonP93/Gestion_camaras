# Historia de desarrollo — VisionCore

> Actualizado: 2026-09-06. Base: `main` = `0f9d1f5`. Reconstruido de `git log` de `main` y de los
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
