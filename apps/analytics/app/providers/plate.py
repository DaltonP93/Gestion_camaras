# apps/analytics/app/providers/plate.py
# Scaffold de ALPR (matrículas) — detección de placa + OCR, arquitectura separada.
#
# COCO NO detecta matrículas: hace falta un detector de placa dedicado + un OCR.
# Este módulo define las interfaces y providers "no instalados". La activación
# real requiere un modelo con licencia compatible (ver docs/analytics/LICENSING.md)
# y ANALYTICS_ALPR_ENABLED=true. No se incluye ninguna dependencia AGPL.
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class PlateDetection:
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float
    vehicle_track_id: int | None = None


@dataclass
class PlateReading:
    text: str
    normalized: str
    confidence: float
    country: str | None = None


class PlateDetectorProvider(ABC):
    @abstractmethod
    def load(self) -> None: ...
    @abstractmethod
    def unload(self) -> None: ...
    @abstractmethod
    def detect(self, frame: Any) -> list[PlateDetection]: ...
    @abstractmethod
    def available(self) -> bool: ...


class PlateOcrProvider(ABC):
    @abstractmethod
    def load(self) -> None: ...
    @abstractmethod
    def unload(self) -> None: ...
    @abstractmethod
    def read(self, plate_crop: Any) -> PlateReading | None: ...
    @abstractmethod
    def available(self) -> bool: ...


def normalize_plate(text: str) -> str:
    """Normaliza para búsqueda: mayúsculas, solo alfanumérico."""
    return "".join(ch for ch in (text or "").upper() if ch.isalnum())


class DisabledPlateDetectorProvider(PlateDetectorProvider):
    REASON = "detector de matrículas no instalado"
    def load(self) -> None: raise RuntimeError(self.REASON)
    def unload(self) -> None: return None
    def detect(self, frame: Any) -> list[PlateDetection]: return []
    def available(self) -> bool: return False


class DisabledPlateOcrProvider(PlateOcrProvider):
    REASON = "OCR de matrículas no instalado"
    def load(self) -> None: raise RuntimeError(self.REASON)
    def unload(self) -> None: return None
    def read(self, plate_crop: Any) -> PlateReading | None: return None
    def available(self) -> bool: return False
