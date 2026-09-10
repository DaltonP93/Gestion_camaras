# Estado de hardware e integraciones físicas — VisionCore

> Actualizado: 2026-09-06. Base: `main` = `0f9d1f5`.
> Este es un **VMS de video**. La única "capa física" real es el **NVR/cámara Hikvision** vía ISAPI/RTSP.
> No hay control de placas/puertas/controladoras. Separación por capa, con estado honesto.
> Estados: MERGED_VERIFIED / MERGED_UNVERIFIED / BLOCKED_SPEC / BLOCKED_HARDWARE / NOT_PRESENT / N/A.
> "Sin validación con equipo" = el código existe y compila/testea, pero NO se ejerció contra hardware/
> cuenta real en este entorno (solo lectura).

---

## 1. Matriz por capa

| Capa | ¿Existe? | Estado | Evidencia | Validación con equipo real |
|---|---|---|---|---|
| **CRUD web** (gestión de NVR/cámaras/usuarios) | Sí | MERGED_UNVERIFIED | `routes/nvr.ts`, `routes/cameras.ts`, UI `NVRsPage/NVRDetailPage` | No (sin NVR en este entorno) |
| **Motor de decisión** (reglas de acceso/apertura) | No | N/A | Sin dominio de control de acceso | — |
| **Simulador** (de dispositivos físicos de acceso) | No | N/A | No aplica al VMS | — |
| **Codec / transporte de video** | Sí | MERGED_UNVERIFIED | RTSP→MediaMTX→HLS/WebRTC (`services/stream*.ts`, `infra/mediamtx/mediamtx.yml`) | No ejercido contra flujo real aquí |
| **Gateway** | Solo de medios | MERGED_UNVERIFIED | `mediamtxAuth.ts`, auth-hook MediaMTX (flag OFF). NO es gateway de controladoras | — |
| **Sync** (ISAPI: device-info/canales/HDD) | Sí | MERGED_UNVERIFIED | `services/nvrSync.ts`, `services/hikvision.ts` (ISAPI) | No |
| **Eventos físicos** (paso/puerta) | No | N/A | `Alert`/`AnalyticsEvent` son video/salud | — |
| **Apertura física** (comando a controladora) | No | NOT_PRESENT | Sin endpoint de apertura; `beginOperation` es de streams | — |
| **Banco / pasarela de pago** | No | N/A | Fuera de alcance del VMS | — |
| **Instalación** | Sí (Docker/Linux) | MERGED_UNVERIFIED | `setup.sh`, `docker-compose.yml`; sin instalador Windows/gateway | Sin despliegue verificado desde este entorno |

---

## 2. Hardware / integraciones reales del VMS

### NVR / cámaras Hikvision — ISAPI + RTSP — MERGED_UNVERIFIED (software real, SIN validación con equipo)
- Integración de software real: descubrimiento/estado por ISAPI (`services/hikvision.ts`), RTSP hacia
  MediaMTX, PTZ (`PTZCtrl/channels/{c}/continuous`), sync de canales/HDD (`services/nvrSync.ts`).
- **No validado contra un NVR físico en este entorno** (solo lectura; sin credenciales/red de cámaras).
- Riesgos asociados: ISAPI sobre HTTP en claro; destino elegible por ADMIN sin allowlist (SSRF) —
  ver `docs/SECURITY.md`.
- **DoD para "hardware validado":** conexión real a un NVR de laboratorio con evidencia de test-connection,
  sync de canales, live y playback.

### ONVIF — MERGED_VERIFIED (núcleo) / flag `ONVIF_ENABLED` OFF — SIN validación con hardware
- Núcleo SOAP/WS-Discovery/WS-Security + SSRF testeado (`services/onvif/*`), UI en `IntegrationsPage.tsx`.
- I/O de red real no ejercido; requiere cámara ONVIF real para validar discovery/StreamUri/PTZ/imaging.

### Hik-Connect (nube) — MERGED_UNVERIFIED / flag `HIK_CONNECT_ENABLED` OFF — SIN cuenta real
- `services/providers/hik-connect/*` (token cloud, HLS temporal, ISAPI-proxy con validación SSRF).
- Requiere cuenta Hik-Connect real para validar.

### Frigate — MERGED_UNVERIFIED / flag `FRIGATE_ENABLED` OFF — SIN instancia real
- Ingestor externo de detección (`apps/analytics/app/frigate/*`), exclusión mutua por cámara.
- Requiere instancia Frigate real para validar runtime.

---

## 3. Experimental / bloqueado

### Cliente nativo Tauri/Rust — BLOCKED_SPEC
- `apps/native/shared/*` (shared-core TS) implementado y testeado; `apps/native/src-tauri/*` es
  **skeleton NO compilado** — sin binarios. Ver ADR-0001 y `docs/DEVELOPMENT_HISTORY.md §4`.
- **DoD:** binario Tauri compilado y firmado + reproducción real de bajo latencia.

### Relay A1 autenticado de medios — BLOCKED_SPEC (NO-GO)
- Diseño en `docs/native/A1_RELAY_DESIGN.md`; auth-hook cableado (flag OFF). **NO-GO** mientras MediaMTX
  corra `user: any` (`infra/mediamtx/mediamtx.yml:18-24,90`). Mitigado en el borde por bind a loopback.

### ALPR / matrículas — SIMULATED_ONLY
- `LicensePlateEvent` + scaffold; `ANALYTICS_ALPR_ENABLED=false`; sin detector/OCR real. No afirma
  reconocimiento de placas.

---

## 4. Afirmaciones que NO se hacen (para evitar sobre-declaración)

- No se afirma control ni apertura de puertas/controladoras (NOT_PRESENT).
- No se afirma reconocimiento real de placas (ALPR simulado).
- No se afirma validación contra NVR/ONVIF/Hik-Connect/Frigate físico (sin equipo en este entorno).
- No se afirma cliente nativo funcional (Tauri no compilado).
