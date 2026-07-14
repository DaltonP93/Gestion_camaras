# apps/analytics/app/rules.py
# Lógica PURA de reglas del pipeline analítico — sin cv2/onnx/supervision, para
# que sea testeable con stdlib. Cubre cooldown por clave, deduplicación por
# tracker id, ventanas horarias, backoff exponencial y circuit breaker.
from __future__ import annotations

import time
from dataclasses import dataclass, field


class CooldownTracker:
    """Evita emitir el mismo evento (por clave) más de una vez por cooldown."""
    def __init__(self) -> None:
        self._last: dict[str, float] = {}

    def should_emit(self, key: str, cooldown_sec: float, now: float | None = None) -> bool:
        t = time.time() if now is None else now
        if t - self._last.get(key, 0.0) < cooldown_sec:
            return False
        self._last[key] = t
        return True

    def reset(self, key: str) -> None:
        self._last.pop(key, None)


class TrackDedup:
    """Reporta un tracker id como "nuevo" una sola vez (con tope de memoria)."""
    def __init__(self, cap: int = 5000) -> None:
        self._seen: set[int] = set()
        self._cap = cap

    def is_new(self, track_id: int) -> bool:
        if track_id in self._seen:
            return False
        self._seen.add(track_id)
        if len(self._seen) > self._cap:
            self._seen.clear()
            self._seen.add(track_id)
        return True

    def forget(self, track_id: int) -> None:
        self._seen.discard(track_id)


def _parse_hhmm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def within_schedule(schedule: list[dict] | None, now: time.struct_time | None = None) -> bool:
    """¿El momento actual cae dentro del horario configurado?
    schedule = None/[] → siempre activo. Cada entrada:
      {"days": [0..6 lunes=0], "start": "HH:MM", "end": "HH:MM"}
    Soporta ventanas que cruzan medianoche (start > end)."""
    if not schedule:
        return True
    t = now or time.localtime()
    minute_of_day = t.tm_hour * 60 + t.tm_min
    weekday = t.tm_wday  # lunes=0
    for entry in schedule:
        days = entry.get("days")
        if days and weekday not in days:
            continue
        start = _parse_hhmm(entry.get("start", "00:00"))
        end = _parse_hhmm(entry.get("end", "23:59"))
        if start <= end:
            if start <= minute_of_day <= end:
                return True
        else:  # cruza medianoche
            if minute_of_day >= start or minute_of_day <= end:
                return True
    return False


def backoff_delay(failure_count: int, schedule: tuple[int, ...]) -> int:
    """Delay del intento `failure_count` (1-based) según la escala de backoff."""
    if failure_count <= 0:
        return 0
    idx = min(failure_count - 1, len(schedule) - 1)
    return schedule[idx]


@dataclass
class _ZoneOccupant:
    incident_id: str
    entered_at: float
    last_seen: float
    loitering_emitted: bool = False
    last_reminder_at: float = 0.0


class ZoneIntrusionTracker:
    """Máquina de estado para deduplicar intrusiones de zona.

    Clave: (camera_id, zone_name, track_id). Un objeto que ENTRA a una zona
    genera UNA sola ``zone_intrusion`` (con incident_id). Mientras permanezca
    dentro NO se repite; opcionalmente emite ``loitering`` tras ``loitering_sec``
    y ``zone_reminder`` cada ``reminder_sec`` (marcado como recordatorio, no como
    nueva intrusión). Sólo se re-arma después de SALIR.

    La salida se detecta por ausencia: si un track deja de verse dentro de la zona
    durante más de ``lost_grace_sec`` se considera que salió (tolerancia ante
    pérdida momentánea del tracker para no reabrir el mismo incidente al instante).

    Uso por frame:
      for (zone, track) inside this frame: mark_inside(...)
      events += sweep_exits(now)                 # una vez por frame
    """

    def __init__(self, lost_grace_sec: float = 5.0) -> None:
        self._occ: dict[tuple[str, str, int], _ZoneOccupant] = {}
        self._lost_grace = lost_grace_sec

    @staticmethod
    def _incident_id(camera_id: str, zone_name: str, track_id: int, entered_at: float) -> str:
        return f"{camera_id}:{zone_name}:{track_id}:{int(entered_at * 1000)}"

    def mark_inside(
        self,
        camera_id: str,
        zone_name: str,
        track_id: int,
        now: float,
        *,
        loitering_sec: float | None = None,
        reminder_sec: float | None = None,
    ) -> list[dict]:
        """Registra que (track) está dentro de (zone) en este frame.
        Devuelve los eventos a emitir (0..2)."""
        key = (camera_id, zone_name, track_id)
        events: list[dict] = []
        occ = self._occ.get(key)

        if occ is None:
            # outside → inside: nueva intrusión
            incident_id = self._incident_id(camera_id, zone_name, track_id, now)
            occ = _ZoneOccupant(incident_id=incident_id, entered_at=now, last_seen=now)
            self._occ[key] = occ
            events.append({
                "type": "zone_intrusion", "camera_id": camera_id, "zone_name": zone_name,
                "track_id": track_id, "incident_id": incident_id, "reminder": False,
            })
            return events

        # Ya estaba dentro: refrescar last_seen, sin nueva intrusión
        occ.last_seen = now
        dwell = now - occ.entered_at

        if loitering_sec is not None and not occ.loitering_emitted and dwell >= loitering_sec:
            occ.loitering_emitted = True
            events.append({
                "type": "loitering", "camera_id": camera_id, "zone_name": zone_name,
                "track_id": track_id, "incident_id": occ.incident_id, "reminder": False,
                "dwell_sec": dwell,
            })

        if reminder_sec is not None and reminder_sec > 0:
            base = occ.last_reminder_at or occ.entered_at
            if now - base >= reminder_sec:
                occ.last_reminder_at = now
                events.append({
                    "type": "zone_reminder", "camera_id": camera_id, "zone_name": zone_name,
                    "track_id": track_id, "incident_id": occ.incident_id, "reminder": True,
                    "dwell_sec": dwell,
                })
        return events

    def sweep_exits(self, now: float) -> list[dict]:
        """Emite ``zone_exit`` para ocupantes que no se vieron dentro de la zona
        en más de ``lost_grace_sec`` y los remueve (re-arma para futuras entradas)."""
        events: list[dict] = []
        expired = [k for k, o in self._occ.items() if (now - o.last_seen) > self._lost_grace]
        for key in expired:
            occ = self._occ.pop(key)
            camera_id, zone_name, track_id = key
            events.append({
                "type": "zone_exit", "camera_id": camera_id, "zone_name": zone_name,
                "track_id": track_id, "incident_id": occ.incident_id, "reminder": False,
                "dwell_sec": occ.last_seen - occ.entered_at,
            })
        return events

    def active_incidents(self) -> int:
        return len(self._occ)


@dataclass
class CircuitBreaker:
    """Circuit breaker por worker: tras `max_failures` fallos consecutivos se
    abre (disabled_due_errors). Un éxito lo resetea."""
    max_failures: int = 5
    failures: int = 0
    opened: bool = field(default=False)

    def record_failure(self) -> bool:
        self.failures += 1
        if self.failures >= self.max_failures:
            self.opened = True
        return self.opened

    def record_success(self) -> None:
        self.failures = 0
        self.opened = False

    def is_open(self) -> bool:
        return self.opened
