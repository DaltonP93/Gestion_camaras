// apps/native/src-tauri/src/main.rs
//
// Punto de entrada del shell nativo (Tauri 2). SKELETON — NO compilado en este
// entorno (sin cargo/rustc). Expone comandos que el shared-core (TS) invoca:
//   - negotiate_capabilities: reenvía al API /api/live-view/client-capabilities
//   - open_stream: valida el grant vía relay y abre el decoder de plataforma
//
// La UI React existente se reutiliza como frontend de Tauri; el módulo de video
// es específico por plataforma (ver video.rs).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod secure_store;
mod video;

use video::EphemeralMediaGrant;

#[tauri::command]
fn open_stream(_grant: EphemeralMediaGrant) -> Result<u64, String> {
    // TODO(N1/N2): seleccionar el adaptador de la plataforma actual, validar el
    // grant contra el relay autenticado (RTSPS) y abrir el decoder de hardware.
    // Nunca se conecta directo al NVR ni se reciben credenciales del NVR.
    Err("native direct playback not enabled (see ADR-0001 / relay N1)".into())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_stream])
        .run(tauri::generate_context!())
        .expect("error al iniciar VisionCore nativo");
}
