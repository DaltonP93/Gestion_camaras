# apps/analytics/app/providers/factory.py
# Selección del provider de detección por nombre (env ANALYTICS_PROVIDER).
# Importa el provider concreto de forma perezosa para no arrastrar cv2/onnx
# cuando se usa el mock (tests / servicio sin modelo).
from __future__ import annotations

from .base import DetectionProvider


def create_detection_provider(name: str) -> DetectionProvider:
    key = (name or "yolox_onnx").strip().lower()
    if key == "mock":
        from .mock import MockDetectionProvider
        return MockDetectionProvider()
    if key in ("yolox_onnx", "yolox", "onnx"):
        from .yolox_onnx import YoloxOnnxProvider
        return YoloxOnnxProvider()
    raise ValueError(f"provider de detección desconocido: {name}")
