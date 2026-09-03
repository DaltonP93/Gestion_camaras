# ADR-0001 · Reproducción nativa segura de LiveView (base C22)

- Estado: **Aceptado (diseño)**. La ronda C22 implementa la base verificable; el
  transporte nativo directo permanece **deshabilitado por flag** hasta completar
  el relay autenticado (fase N1).
- Fecha: 2026-09-02.
- Contexto previo: C21 (`docs/native/LIVE_CLIENT_ARCHITECTURE.md`) introdujo el
  contrato de negociación (`POST /api/live-view/client-capabilities`) y la
  observabilidad de capacidad/latencia. Este ADR formaliza la decisión de
  arquitectura que C22 comienza a materializar.

> Este documento no autoriza despliegue ni cambios en producción. No contiene
> IPs internas, credenciales ni URIs RTSP.

## 1. Problema

El navegador no decodifica HEVC de forma universal, así que las cámaras HEVC
requieren transcodificación H.264 en el servidor. Esa transcodificación está
acotada a **dos procesos FFmpeg simultáneos** (`MAX_TRANSCODE_SESSIONS=2`), un
límite físico que C1–C21 protegen con leases, retenciones, `processInstanceId`,
cierre exacto y protección A/B. Un cliente nativo (Windows/Android/iOS) que
decodifique HEVC localmente puede evitar consumir un cupo del servidor, pero
**no puede** recibir credenciales del NVR ni una URI RTSP con secreto, y el
control de acceso RBAC debe seguir siendo la frontera real.

Necesitamos elegir: (a) el shell/tooling del cliente nativo, (b) el backend de
decodificación por plataforma, (c) el transporte de medios, y (d) el plano de
autorización que evite entregar secretos y permita revocación.

## 2. Restricciones no negociables (heredadas de C1–C21)

1. `MAX_TRANSCODE_SESSIONS` permanece en 2 (no se aumenta en C22).
2. El TTL de seguridad de 90 s no se reduce como "arreglo" de rendimiento.
3. Un stream se libera sólo sin espectadores/sesiones vivos reales.
4. Cambios de viewport invalidan timers, colas, solicitudes y respuestas viejas.
5. Nunca se exponen credenciales NVR, URIs RTSP ni secretos al cliente ni a logs.
6. Toda funcionalidad nueva nace **detrás de feature flags apagadas por defecto**;
   con las flags apagadas el comportamiento es idéntico a C21.
7. A1 continúa NO-GO.

## 3. Opciones evaluadas

### Eje A — Shell / distribución del cliente

| Opción | Pros | Contras |
|---|---|---|
| **Tauri 2 + UI React existente** | Reutiliza la SPA; binarios pequeños (webview del SO); backend Rust para el decoder nativo por plataforma; buen soporte Windows/Android/iOS en Tauri 2 | Requiere Rust/cargo y los SDK de cada plataforma para compilar; puente JS↔Rust para el video |
| Electron | Familiar | Binarios grandes; sin ruta iOS/Android; Chromium tampoco decodifica HEVC universalmente |
| Nativo puro por plataforma (WinUI/Kotlin/SwiftUI) | Máximo control | Triplica la UI; rompe "una sola base de producto" |

### Eje B — Backend de decodificación de video

| Opción | Pros | Contras |
|---|---|---|
| **Decoder del SO por plataforma** (Media Foundation / MediaCodec / VideoToolbox) | HEVC por hardware real; menor CPU; batería | Un adaptador nativo por plataforma detrás de una interfaz común |
| **libVLC compartido** | Un solo motor multiplataforma; RTSP/RTSPS integrado | Binarios grandes; aceleración HW desigual; licencia (LGPL) a gestionar |
| **GStreamer compartido** | Muy flexible; HW accel por plugins | Complejidad de empaquetado alta; superficie de dependencias grande |

### Eje C — Transporte de medios

| Opción | Pros | Contras |
|---|---|---|
| **RTSPS autenticado (relay)** | TCP+TLS; encaja con decoders nativos; MediaMTX ya expone `rtspsAddress` | Requiere auth por path en MediaMTX (hoy `user: any`) |
| WHEP (WebRTC) | ~500 ms; ya hay `webrtc` habilitado | HEVC/WebRTC no universal; ICE/relay adicional |
| HLS directo nativo | Simple | ~6 s de latencia; no aprovecha HEVC HW mejor que el navegador |

### Eje D — Plano de autorización

| Opción | Pros | Contras |
|---|---|---|
| **Grant opaco, efímero y revocable emitido por el API** | Sin secretos NVR en el cliente; TTL corto; revocable en logout/cambio de vista; ligado a usuario/view/cámara/path/codec/transporte/generación | Requiere que el relay valide el grant en cada entrada del transporte |
| Reusar el JWT de sesión como credencial de medios | Menos piezas | El JWT no está acotado a una cámara/path; su fuga expone toda la sesión |
| Abrir el puerto de medios sin auth "temporalmente" | Rápido | Viola invariante 5; inaceptable |

## 4. Decisión

1. **Shell:** Tauri 2 reutilizando la SPA React (`apps/native`, base compartida en
   TypeScript; adaptadores nativos por plataforma en el backend Rust).
2. **Decodificación:** decoder del SO por plataforma detrás de una interfaz común
   `NativeVideoAdapter` (Media Foundation en Windows, MediaCodec/Media3 en
   Android, VideoToolbox/AVFoundation en iOS). libVLC/GStreamer quedan como
   backend intercambiable de respaldo cuando el códec del host no esté disponible.
3. **Transporte:** **RTSPS autenticado** contra el restream de MediaMTX como
   transporte primario para HEVC nativo; WHEP autenticado como secundario cuando
   códec y plataforma lo permitan. **Nunca** RTSP directo al NVR desde el cliente.
4. **Autorización:** **grant de medios opaco, efímero, de USO ÚNICO y revocable**
   emitido por el API (`services/media/media-grants.ts`), ligado a
   `usuario · viewId · cámara · streamPath · codec · transporte · acción=read ·
   mediaInstanceId · authorizationEpoch · vencimiento`. El API guarda sólo un
   **hash** del secreto (bearer; sin HMAC); el grant nunca contiene contraseñas ni
   URIs RTSP. El consumo es una **transición atómica única** (`validateAndClaim`,
   Lua en Redis / síncrona en memoria): revocación, epoch, instancia, expiración y
   uso se comprueban y el uso se marca en el mismo punto de linealización.
5. **Fallback:** decisión explícita del servidor
   (`native_hevc | native_h264 | server_h264 | substream | unavailable`) con razón
   estructurada y auditable; el fallback H.264 del servidor respeta el límite de 2
   cupos; sin cupo → se conserva el substream y se espera (helper puro
   `decideAdmissionOrWait`, no un flujo nuevo cableado — ver §7/limitaciones).

## 5. Justificación por criterio

- **Seguridad:** el grant efímero + relay autenticado evita entregar secretos y
  permite revocación inmediata; el puerto de medios no se abre sin auth.
- **HEVC:** decoders del SO dan HEVC por hardware real sin cargar los 2 cupos.
- **Aceleración de hardware:** delegada al SO por plataforma.
- **Latencia:** RTSPS/TCP evita el buffer HLS de ~6 s; objetivo <2 s en LAN.
- **Mantenimiento:** una base React + una interfaz de adaptador estable.
- **Windows/Android/iOS:** Tauri 2 cubre las tres con un adaptador por plataforma.
- **Tamaño de instalación:** webview del SO ⇒ binarios pequeños vs Electron.
- **Restricciones reales de compilación:** ver §7.

## 6. Consecuencias

- Positivas: base de producto única; HEVC nativo sin tocar el límite de 2;
  autorización con revocación; observabilidad ampliada.
- Costos: se introduce un plano de grants y un relay que MediaMTX aún no aplica;
  hasta entonces, `nativeDirect.available=false`.
- El pipeline de IA sigue leyendo el restream compartido (no una 2.ª conexión al
  NVR por consumidor).

## 7. Restricciones de compilación en este entorno (honestidad de validación)

El entorno de desarrollo actual **no** dispone de:

- `cargo`/`rustc` (no se puede compilar el shell Tauri ni los adaptadores Rust);
- Android SDK/NDK (no se puede generar `.aab/.apk`);
- Xcode/macOS (no se puede generar `.ipa`);
- Docker (no se puede correr `docker compose config` ni contenedores);
- Python (no se puede ejecutar el servicio analytics).

Por lo tanto C22 entrega **código fuente real** del cliente nativo/shared-core y
del plano de IA, con pruebas donde el toolchain lo permite (Node/TypeScript:
API + web + shared-core TS). Los artefactos nativos y de contenedor se marcan
explícitamente **NO VALIDADO** y no se sustituyen por mocks presentados como
"aplicación terminada".

## 8. Fases verificables

1. **C21** — contrato de negociación + observabilidad. *(hecho)*
2. **C22** — plano de grants, negociación/fallback explícito, base de IA,
   shared-core y fuente nativa, métricas de etapas, threat model y pruebas.
   Transporte nativo directo aún **deshabilitado por flag**. *(esta ronda)*
3. **N1** — auth por path en MediaMTX + relay que valida grants; pruebas de
   revocación/aislamiento; recién aquí `nativeDirect` puede habilitarse.
4. **N2/N3** — MVP Windows y luego Android/iOS con adaptadores nativos.
5. **N4** — selección automática de perfil, límites por dispositivo, rollout.
