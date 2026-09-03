// apps/native/src-tauri/src/video.rs
//
// Frontera Rust del decoder nativo, espejo del `NativeVideoAdapter` de TS. Cada
// plataforma implementa `NativeVideoAdapter` con su decoder de hardware. Este
// archivo es un SKELETON: define la interfaz y adaptadores por plataforma con
// los puntos de integración marcados. NO compilado en este entorno.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum MediaCodec {
    H264,
    Hevc,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum NativeTransport {
    Rtsps,
    Whep,
}

/// Grant efímero recibido del API. NUNCA contiene credenciales de NVR ni URIs
/// RTSP: sólo la identidad del stream y el secreto opaco a presentar al relay.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EphemeralMediaGrant {
    pub grant_id: String,
    pub secret: String,
    pub transport: NativeTransport,
    pub stream_path: String,
    pub codec: MediaCodec,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdapterCapabilities {
    pub codecs: Vec<MediaCodec>,
    pub hardware_decoded_codecs: Vec<MediaCodec>,
    pub transports: Vec<NativeTransport>,
    pub max_hardware_decoders: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum VideoError {
    #[error("decoder no disponible: {0}")]
    DecoderUnavailable(String),
    #[error("transporte no soportado")]
    UnsupportedTransport,
    #[error("grant rechazado por el relay")]
    GrantRejected,
}

pub type PlayerHandle = u64;

/// Interfaz común de decodificación nativa. Espejo de `NativeVideoAdapter` (TS).
pub trait NativeVideoAdapter {
    fn platform(&self) -> &'static str;
    fn capabilities(&self) -> Result<AdapterCapabilities, VideoError>;
    /// Abre el stream: valida el grant contra el relay autenticado y arranca el
    /// decoder de hardware. NUNCA se conecta directo al NVR.
    fn open(&mut self, grant: &EphemeralMediaGrant) -> Result<PlayerHandle, VideoError>;
    fn play(&mut self, handle: PlayerHandle) -> Result<(), VideoError>;
    fn pause(&mut self, handle: PlayerHandle) -> Result<(), VideoError>;
    fn stop(&mut self, handle: PlayerHandle) -> Result<(), VideoError>;
    fn dispose(&mut self, handle: PlayerHandle) -> Result<(), VideoError>;
}

// ─── Windows · Media Foundation (skeleton) ──────────────────────────
#[cfg(windows)]
pub mod windows_mf {
    use super::*;

    pub struct MediaFoundationAdapter {
        // Punto de integración: sesión MF, IMFMediaEngine, RTSPS source reader.
    }

    impl NativeVideoAdapter for MediaFoundationAdapter {
        fn platform(&self) -> &'static str { "windows-media-foundation" }
        fn capabilities(&self) -> Result<AdapterCapabilities, VideoError> {
            // TODO(N2): consultar MFTEnumEx por decoders HEVC/H264 por hardware.
            todo!("consultar decoders de Media Foundation")
        }
        fn open(&mut self, _grant: &EphemeralMediaGrant) -> Result<PlayerHandle, VideoError> {
            // TODO(N1/N2): validar grant contra el relay (RTSPS) y abrir source reader.
            todo!("abrir RTSPS autenticado + decoder MF")
        }
        fn play(&mut self, _h: PlayerHandle) -> Result<(), VideoError> { todo!() }
        fn pause(&mut self, _h: PlayerHandle) -> Result<(), VideoError> { todo!() }
        fn stop(&mut self, _h: PlayerHandle) -> Result<(), VideoError> { todo!() }
        fn dispose(&mut self, _h: PlayerHandle) -> Result<(), VideoError> { todo!() }
    }
}

// Android (MediaCodec/Media3) e iOS (VideoToolbox) se integran en N3 con la misma
// interfaz. Se omiten aquí para no fingir soporte no implementado.
