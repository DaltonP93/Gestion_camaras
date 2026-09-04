# apps/analytics/app/frigate — ingestor de eventos de Frigate → analítica.
#
# Frigate SUSTITUYE la etapa de detección (YOLOX/ByteTrack) y reutiliza el resto
# del contrato existente: normaliza sus eventos al `eventSchema` interno y los
# POSTea al ya-existente `POST /api/analytics/internal/events` con
# `x-analytics-secret`. CERO cambios en apps/api, DB o apps/web.
#
# IMPORTANTE (compuerta de CI y arranque robusto): este paquete NO debe importar
# httpx/paho/cv2/onnx/pydantic al cargarse. Los módulos puros (normalize,
# camera_map, derive) son stdlib-only y testeables sin pip install; el I/O
# (client.py httpx, mqtt_consumer.py paho, ingestor wiring con config) hace sus
# imports pesados de forma perezosa dentro de las funciones/métodos.
#
# Import perezoso vía PEP 562: `from app.frigate import FrigateIngestor` no
# arrastra httpx/config hasta que realmente se usa.

__all__ = ["FrigateIngestor", "IngestDecider"]


def __getattr__(name: str):
    if name in ("FrigateIngestor", "IngestDecider"):
        from .ingestor import FrigateIngestor, IngestDecider
        return {"FrigateIngestor": FrigateIngestor, "IngestDecider": IngestDecider}[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
