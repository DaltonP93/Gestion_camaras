# apps/analytics/app/main.py
# VisionCore Analytics — microservicio de analítica de video.
# Detección de objetos (YOLOX/ONNX, Apache-2.0) + tracking y zonas
# (Roboflow Supervision, MIT) sobre los substreams RTSP de los NVR.
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import settings
from .pipeline import PipelineManager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("analytics")

manager = PipelineManager()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not settings.analytics_secret:
        log.error("ANALYTICS_SECRET no definido — el servicio no puede hablar con el API")
    manager.start()
    yield


app = FastAPI(title="VisionCore Analytics", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/status")
def status():
    return manager.status()
