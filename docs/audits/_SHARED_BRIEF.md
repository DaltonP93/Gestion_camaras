# Brief compartido para el equipo multi-agente — VisionCore

> Documento de contexto común. Todos los agentes deben leerlo antes de empezar.
> Fecha: 2026-09-03. Rama de trabajo: `claude/multi-agent-project-audit-hf14wq`
> (estado c22, equivalente a `9fbb01f`, aplicado sobre `main` 620c893).

## Qué es VisionCore

VMS web para administrar NVR Hikvision: vista en vivo, grabaciones, cámaras,
usuarios, roles, control de acceso (RBAC) y PTZ. Protege continuidad de
visualización y evidencia de grabaciones. No es solo un dashboard.

Arquitectura:
- `apps/api`: Node.js + Fastify + Prisma (PostgreSQL, Redis).
- `apps/web`: React 18 + Vite + TypeScript + Tailwind + Zustand.
- `apps/native`: cliente Tauri (Rust) en desarrollo — reproducción nativa.
- `apps/analytics`: analítica (Python).
- MediaMTX para RTSP → HLS/WebRTC; Nginx proxy. `prisma/`, `infra/`, `scripts/`.

## Estado del código (c22)

Sobre main se aplicó el trabajo c22: plano de grants de medios (C22/.1/.2
endurecido), N1 (source-lifecycle MediaMTX → registro de instancia), N2a-d
(lifecycle-binder, apply-decision, admission-wait, session-policy), Track2
capstone (NativePlaybackController), Track3 (validación Lua real con wasmoon).
Ver `docs/native/*`, `docs/security/*`, `docs/ai/*`.

## RESTRICCIONES DURAS (no violar nunca)

1. Todas las flags nuevas OFF por defecto ⇒ con flags off, comportamiento
   idéntico a C21. Flags: NATIVE_PLAYBACK_ENABLED, NATIVE_MEDIA_RELAY_ENABLED,
   MEDIA_RELAY_SECRET, MEDIA_GRANT_TTL_MS, AI_EVENTS_ENABLED,
   NATIVE_SOURCE_LIFECYCLE_ENABLED, NATIVE_SOURCE_LIFECYCLE_INTERVAL_MS,
   SINGLE_ACTIVE_MEDIA_SESSION.
2. NO subir MAX_TRANSCODE_SESSIONS (=2). NO bajar el TTL de seguridad de 90s.
3. Preservar invariantes C1–C21: capacidad, liberación de procesos, leases,
   retenciones, processInstanceId, cierre exacto, retry, protección A/B.
4. A1 (relay de medios autenticado) = NO-GO; sigue deshabilitado.
5. NUNCA exponer secretos, IPs internas, URIs RTSP/HLS, puertos MediaMTX sin
   auth, contraseñas de NVR, JWT, cookies, claves ni video en respuestas, logs,
   métricas o tests.
6. No tocar producción, Nginx, MediaMTX config, Docker, ni main. Trabajo solo
   en la rama indicada.

## Invariantes de negocio (de docs/AI_HANDOFF.md)

1. Nunca fabricar, perder ni declarar inválida una grabación sin evidencia.
2. Mantener RBAC estricto.
3. Un stream se libera solo cuando no tiene espectadores/sesiones vivos.
4. Cambios de viewport invalidan timers, colas, solicitudes y respuestas viejas.
5. Ciclo de vida explícito de FFmpeg/MediaMTX y cierres terminales.

## Prioridades del usuario

1. Robustecer con patrones de 2 proyectos externos (portados a TS, tras flags,
   con tests): Service ONVIF (WS-Discovery + GetStreamUri + PTZ + imaging) y
   Provider Hik-Connect (token cloud + HLS temporal + ISAPI-proxy; cuidar SSRF
   y secretos).
2. Atacar 2 dolores: límite de 2 transcodes (NO subirlo; palanca real = playback
   nativo) y playback de grabaciones.
3. Siempre mejorar y robustecer sin romper invariantes.

## Formato de hallazgos (para auditores)

Cada hallazgo: severidad (P0/P1/P2/P3), área, título, detalle, evidencia
(archivo:línea), recomendación. Ser concreto y verificable. Solo lectura: NO
modificar código.
