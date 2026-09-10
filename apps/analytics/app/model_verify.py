# apps/analytics/app/model_verify.py
# Verificación de integridad (SHA-256) del modelo ONNX descargado en runtime.
# Módulo PURO (sólo stdlib) — importable y testeable sin cv2/onnx/supervision,
# igual que el resto de tests del CI de analytics.
from __future__ import annotations

import hashlib
import os


class ModelChecksumError(RuntimeError):
    """El artefacto descargado no coincide con el SHA-256 esperado."""


def sha256_file(path: str, chunk_size: int = 1 << 20) -> str:
    """SHA-256 hex de un archivo leído por bloques (no carga todo en memoria)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_sha256(path: str, expected: str, *, remove_on_mismatch: bool = True) -> str | None:
    """Verifica que el SHA-256 de ``path`` sea ``expected``.

    - ``expected`` vacío/None → omite verificación y retorna None (sólo debe pasar
      con modelos propios, nunca con una descarga externa no confiable).
    - Coincide → retorna el digest calculado.
    - No coincide → borra el archivo (si ``remove_on_mismatch``) y lanza
      ``ModelChecksumError``, para NO ejecutar un binario no verificado.
    """
    if not expected:
        return None
    expected_norm = expected.strip().lower()
    actual = sha256_file(path).lower()
    if actual != expected_norm:
        if remove_on_mismatch:
            try:
                os.remove(path)
            except OSError:
                pass
        raise ModelChecksumError(
            f"checksum del modelo no coincide: esperado {expected_norm}, obtenido {actual}"
        )
    return actual
