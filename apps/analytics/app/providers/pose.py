# apps/analytics/app/providers/pose.py
# Scaffold de estimación de pose — base para detección de caídas.
# NO hay un modelo de pose ONNX con licencia validada incluido; este módulo
# define la interfaz y un provider "no instalado" que reporta su estado.
# Activación futura: ANALYTICS_FALL_DETECTION_ENABLED=true + modelo real.
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Keypoint:
    name: str
    x: float
    y: float
    confidence: float


@dataclass
class PersonPose:
    """Pose de una persona: keypoints + caja asociada (px del frame)."""
    keypoints: list[Keypoint] = field(default_factory=list)
    bbox: tuple[float, float, float, float] | None = None
    track_id: int | None = None


class PoseEstimationProvider(ABC):
    @abstractmethod
    def load(self) -> None: ...
    @abstractmethod
    def unload(self) -> None: ...
    @abstractmethod
    def estimate(self, frame: Any) -> list[PersonPose]: ...
    @abstractmethod
    def available(self) -> bool: ...


class NotInstalledPoseProvider(PoseEstimationProvider):
    """Placeholder: no hay modelo de pose instalado."""
    REASON = "modelo de pose no instalado"

    def load(self) -> None:
        raise RuntimeError(self.REASON)

    def unload(self) -> None:
        return None

    def estimate(self, frame: Any) -> list[PersonPose]:
        return []

    def available(self) -> bool:
        return False
