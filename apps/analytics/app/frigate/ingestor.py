# apps/analytics/app/frigate/ingestor.py
# Orquesta la ingesta de eventos de Frigate hacia el endpoint interno de analítica.
#
#   consumir (HTTP polling por defecto) → resolver cámara (camera_map)
#   → normalizar (normalize) → derivar line_crossing/occupancy (derive)
#   → decidir (dedup por id + cooldown + filtro clase/confianza, rules.py)
#   → (opcional) snapshot base64 → POST /api/analytics/internal/events
#
# Estructura: la LÓGICA (plan_events + IngestDecider) es pura y testeable con
# dicts/fakes; `FrigateIngestor` es el hilo de I/O que hace imports pesados
# (config/httpx/client) de forma PEREZOSA para no romper el CI ni el arranque.
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from ..rules import CooldownTracker, TrackDedup
from . import camera_map as camera_map_mod
from . import normalize as norm
from .derive import FrigateDeriver

log = logging.getLogger("analytics.frigate.ingestor")


# ── Planificación pura de eventos ──────────────────────────────────────────
def plan_events(
    event: dict,
    *,
    camera_map: dict[str, str],
    deriver: FrigateDeriver,
    known_ids: set[str] | frozenset[str] | None = None,
    min_confidence: float = 0.0,
    supported_classes: frozenset | set | None = None,
    occupancy_limits: dict[str, int] | None = None,
    snapshot_b64: str | None = None,
) -> list[dict]:
    """Un evento Frigate → lista de payloads candidatos (aún sin dedup/cooldown).

    PURO salvo el estado del `deriver` (transiciones de zona). No hace I/O.
    Produce, según corresponda:
      - el evento primario (person/vehicle/zone_intrusion/loitering) vía normalize,
      - line_crossing (in/out) por cada transición de zona derivada,
      - occupancy_limit por cada zona cuya ocupación supere su límite.
    """
    supported = supported_classes if supported_classes is not None else norm.DEFAULT_SUPPORTED_CLASSES
    obj = norm.select_object(event)
    if obj is None:
        return []

    camera_id = camera_map_mod.resolve_camera_id(obj.get("camera"), camera_map, known_ids)
    if not camera_id:
        return []  # cámara desconocida → skip

    label = obj.get("label")
    if not isinstance(label, str) or label not in supported:
        return []

    confidence = norm.object_confidence(obj)
    raw_id = obj.get("id")
    track_id = norm.stable_track_id(raw_id)
    occurred_at = norm.epoch_to_iso(obj.get("start_time"))
    bbox = norm.frigate_box_to_bbox(obj.get("box"), confidence, label)
    bboxes = [bbox] if bbox is not None else None

    out: list[dict] = []

    # 1) Evento primario (respeta min_confidence dentro de normalize).
    primary = norm.normalize_event(
        event, camera_id,
        min_confidence=min_confidence, supported_classes=supported,
        snapshot_b64=snapshot_b64,
    )
    if primary is not None:
        primary["_sig"] = f"{raw_id}:{primary['type']}:{primary.get('zoneName') or '-'}"
        out.append(primary)

    # 2) line_crossing derivado de transiciones de zona.
    wrapper_type = event.get("type") if isinstance(event, dict) else None
    ended = bool(obj.get("end_time")) or wrapper_type == "end"
    transitions = deriver.update(camera_id, raw_id, obj.get("current_zones"), ended=ended)
    for tr in transitions:
        zone, direction = tr["zone"], tr["direction"]
        payload = norm.build_payload(
            camera_id, "line_crossing", label, confidence,
            track_id=track_id, zone_name=zone, direction=direction,
            bboxes=bboxes,
            incident_id=(f"{camera_id}:{zone}:{raw_id}"[:120] if raw_id is not None else None),
            occurred_at=occurred_at, snapshot_b64=snapshot_b64,
        )
        payload["_sig"] = f"{raw_id}:line:{zone}:{direction}"
        out.append(payload)

    # 3) occupancy_limit: zonas cuya ocupación supera el límite configurado.
    if occupancy_limits:
        current = obj.get("current_zones") or []
        seen_zones = {str(z) for z in current} if isinstance(current, (list, tuple)) else set()
        for zone in sorted(seen_zones):
            limit = occupancy_limits.get(zone)
            if limit and deriver.occupancy_exceeded(camera_id, zone, int(limit)):
                payload = norm.build_payload(
                    camera_id, "occupancy_limit", "person", 1.0,
                    zone_name=zone, occurred_at=occurred_at, snapshot_b64=snapshot_b64,
                )
                payload["_sig"] = f"{raw_id}:occ:{zone}"
                out.append(payload)

    return out


# ── Decisión: dedup + cooldown + filtro (reutiliza rules.py) ────────────────
class IngestDecider:
    """Decide si un payload candidato debe POSTearse.

    - Filtro: `className` soportada y `confidence >= min_confidence`.
    - Dedup: un mismo evento (por firma id:tipo:zona[:dir]) se POSTea una sola vez
      (idempotencia ante el solapamiento del cursor de polling HTTP). Reusa
      `TrackDedup` de rules.py hasheando la firma a int.
    - Cooldown: throttle por (cameraId|tipo|zona|dir) con `CooldownTracker`.
    """

    def __init__(
        self,
        *,
        min_confidence: float = 0.6,
        supported_classes: frozenset | set | None = None,
        cooldown_sec: float = 60.0,
        dedup_cap: int = 5000,
    ) -> None:
        self.min_confidence = float(min_confidence)
        self.supported = (
            frozenset(supported_classes) if supported_classes else norm.DEFAULT_SUPPORTED_CLASSES
        )
        self.cooldown_sec = float(cooldown_sec)
        self._cooldowns = CooldownTracker()
        self._dedup = TrackDedup(cap=dedup_cap)

    def _passes_filter(self, payload: dict) -> bool:
        if payload.get("className") not in self.supported:
            return False
        try:
            if float(payload.get("confidence", 0.0)) < self.min_confidence:
                return False
        except (TypeError, ValueError):
            return False
        return True

    def decide(self, payload: dict, *, signature: str | None = None, now: float | None = None) -> bool:
        if not self._passes_filter(payload):
            return False
        sig = signature if signature is not None else payload.get("_sig") or ""
        if not self._dedup.is_new(norm.stable_track_id(sig)):
            return False
        key = "|".join(
            str(payload.get(k) or "")
            for k in ("cameraId", "type", "zoneName", "direction")
        )
        if not self._cooldowns.should_emit(key, self.cooldown_sec, now=now):
            return False
        return True


# ── Hilo de ingesta (I/O; imports perezosos) ────────────────────────────────
class FrigateIngestor(threading.Thread):
    """Hilo que consume de Frigate y POSTea al endpoint interno de analítica.

    Arranca SOLO si `FRIGATE_ENABLED`. Como el resto del servicio, cualquier
    excepción se registra y NO tumba el proceso. Los imports de config/httpx/client
    son perezosos para no romper la compuerta de tests (stdlib-only).
    """

    def __init__(
        self,
        *,
        settings: Any = None,
        poster: Callable[[dict], bool] | None = None,
        client: Any = None,
    ) -> None:
        super().__init__(daemon=True, name="frigate-ingestor")
        if settings is None:
            # Import perezoso de config: mantiene el módulo importable sin pydantic
            # (compuerta de CI). Los tests inyectan un `settings` fake.
            from ..config import settings as _settings
            settings = _settings

        self._settings = settings
        self.stop_event = threading.Event()
        self.camera_map = camera_map_mod.load_camera_map(getattr(settings, "frigate_camera_map", ""))
        self.deriver = FrigateDeriver()
        self.decider = IngestDecider(
            min_confidence=float(getattr(settings, "frigate_min_confidence", 0.6)),
            supported_classes=_parse_classes(getattr(settings, "frigate_supported_classes", "")),
        )
        self._client = client
        self._poster = poster
        self._cursor: float | None = None
        # Estado observable
        self.status = "starting"
        self.events_seen = 0
        self.events_posted = 0
        self.last_error: str | None = None
        self.last_poll_at: float | None = None

    # ── I/O perezoso ────────────────────────────────────────────────────────
    def _ensure_client(self) -> Any:
        if self._client is None:
            from .client import FrigateHttpClient
            self._client = FrigateHttpClient(
                getattr(self._settings, "frigate_url", ""),
                max_snapshot_bytes=getattr(self._settings, "frigate_max_snapshot_bytes", 5 * 1024 * 1024),
            )
        return self._client

    def _default_poster(self, payload: dict) -> bool:
        import httpx  # perezoso

        body = {k: v for k, v in payload.items() if not k.startswith("_")}
        try:
            r = httpx.post(
                f"{self._settings.api_base_url}/api/analytics/internal/events",
                json=body,
                headers={"x-analytics-secret": self._settings.analytics_secret},
                timeout=15,
            )
            r.raise_for_status()
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("frigate_event_rejected type=%s err=%s", payload.get("type"), exc)
            return False

    def _post(self, payload: dict) -> None:
        poster = self._poster or self._default_poster
        if poster(payload):
            self.events_posted += 1
            log.info(
                "frigate_event_sent camera=%s type=%s class=%s zone=%s dir=%s",
                payload.get("cameraId"), payload.get("type"), payload.get("className"),
                payload.get("zoneName"), payload.get("direction"),
            )

    # ── Procesamiento de un evento (dedup/cooldown/filtro + snapshot + POST) ─
    def process_event(self, event: dict, *, now: float | None = None) -> int:
        self.events_seen += 1
        supported = self.decider.supported
        min_conf = self.decider.min_confidence
        candidates = plan_events(
            event,
            camera_map=self.camera_map,
            deriver=self.deriver,
            min_confidence=min_conf,
            supported_classes=supported,
        )
        if not candidates:
            return 0

        snapshot_b64 = None
        if getattr(self._settings, "frigate_fetch_snapshots", False):
            obj = norm.select_object(event) or {}
            ev_id = obj.get("id")
            if ev_id:
                snapshot_b64 = self._ensure_client().get_snapshot_b64(str(ev_id))

        posted = 0
        for payload in candidates:
            if not self.decider.decide(payload, now=now):
                continue
            if snapshot_b64 and "snapshotJpegBase64" not in payload:
                payload["snapshotJpegBase64"] = snapshot_b64
            self._post(payload)
            posted += 1
        return posted

    # ── Loop de polling HTTP ─────────────────────────────────────────────────
    def _poll_once(self) -> None:
        client = self._ensure_client()
        events = client.get_events(after=self._cursor, limit=100)
        self.last_poll_at = time.time()
        # Procesa en orden ascendente por start_time y avanza el cursor.
        events = sorted(events, key=lambda e: e.get("start_time") or 0)
        for ev in events:
            try:
                self.process_event(ev)
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)
                log.exception("frigate_process_error")
            st = ev.get("start_time")
            if isinstance(st, (int, float)):
                self._cursor = max(self._cursor or 0.0, float(st))

    def run(self) -> None:
        if not getattr(self._settings, "frigate_enabled", False):
            self.status = "disabled"
            log.info("frigate_ingestor_disabled (FRIGATE_ENABLED=false)")
            return
        mode = str(getattr(self._settings, "frigate_ingest_mode", "http")).lower()
        if mode == "mqtt":
            self.status = "mqtt"
            from .mqtt_consumer import run_mqtt_consumer
            run_mqtt_consumer(self._settings, self.process_event, self.stop_event)
            return

        self.status = "running"
        interval = max(1, int(getattr(self._settings, "frigate_poll_interval_sec", 5)))
        log.info("frigate_ingestor_started mode=http interval=%ds", interval)
        while not self.stop_event.is_set():
            try:
                self._poll_once()
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)
                log.warning("frigate_poll_error err=%s", exc)
            if self.stop_event.wait(interval):
                break
        self.status = "stopped"
        log.info("frigate_ingestor_stopped")

    def stop(self) -> None:
        self.stop_event.set()

    def mapped_camera_ids(self) -> set[str]:
        """cameraIds VisionCore cubiertos por el mapa (para exclusión mutua con
        los workers YOLOX nativos)."""
        return set(self.camera_map.values())


def _parse_classes(raw: Any) -> frozenset:
    """CSV de clases → frozenset (fallback a las soportadas por defecto)."""
    if isinstance(raw, (set, frozenset, list, tuple)):
        vals = {str(x).strip() for x in raw if str(x).strip()}
    elif isinstance(raw, str) and raw.strip():
        vals = {c.strip() for c in raw.split(",") if c.strip()}
    else:
        vals = set()
    return frozenset(vals) if vals else norm.DEFAULT_SUPPORTED_CLASSES
