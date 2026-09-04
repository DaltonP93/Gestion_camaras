# apps/analytics/app/frigate/camera_map.py
# PURO (stdlib only): resuelve el nombre de cámara de Frigate → cameraId de
# VisionCore. Config vía JSON `FRIGATE_CAMERA_MAP` (opcional) o match directo.
# Cámara desconocida → None (el ingestor la descarta).
from __future__ import annotations

import json
from typing import Any


def load_camera_map(raw: Any) -> dict[str, str]:
    """Parsea `FRIGATE_CAMERA_MAP`.

    Acepta un dict ya parseado, un string JSON `{"frigate_cam": "<cameraId>"}` o
    vacío/None (→ {}). Ante JSON inválido o forma inesperada devuelve {} (fail
    seguro: se cae a match directo, nunca crashea el ingestor).
    """
    if not raw:
        return {}
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items() if v}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        if isinstance(parsed, dict):
            return {str(k): str(v) for k, v in parsed.items() if v}
    return {}


def resolve_camera_id(
    frigate_camera: Any,
    camera_map: dict[str, str],
    known_ids: set[str] | frozenset[str] | None = None,
) -> str | None:
    """Nombre de cámara Frigate → cameraId VisionCore, o None si es desconocida.

    Reglas:
      1. Si hay un mapa explícito y la cámara está en él → el cameraId mapeado.
      2. Match directo: si el nombre Frigate ya ES un cameraId válido
         (presente en `known_ids`) → ese mismo id.
      3. Sin `known_ids` (no se puede validar) y sin mapa → se acepta el nombre
         como cameraId (match directo optimista, según design doc §5).
      4. Cualquier otro caso → None (skip).
    """
    if not frigate_camera:
        return None
    name = str(frigate_camera)

    if camera_map:
        mapped = camera_map.get(name)
        if mapped:
            return mapped
        # No está en el mapa explícito: solo se acepta si es un id conocido.
        if known_ids is not None and name in known_ids:
            return name
        return None

    # Sin mapa: match directo.
    if known_ids is not None:
        return name if name in known_ids else None
    return name
