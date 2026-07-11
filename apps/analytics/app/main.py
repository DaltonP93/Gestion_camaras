# apps/analytics/app/main.py
# VisionCore Analytics — microservicio de analítica de video.
#
# REGLA DE ORO: este proceso NUNCA muere. Cualquier fallo (modelo que no
# descarga, cv2/onnx que no importa, API caída, RTSP inaccesible, secreto
# faltante) degrada el estado reportado en /status — jamás tumba FastAPI.
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("analytics")

# Estado global del servicio — se llena de forma perezosa en el lifespan.
STATE: dict = {
    "serviceStatus": "starting",  # running | degraded | model_error | api_error
    "modelLoaded": False,
    "modelError": None,
    "importError": None,
    "manager": None,
}


def _boot() -> None:
    """Arranque en segundo plano: imports pesados + modelo + workers.
    Cualquier excepción queda registrada en STATE, nunca propaga."""
    try:
        from .config import settings
        if not settings.analytics_secret:
            log.error("ANALYTICS_SECRET no definido — no se puede hablar con el API")
            STATE["serviceStatus"] = "degraded"
            # Seguimos: si el secreto aparece tras un redeploy, el operador
            # verá el estado real en /status mientras tanto.
    except Exception as exc:  # noqa: BLE001
        STATE["importError"] = f"config: {exc}"
        STATE["serviceStatus"] = "degraded"
        return

    try:
        # cv2/onnxruntime/supervision se importan recién acá — si falta una
        # librería del sistema el servicio queda en model_error, no crashea.
        from .pipeline import PipelineManager
    except Exception as exc:  # noqa: BLE001
        log.exception("no se pudieron importar las dependencias de video")
        STATE["importError"] = str(exc)
        STATE["serviceStatus"] = "model_error"
        return

    manager = PipelineManager()
    STATE["manager"] = manager
    manager.start()  # internamente maneja fallo de modelo con reintentos
    STATE["serviceStatus"] = "running"
    log.info("analytics_service_started")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=_boot, daemon=True, name="boot").start()
    yield


app = FastAPI(title="VisionCore Analytics", lifespan=lifespan)


def _model_loaded() -> bool:
    mgr = STATE["manager"]
    return bool(mgr and mgr.detector is not None)


@app.get("/health")
def health():
    # Siempre 200 mientras FastAPI viva: el healthcheck de Docker no debe
    # reiniciar el contenedor por un modelo caído — eso se ve en /status.
    svc = STATE["serviceStatus"]
    return {
        "status": "ok" if svc == "running" else "degraded",
        "serviceStatus": svc,
        "modelLoaded": _model_loaded(),
    }


@app.get("/status")
def status():
    manager = STATE["manager"]
    base = {
        "serviceStatus": STATE["serviceStatus"],
        "modelLoaded": False,
        "modelError": STATE["modelError"] or STATE["importError"],
        "lastRefresh": None,
        "lastRefreshError": None,
        "workers": [],
    }
    if manager is None:
        return base
    return {**base, **manager.status()}


@app.get("/frame/{camera_id}")
def frame(camera_id: str):
    """Último frame anotado (JPEG) del worker de esa cámara — alimenta la
    'Vista analítica en vivo' del frontend vía proxy del API."""
    manager = STATE["manager"]
    jpeg = manager.get_last_frame(camera_id) if manager else None
    if not jpeg:
        return Response(status_code=404)
    return Response(content=jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})
