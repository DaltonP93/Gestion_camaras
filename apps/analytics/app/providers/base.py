# apps/analytics/app/providers/base.py
# Interfaz de providers de detección — desacopla el pipeline del modelo concreto.
#
# El contrato es NEUTRAL (sin numpy/cv2/onnx/supervision) para que se pueda
# importar y testear sin las dependencias pesadas de visión. El provider recibe
# un frame (numpy array en runtime, tipado Any) y devuelve una lista de
# `Detection` planas; el pipeline las convierte a sv.Detections para tracking y
# zonas. Así se puede cambiar YOLOX por otro modelo ONNX sin tocar el pipeline.
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Detection:
    """Una detección en coordenadas de píxel del frame original."""
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float
    class_id: int
    class_name: str


@dataclass
class ProviderHealth:
    loaded: bool
    error: str | None = None


@dataclass
class ProviderMetadata:
    name: str            # id del provider (p.ej. "yolox_onnx")
    model: str           # nombre/ruta lógica del modelo
    input_size: int      # lado de entrada del modelo
    classes: list[str]   # clases que puede emitir
    providers: list[str] = field(default_factory=list)  # ejecución ONNX (CPU/CUDA)


class DetectionProvider(ABC):
    """Ciclo de vida y detección de un modelo de visión."""

    @abstractmethod
    def load(self) -> None:
        """Carga el modelo (descarga si hace falta). Lanza si no puede."""

    @abstractmethod
    def unload(self) -> None:
        """Libera recursos del modelo."""

    @abstractmethod
    def infer(self, frame: Any, min_confidence: float) -> list[Detection]:
        """Detecta objetos en el frame; filtra por confianza mínima."""

    @abstractmethod
    def health(self) -> ProviderHealth:
        """Estado actual del provider."""

    @abstractmethod
    def metadata(self) -> ProviderMetadata:
        """Metadatos del modelo cargado."""
