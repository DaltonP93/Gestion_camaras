# apps/analytics/app/frigate/derive.py
# PURO (stdlib only): deriva eventos que Frigate no entrega directamente a partir
# de transiciones de zona y conteo de tracks:
#   - line_crossing (in/out): entrar a una zona = "in", salir = "out".
#   - occupancy_limit: nº de tracks distintos dentro de una zona supera un límite.
# Estado por cámara. Sin httpx/cv2/onnx para ser testeable sin pip install.
from __future__ import annotations

from typing import Any


class FrigateDeriver:
    """Estado por (cámara, track) de las zonas ocupadas, para derivar cruces y aforo.

    Frigate reporta `current_zones` por objeto en cada actualización. Comparando
    contra la observación previa del mismo track se detecta qué zonas ENTRÓ
    (dirección "in") y cuáles DEJÓ (dirección "out"). El conteo de tracks
    distintos por zona da la ocupación para `occupancy_limit`.
    """

    def __init__(self) -> None:
        # (camera_id, track_id) -> set(zonas actuales)
        self._track_zones: dict[tuple[str, str], set[str]] = {}

    @staticmethod
    def _norm_zones(zones: Any) -> set[str]:
        if isinstance(zones, (list, tuple, set)):
            return {str(z) for z in zones}
        return set()

    def update(
        self,
        camera_id: str,
        track_id: Any,
        current_zones: Any,
        *,
        ended: bool = False,
    ) -> list[dict]:
        """Registra las zonas actuales de un track y devuelve las transiciones.

        Devuelve una lista de dicts `{"zone": <str>, "direction": "in"|"out"}`.
        Con `ended=True` (evento tipo "end" de Frigate) el track se considera fuera
        de todas sus zonas → genera los "out" pendientes y se olvida el track.
        """
        key = (str(camera_id), str(track_id))
        prev = self._track_zones.get(key, set())
        cur: set[str] = set() if ended else self._norm_zones(current_zones)

        transitions: list[dict] = []
        for z in sorted(cur - prev):
            transitions.append({"zone": z, "direction": "in"})
        for z in sorted(prev - cur):
            transitions.append({"zone": z, "direction": "out"})

        if ended or not cur:
            self._track_zones.pop(key, None)
        else:
            self._track_zones[key] = cur
        return transitions

    def occupancy(self, camera_id: str, zone: str) -> int:
        """Nº de tracks distintos actualmente dentro de `zone` en `camera_id`."""
        cam = str(camera_id)
        z = str(zone)
        return sum(1 for (c, _t), zs in self._track_zones.items() if c == cam and z in zs)

    def occupancy_exceeded(self, camera_id: str, zone: str, limit: int) -> bool:
        """¿La ocupación de la zona supera `limit`? (límite <=0 → nunca)."""
        if not limit or limit <= 0:
            return False
        return self.occupancy(camera_id, zone) > int(limit)

    def active_tracks(self) -> int:
        return len(self._track_zones)

    def forget_camera(self, camera_id: str) -> None:
        """Olvida el estado de una cámara (p.ej. al desmapearla)."""
        cam = str(camera_id)
        for key in [k for k in self._track_zones if k[0] == cam]:
            self._track_zones.pop(key, None)
