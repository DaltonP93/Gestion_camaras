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
