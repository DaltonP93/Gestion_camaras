# apps/analytics/app/providers — abstracción de modelos de visión.
from .base import Detection, DetectionProvider, ProviderHealth, ProviderMetadata
from .factory import create_detection_provider

__all__ = [
    "Detection",
    "DetectionProvider",
    "ProviderHealth",
    "ProviderMetadata",
    "create_detection_provider",
]
