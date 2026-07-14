# apps/analytics/app/main.py
# VisionCore Analytics — microservicio de analítica de video.
#
# REGLA DE ORO: este proceso NUNCA muere. Cualquier fallo (modelo que no
# descarga, cv2/onnx que no importa, API caída, RTSP inaccesible, secreto
# faltante) degrada el estado reportado en /status — jamás tumba FastAPI.
import logging
import threading
import time
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("analytics")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Estado global del servicio — se llena de forma perezosa en el lifespan.
STATE: dict = {
    "serviceStatus": "starting",  # running | degraded | model_error | api_error
    "modelLoaded": False,
    "modelError": None,
    "importError": None,
    "configError": None,
    "dependenciesLoaded": False,   # cv2/onnxruntime/supervision importan
    "provider": None,
    "bootStartedAt": None,
    "lastBootAt": None,
    "manager": None,
}


def _diagnostic_hint() -> str | None:
    """Acción recomendada según el fallo — para que el frontend muestre algo
    accionable en vez de un error críptico."""
    imp = (STATE["importError"] or "")
    if "libGL" in imp or "libgl" in imp:
        return ("Falta libGL.so.1 en la imagen. Reconstruir el contenedor analytics "
                "(el Dockerfile ya incluye libgl1): docker compose build analytics")
    if "libgomp" in imp:
        return "Falta libgomp1 (OpenMP de onnxruntime). Reconstruir la imagen analytics."
    if imp:
        return "Fallo importando dependencias de video. Revisar logs y reconstruir la imagen."
    if STATE["configError"]:
        return "Definir ANALYTICS_SECRET (mismo valor que el API) y reiniciar analytics."
    if STATE["modelError"]:
        return ("El modelo no cargó. Verificar conectividad para descargarlo o usar "
                "ANALYTICS_PROVIDER=mock para validar el flujo sin pesos.")
    return None


def _boot() -> None:
    """Arranque en segundo plano: imports pesados + modelo + workers.
    Cualquier excepción queda registrada en STATE, nunca propaga."""
    STATE["bootStartedAt"] = _now_iso()
    try:
        from .config import settings
        STATE["provider"] = settings.provider
        if not settings.analytics_secret:
            log.error("ANALYTICS_SECRET no definido — no se puede hablar con el API")
            STATE["configError"] = "ANALYTICS_SECRET no definido"
            STATE["serviceStatus"] = "degraded"
            # Seguimos: si el secreto aparece tras un redeploy, el operador
            # verá el estado real en /status mientras tanto.
    except Exception as exc:  # noqa: BLE001
        STATE["importError"] = f"config: {exc}"
        STATE["serviceStatus"] = "degraded"
        STATE["lastBootAt"] = _now_iso()
        return

    try:
        # cv2/onnxruntime/supervision se importan recién acá — si falta una
        # librería del sistema el servicio queda en model_error, no crashea.
        from .pipeline import PipelineManager
        STATE["dependenciesLoaded"] = True
    except Exception as exc:  # noqa: BLE001
        log.exception("no se pudieron importar las dependencias de video")
        STATE["importError"] = str(exc)
        STATE["serviceStatus"] = "model_error"
        STATE["lastBootAt"] = _now_iso()
        return

    manager = PipelineManager()
    STATE["manager"] = manager
    manager.start()  # internamente maneja fallo de modelo con reintentos
    STATE["serviceStatus"] = "running"
    STATE["lastBootAt"] = _now_iso()
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
        # Diagnóstico granular para que el frontend distinga capas del problema.
        "dependenciesLoaded": STATE["dependenciesLoaded"],
        "importError": STATE["importError"],
        "configError": STATE["configError"],
        "provider": STATE["provider"],
        "hint": _diagnostic_hint(),
        "bootStartedAt": STATE["bootStartedAt"],
        "lastBootAt": STATE["lastBootAt"],
        "lastRefresh": None,
        "lastRefreshError": None,
        "workers": [],
    }
    if manager is None:
        return base
    merged = {**base, **manager.status()}
    # workersRunning/Error derivados del estado de cada worker para la UI.
    workers = merged.get("workers") or []
    merged["workersRunning"] = sum(1 for w in workers if w.get("status") == "running")
    merged["workersError"] = sum(
        1 for w in workers if w.get("status") in ("rtsp_down", "disabled_due_errors")
    )
    return merged


@app.get("/frame/{camera_id}")
def frame(camera_id: str):
    """Último frame anotado (JPEG) del worker de esa cámara — alimenta la
    'Vista analítica en vivo' del frontend vía proxy del API.

    Contrato de estados (para no tratar 'aún sin frame' como error):
      200 + image/jpeg  frame disponible
      204 No Content    worker activo pero todavía sin frame anotado
      404 Not Found     no hay worker para esa cámara (config deshabilitada, etc.)
      503               el servicio aún no terminó de arrancar (sin manager)
    """
    manager = STATE["manager"]
    if manager is None:
        return Response(status_code=503)
    if not manager.has_worker(camera_id):
        return Response(status_code=404)
    jpeg = manager.get_last_frame(camera_id)
    if not jpeg:
        return Response(status_code=204)  # worker activo, sin frame todavía
    return Response(content=jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})
