# apps/analytics/app/frigate/client.py
# I/O HTTP contra la API de Frigate. `httpx` (ya es dependencia del servicio) se
# importa de forma PEREZOSA dentro de los métodos: importar este módulo NO
# arrastra httpx, así el ingestor y sus tests se pueden importar sin pip install.
#
# El cliente es inyectable/fakeable: se le puede pasar un `transport` con la firma
# `get(url, params=None) -> Response`-like (atributos .status_code, .json(),
# .content). Sin transport, crea un httpx.Client perezosamente.
from __future__ import annotations

import base64
import logging
from typing import Any

log = logging.getLogger("analytics.frigate.client")

# Default razonable para la cota del snapshot base64 (5 MiB): muy por encima de
# un JPEG de snapshot típico, protege ante un cuerpo anómalo/enorme.
DEFAULT_MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024


class FrigateHttpClient:
    """Cliente de la API HTTP de Frigate (polling de eventos + snapshots).

    SSRF: `base_url` es SIEMPRE de configuración (FRIGATE_URL), nunca derivado de
    un evento. Los ids de snapshot provienen de eventos de Frigate y solo se usan
    como segmento de path del propio `base_url`.
    """

    def __init__(
        self,
        base_url: str,
        *,
        transport: Any = None,
        timeout: float = 15.0,
        max_snapshot_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES,
    ) -> None:
        self._base = (base_url or "").rstrip("/")
        self._timeout = timeout
        self._transport = transport  # inyectable para tests; None → httpx perezoso
        self._client: Any = None
        # Cota del snapshot base64. <= 0 ⇒ sin límite.
        try:
            self._max_snapshot_bytes = int(max_snapshot_bytes)
        except (TypeError, ValueError):
            self._max_snapshot_bytes = DEFAULT_MAX_SNAPSHOT_BYTES

    # ── transporte perezoso ────────────────────────────────────────────────
    def _get(self, path: str, params: dict | None = None) -> Any:
        if self._transport is not None:
            return self._transport.get(self._base + path, params=params)
        if self._client is None:
            import httpx  # import perezoso: no se carga al importar el módulo
            self._client = httpx.Client(timeout=self._timeout)
        return self._client.get(self._base + path, params=params)

    # ── API ────────────────────────────────────────────────────────────────
    def get_events(
        self,
        *,
        after: float | None = None,
        limit: int = 100,
        extra_params: dict | None = None,
    ) -> list[dict]:
        """`GET /api/events` con cursor `after` (epoch seg). Devuelve lista de objetos.

        Frigate ordena por `start_time` desc por defecto; el ingestor filtra/ordena
        por su cuenta y deduplica por `id`, así que un solapamiento del cursor no
        genera POSTs repetidos.
        """
        params: dict[str, Any] = {"limit": int(limit)}
        if after is not None:
            params["after"] = after
        if extra_params:
            params.update(extra_params)
        resp = self._get("/api/events", params=params)
        status = getattr(resp, "status_code", 200)
        if status != 200:
            log.warning("frigate_get_events_status status=%s", status)
            return []
        data = resp.json()
        if isinstance(data, list):
            return [e for e in data if isinstance(e, dict)]
        return []

    def get_snapshot_b64(self, event_id: str) -> str | None:
        """Descarga `/api/events/<id>/snapshot.jpg` y devuelve base64 sin prefijo.

        None si falla (el evento se POSTea igual sin snapshot; es opcional en el
        eventSchema).
        """
        if not event_id:
            return None
        try:
            resp = self._get(f"/api/events/{event_id}/snapshot.jpg")
        except Exception as exc:  # noqa: BLE001
            log.warning("frigate_snapshot_error id=%s err=%s", event_id, exc)
            return None
        if getattr(resp, "status_code", 200) != 200:
            return None
        limit = self._max_snapshot_bytes
        # Rechazo temprano por Content-Length declarado, antes de leer el cuerpo.
        if limit > 0:
            declared = self._declared_length(resp)
            if declared is not None and declared > limit:
                log.warning(
                    "frigate_snapshot_too_large id=%s content_length=%s limit=%s",
                    event_id, declared, limit,
                )
                return None
        content = getattr(resp, "content", None)
        if not content:
            return None
        # Cota efectiva sobre el cuerpo ya materializado (por si no vino
        # Content-Length o mintió): se descarta el snapshot, el evento se POSTea
        # igual (es opcional en el eventSchema).
        if limit > 0 and len(content) > limit:
            log.warning(
                "frigate_snapshot_too_large id=%s bytes=%s limit=%s",
                event_id, len(content), limit,
            )
            return None
        return base64.b64encode(content).decode("ascii")

    @staticmethod
    def _declared_length(resp: Any) -> int | None:
        """Content-Length declarado (int) o None si ausente/ilegible."""
        headers = getattr(resp, "headers", None)
        if headers is None:
            return None
        try:
            raw = headers.get("content-length")
        except Exception:  # noqa: BLE001 — headers no dict-like
            return None
        if raw is None:
            return None
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            except Exception:  # noqa: BLE001
                pass
            self._client = None
