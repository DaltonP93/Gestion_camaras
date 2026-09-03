# apps/analytics/app/frigate/normalize.py
# PURO (stdlib only): traduce un evento de Frigate al payload interno que valida
# el `eventSchema` de apps/api (analytics.ts:73-87). Sin httpx/cv2/onnx/pydantic
# para que sea testeable en el CI sin pip install.
#
# Mapeo (design doc §5):
#   camera      → cameraId   (lo resuelve camera_map.py; acá se recibe ya resuelto)
#   label       → className  (person/car/truck/bus/motorcycle/bicycle; otros → None)
#   label       → type       (person→person; vehículo→vehicle;
#                             entered_zones≠∅ → zone_intrusion; stationary → loitering)
#   score/top_score → confidence  (0..1)
#   id (string) → trackId    (hash estable → int, ver stable_track_id)
#   current/entered_zones → zoneName
#   id          → incidentId (cam:zona:id para correlacionar entrada/salida)
#   start_time×1000 → occurredAt (ISO-8601 UTC con sufijo .000Z)
#   box         → bboxes      ([[x1,y1,x2,y2,conf,"clase"]])
from __future__ import annotations

import hashlib
import time
from typing import Any

# Clases COCO soportadas por VisionCore (== SUPPORTED_CLASSES de analytics.ts).
# Frigate ya usa etiquetas COCO, así que no hay remapeo de nombres, solo filtro.
VEHICLE_LABELS = frozenset({"car", "truck", "bus", "motorcycle", "bicycle"})
DEFAULT_SUPPORTED_CLASSES = frozenset({"person"} | VEHICLE_LABELS)

# Tipos del enum `type` del eventSchema (analytics.ts:75). normalize solo produce
# los "primarios"; line_crossing/occupancy_limit los deriva derive.py.
_PRIMARY_TYPES = frozenset(
    {"person", "vehicle", "zone_intrusion", "loitering"}
)


def stable_track_id(raw_id: Any) -> int:
    """Hash estable string→int para `trackId`.

    Frigate identifica cada objeto con un id string (p.ej. "1699...-abc"). El
    eventSchema exige `trackId` int. Usamos SHA-1 truncado a 31 bits para obtener
    un entero POSITIVO y estable entre corridas (no `hash()`, que varía por
    PYTHONHASHSEED). 31 bits entra holgado en un int seguro de JSON/JS.
    """
    s = "" if raw_id is None else str(raw_id)
    digest = hashlib.sha1(s.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) & 0x7FFFFFFF


def epoch_to_iso(epoch_seconds: float | int | None) -> str:
    """epoch (segundos, como da Frigate en `start_time`) → ISO-8601 UTC `.000Z`.

    Formato idéntico al que ya produce pipeline.py (_post_event): sin
    microsegundos y con sufijo literal `.000Z` para cumplir z.string().datetime().
    """
    if epoch_seconds is None:
        t = time.gmtime()
    else:
        t = time.gmtime(float(epoch_seconds))
    return time.strftime("%Y-%m-%dT%H:%M:%S", t) + ".000Z"


def frigate_box_to_bbox(box: Any, confidence: float, class_name: str) -> list | None:
    """Convierte el `box` de un objeto Frigate a una fila de `bboxes`.

    Frigate reporta el box del objeto rastreado como `[x1, y1, x2, y2]` en píxeles.
    El eventSchema pide filas `[x1, y1, x2, y2, conf, "clase"]`. Si el box no es
    una lista de 4 números, se descarta (bboxes es opcional en el schema).
    """
    if not isinstance(box, (list, tuple)) or len(box) < 4:
        return None
    try:
        x1, y1, x2, y2 = (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
    except (TypeError, ValueError):
        return None
    return [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1),
            round(float(confidence), 3), str(class_name)]


def select_object(event: dict) -> dict | None:
    """Devuelve el objeto relevante de un evento Frigate.

    Acepta tanto el wrapper `{"type","before","after"}` (MQTT `frigate/events`)
    como un objeto de la API `GET /api/events` (que ya es el objeto plano).
    Prefiere `after`; cae a `before`; si no hay ninguno, asume que `event` YA es
    el objeto.
    """
    if not isinstance(event, dict):
        return None
    after = event.get("after")
    if isinstance(after, dict):
        return after
    before = event.get("before")
    if isinstance(before, dict):
        return before
    # objeto plano de la API de eventos
    if "label" in event or "id" in event or "camera" in event:
        return event
    return None


def object_confidence(obj: dict) -> float:
    """`score` (instantáneo) o `top_score` (máximo del track). 0.0 si falta."""
    for k in ("score", "top_score"):
        v = obj.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    return 0.0


def object_zone(obj: dict) -> str | None:
    """Zona representativa: primera `entered_zones`, si no primera `current_zones`."""
    for k in ("entered_zones", "current_zones"):
        zs = obj.get(k)
        if isinstance(zs, (list, tuple)) and zs:
            return str(zs[0])
    return None


def classify_type(label: str, obj: dict) -> str | None:
    """Deriva el `type` primario del eventSchema a partir del objeto Frigate.

    Prioridad: zona (intrusión) > permanencia (loitering) > persona/vehículo.
    Devuelve None si la etiqueta no es una clase soportada.
    """
    if label == "person":
        base = "person"
    elif label in VEHICLE_LABELS:
        base = "vehicle"
    else:
        return None
    entered = obj.get("entered_zones")
    if isinstance(entered, (list, tuple)) and entered:
        return "zone_intrusion"
    if obj.get("stationary") is True:
        return "loitering"
    return base


def build_payload(
    camera_id: str,
    ev_type: str,
    class_name: str,
    confidence: float,
    *,
    track_id: int | None = None,
    zone_name: str | None = None,
    direction: str | None = None,
    bboxes: list | None = None,
    incident_id: str | None = None,
    occurred_at: str | None = None,
    snapshot_b64: str | None = None,
) -> dict:
    """Ensambla un dict conforme al `eventSchema` interno.

    Igual criterio que pipeline.py._post_event: se dropean las claves opcionales
    con valor None. `cameraId`, `type`, `className`, `confidence` y `occurredAt`
    son obligatorios y siempre quedan presentes (occurredAt cae a "ahora").
    """
    payload = {
        "cameraId": camera_id,
        "type": ev_type,
        "className": class_name,
        "confidence": round(float(confidence), 3),
        "trackId": int(track_id) if track_id is not None else None,
        "zoneName": zone_name,
        "direction": direction,
        "bboxes": bboxes,
        "incidentId": incident_id,
        "occurredAt": occurred_at or epoch_to_iso(None),
        "snapshotJpegBase64": snapshot_b64,
    }
    return {k: v for k, v in payload.items() if v is not None}


def normalize_event(
    event: dict,
    camera_id: str,
    *,
    min_confidence: float = 0.0,
    supported_classes: frozenset | set | None = None,
    snapshot_b64: str | None = None,
) -> dict | None:
    """Evento Frigate (wrapper o objeto) → payload interno, o None si se descarta.

    Descarta cuando: no hay objeto, la etiqueta no está soportada, o la confianza
    no alcanza `min_confidence`. `camera_id` ya viene resuelto por camera_map.py.
    Solo produce el evento PRIMARIO; line_crossing/occupancy_limit los agrega el
    ingestor vía derive.py.
    """
    supported = supported_classes if supported_classes is not None else DEFAULT_SUPPORTED_CLASSES
    obj = select_object(event)
    if obj is None or not camera_id:
        return None

    label = obj.get("label")
    if not isinstance(label, str) or label not in supported:
        return None

    ev_type = classify_type(label, obj)
    if ev_type is None:
        return None

    confidence = object_confidence(obj)
    if confidence < float(min_confidence):
        return None

    zone_name = object_zone(obj)
    raw_id = obj.get("id")
    track_id = stable_track_id(raw_id)
    # incidentId correlaciona entrada/permanencia/salida del mismo objeto de zona.
    incident_id = None
    if raw_id is not None:
        incident_id = f"{camera_id}:{zone_name or '-'}:{raw_id}"[:120]

    occurred_at = epoch_to_iso(obj.get("start_time"))

    bbox = frigate_box_to_bbox(obj.get("box"), confidence, label)
    bboxes = [bbox] if bbox is not None else None

    return build_payload(
        camera_id, ev_type, label, confidence,
        track_id=track_id,
        zone_name=zone_name if ev_type in ("zone_intrusion", "loitering") else None,
        bboxes=bboxes,
        incident_id=incident_id if ev_type in ("zone_intrusion", "loitering") else None,
        occurred_at=occurred_at,
        snapshot_b64=snapshot_b64,
    )
