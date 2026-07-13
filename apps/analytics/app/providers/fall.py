# apps/analytics/app/providers/fall.py
# Scaffold de detección de caídas — arquitectura correcta, sin modelo productivo.
#
# La detección NO se hace con una simple caja inclinada. El diseño previsto
# combina pose + reglas temporales:
#   - cambio brusco de postura (de pie → suelo)
#   - baja altura relativa del cuerpo sostenida
#   - orientación horizontal del torso
#   - permanencia en el suelo (confirmación temporal)
#   - ausencia de movimiento posterior (immobility)
# Todo esto reduce falsos positivos frente a "persona agachada" o "sentada".
#
# Mientras no exista un modelo de pose ONNX con licencia compatible y validado,
# este provider queda deshabilitado (feature flag ANALYTICS_FALL_DETECTION_ENABLED).
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from .pose import PersonPose


@dataclass
class FallSignal:
    track_id: int | None
    kind: str          # "fall" | "person_down" | "immobility"
    confidence: float
    metadata: dict


class FallDetectionProvider(ABC):
    @abstractmethod
    def load(self) -> None: ...
    @abstractmethod
    def unload(self) -> None: ...
    @abstractmethod
    def analyze(self, poses: list[PersonPose], now: float) -> list[FallSignal]:
        """Evalúa poses en el tiempo y devuelve señales de caída/inmovilidad."""
    @abstractmethod
    def available(self) -> bool: ...


class DisabledFallDetectionProvider(FallDetectionProvider):
    """Placeholder deshabilitado — requiere modelo de pose + validación."""
    REASON = "detección de caídas deshabilitada (sin modelo validado)"

    def load(self) -> None:
        raise RuntimeError(self.REASON)

    def unload(self) -> None:
        return None

    def analyze(self, poses: list[PersonPose], now: float) -> list[FallSignal]:
        return []

    def available(self) -> bool:
        return False
