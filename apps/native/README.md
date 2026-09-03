# VisionCore — Cliente nativo (C22, Hito 3)

Base del cliente nativo multiplataforma (Windows/Android/iOS) según
[ADR-0001](../../docs/native/ADR-0001-native-live-playback.md): Tauri 2 + UI
React reutilizada + decoder del SO por plataforma + transporte RTSPS autenticado
+ grants efímeros.

## Estado de validación (honesto)

| Componente | Estado en este entorno |
|---|---|
| `shared/` (TS: interfaz de reproducción, session-controller, grant-client, coordinator) | **Implementado y PROBADO** (`npm test` → 20 tests, `tsc --noEmit` limpio). Es SHARED-CORE, no una app ejecutable. |
| `src-tauri/` (Rust: trait de decoder, adaptador Media Foundation, secure store, main) | **Skeleton — NO COMPILADO**: no hay `cargo`/`rustc` ni SDK de plataforma |
| Binarios `.msi` / `.apk` / `.ipa` | **NO GENERADOS**: requieren toolchain Windows / Android SDK / Xcode |

No se entrega ningún binario vacío ni un WebView disfrazado de decoder nativo.
El acceso nativo directo permanece **deshabilitado** (`NATIVE_MEDIA_RELAY_ENABLED=false`)
hasta completar el relay autenticado (fase N1); ver ADR y threat model.

## Qué es real y verificable ahora

- Interfaz `NativeVideoAdapter` (TS y su espejo Rust) con
  `open/play/pause/stop/dispose` y callbacks `onFirstFrame/onError/onCodec/
  onHardwareDecoder/onNetworkStats`.
- `LivePlaybackSession`: máquina de estados + **guarda de generación** que
  descarta aperturas/callbacks obsoletos al cambiar de viewport (mismo invariante
  que el lifecycle web) — con una prueba de carrera controlada.
- `MediaGrantClient`: adquiere/mantiene/revoca el grant; revoca el anterior al
  cambiar de cámara y al liberar (sin grants huérfanos).

## Cómo probar el shared-core

```bash
cd apps/native
npm install
npm run typecheck
npm test
```

## Cómo compilar el shell nativo (cuando exista el toolchain)

Requiere Rust estable + Tauri CLI, y por plataforma: Windows (MSVC), Android
(SDK/NDK), iOS (Xcode). No disponibles aquí.

```bash
# Referencia (NO ejecutable en este entorno):
cargo install tauri-cli --version '^2'
cd apps/native && cargo tauri build
```

## Próximos pasos (fuera de C22)

- **N1**: relay autenticado que valida grants por path (habilita `nativeDirect`).
- **N2**: MVP Windows con Media Foundation (1/4/9 cámaras, HEVC hw, reconexión).
- **N3**: adaptadores Android (MediaCodec) e iOS (VideoToolbox).
