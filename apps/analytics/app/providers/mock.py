# apps/analytics/app/providers/mock.py
# Provider de detección simulado — sin dependencias pesadas.
# Usos:
#   1) Tests del pipeline/reglas sin cv2/onnx/supervision.
#   2) Correr el servicio con ANALYTICS_PROVIDER=mock para validar el flujo
#      completo (workers, eventos, UI) sin un modelo real instalado.
from __future__ import annotations

from typing import Any

from .base import Detection, DetectionProvider, ProviderHealth, ProviderMetadata


class MockDetectionProvider(DetectionProvider):
    """Emite detecciones predefinidas. `script` es una lista de "frames", cada
    uno una lista de Detection; se recorre de forma cíclica en cada infer()."""

    def __init__(self, script: list[list[Detection]] | None = None,
                 classes: list[str] | None = None) -> None:
        self._script = script or [[]]
        self._i = 0
        self._loaded = False
        self._classes = classes or ["person", "car", "truck", "bus", "motorcycle", "bicycle"]

    def load(self) -> None:
        self._loaded = True

    def unload(self) -> None:
        self._loaded = False

    def infer(self, frame: Any, min_confidence: float) -> list[Detection]:
        if not self._loaded:
            raise RuntimeError("mock provider no cargado")
        dets = self._script[self._i % len(self._script)]
        self._i += 1
        return [d for d in dets if d.confidence >= min_confidence]

    def health(self) -> ProviderHealth:
        return ProviderHealth(loaded=self._loaded)

    def metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            name="mock", model="mock", input_size=640,
            classes=self._classes, providers=["MockExecutionProvider"],
        )
