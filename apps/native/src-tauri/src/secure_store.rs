// apps/native/src-tauri/src/secure_store.rs
//
// Almacenamiento seguro de tokens por plataforma (skeleton). El token de sesión
// y los grants NUNCA se guardan en texto plano: Windows Credential Manager,
// Android Keystore, iOS Keychain. NO compilado en este entorno.

#[derive(Debug, thiserror::Error)]
pub enum SecureStoreError {
    #[error("almacén seguro no disponible")]
    Unavailable,
    #[error("clave no encontrada")]
    NotFound,
}

pub trait SecureStore {
    fn set(&self, key: &str, value: &str) -> Result<(), SecureStoreError>;
    fn get(&self, key: &str) -> Result<String, SecureStoreError>;
    fn delete(&self, key: &str) -> Result<(), SecureStoreError>;
}

#[cfg(windows)]
pub mod windows_credmgr {
    use super::*;
    pub struct CredentialManagerStore;
    impl SecureStore for CredentialManagerStore {
        fn set(&self, _key: &str, _value: &str) -> Result<(), SecureStoreError> {
            // TODO(N2): CredWriteW con CRED_TYPE_GENERIC.
            todo!("Windows Credential Manager")
        }
        fn get(&self, _key: &str) -> Result<String, SecureStoreError> { todo!() }
        fn delete(&self, _key: &str) -> Result<(), SecureStoreError> { todo!() }
    }
}
