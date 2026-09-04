# Tests de la lógica de decisión del ingestor Frigate: plan_events (normalize +
# derive integrados), IngestDecider (dedup/cooldown/filtro) y el gate
# FRIGATE_ENABLED — todo con fakes inyectados, SOLO stdlib (sin httpx/pydantic).
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.frigate.ingestor import plan_events, IngestDecider, FrigateIngestor  # noqa: E402
from app.frigate.derive import FrigateDeriver  # noqa: E402
from app.frigate import camera_map as cm  # noqa: E402

VALID_TYPES = {
    "person", "vehicle", "zone_intrusion", "line_crossing",
    "loitering", "occupancy_limit", "zone_exit", "zone_reminder",
}


def obj(**kw):
    base = {"id": "e1", "camera": "cam_front", "label": "person", "score": 0.9,
            "start_time": 1700000000, "current_zones": [], "entered_zones": []}
    base.update(kw)
    return {"type": "update", "before": {}, "after": base}


class TestPlanEvents(unittest.TestCase):
    def test_primario_person(self):
        d = FrigateDeriver()
        out = plan_events(obj(), camera_map={"cam_front": "uuid-1"}, deriver=d,
                          min_confidence=0.6)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["type"], "person")
        self.assertEqual(out[0]["cameraId"], "uuid-1")

    def test_camara_desconocida_skip(self):
        d = FrigateDeriver()
        out = plan_events(obj(camera="otra"), camera_map={"cam_front": "uuid-1"},
                          deriver=d)
        self.assertEqual(out, [])

    def test_clase_no_soportada_skip(self):
        d = FrigateDeriver()
        out = plan_events(obj(label="dog"), camera_map={}, deriver=d)
        self.assertEqual(out, [])

    def test_zone_intrusion_y_line_crossing(self):
        d = FrigateDeriver()
        out = plan_events(
            obj(entered_zones=["Entrada"], current_zones=["Entrada"]),
            camera_map={}, deriver=d, min_confidence=0.6)
        types = {p["type"] for p in out}
        # primario zone_intrusion + line_crossing "in" derivado de la transición
        self.assertIn("zone_intrusion", types)
        self.assertIn("line_crossing", types)
        lc = [p for p in out if p["type"] == "line_crossing"][0]
        self.assertEqual(lc["direction"], "in")
        self.assertEqual(lc["zoneName"], "Entrada")

    def test_line_crossing_out_al_salir(self):
        d = FrigateDeriver()
        plan_events(obj(current_zones=["Z"]), camera_map={}, deriver=d)
        out = plan_events(obj(current_zones=[]), camera_map={}, deriver=d)
        lc = [p for p in out if p["type"] == "line_crossing"]
        self.assertEqual(lc[0]["direction"], "out")

    def test_loitering(self):
        d = FrigateDeriver()
        out = plan_events(obj(stationary=True, current_zones=["P"]),
                          camera_map={}, deriver=d)
        self.assertTrue(any(p["type"] == "loitering" for p in out))

    def test_occupancy_limit(self):
        d = FrigateDeriver()
        d.update("cam_front", "a", ["Sala"])
        d.update("cam_front", "b", ["Sala"])
        # tercer track entra a Sala con límite 2 → supera
        out = plan_events(
            obj(id="c", current_zones=["Sala"]), camera_map={}, deriver=d,
            occupancy_limits={"Sala": 2})
        self.assertTrue(any(p["type"] == "occupancy_limit" for p in out))

    def test_todos_los_tipos_validos(self):
        d = FrigateDeriver()
        out = plan_events(obj(entered_zones=["E"], current_zones=["E"]),
                          camera_map={}, deriver=d)
        for p in out:
            self.assertIn(p["type"], VALID_TYPES)


class TestIngestDecider(unittest.TestCase):
    def _payload(self, **kw):
        base = {"cameraId": "c", "type": "person", "className": "person",
                "confidence": 0.9, "occurredAt": "2023-01-01T00:00:00.000Z",
                "_sig": "e1:person:-"}
        base.update(kw)
        return base

    def test_filtro_clase(self):
        dec = IngestDecider(min_confidence=0.6)
        self.assertFalse(dec.decide(self._payload(className="dog")))

    def test_filtro_confianza(self):
        dec = IngestDecider(min_confidence=0.6)
        self.assertFalse(dec.decide(self._payload(confidence=0.4)))

    def test_dedup_por_firma(self):
        dec = IngestDecider(min_confidence=0.6, cooldown_sec=0)  # cooldown off
        self.assertTrue(dec.decide(self._payload(_sig="e1:person:-")))
        # misma firma → no se re-POSTea (idempotencia del cursor de polling)
        self.assertFalse(dec.decide(self._payload(_sig="e1:person:-")))

    def test_cooldown_throttle(self):
        dec = IngestDecider(min_confidence=0.6, cooldown_sec=60)
        # dos eventos distintos (dedup pasa) pero misma clave de cooldown
        self.assertTrue(dec.decide(self._payload(_sig="e1:person:-"), now=1000.0))
        self.assertFalse(dec.decide(self._payload(_sig="e2:person:-"), now=1010.0))
        # pasado el cooldown, vuelve a emitir
        self.assertTrue(dec.decide(self._payload(_sig="e3:person:-"), now=1061.0))


def fake_settings(**over):
    base = dict(
        frigate_enabled=True, frigate_ingest_mode="http",
        frigate_poll_interval_sec=1, frigate_camera_map="",
        frigate_min_confidence=0.6,
        frigate_supported_classes="person,car,truck,bus,motorcycle,bicycle",
        frigate_fetch_snapshots=False, frigate_url="http://frigate:5000",
        api_base_url="http://api:4000", analytics_secret="secret",
    )
    base.update(over)
    return SimpleNamespace(**base)


class FakeClient:
    def __init__(self, events=None, snapshot=None):
        self._events = events or []
        self._snapshot = snapshot
        self.snapshot_calls = 0

    def get_events(self, *, after=None, limit=100):
        return list(self._events)

    def get_snapshot_b64(self, event_id):
        self.snapshot_calls += 1
        return self._snapshot


class TestFrigateIngestorDecision(unittest.TestCase):
    def _mk(self, settings, client=None):
        posted = []
        ing = FrigateIngestor(
            settings=settings,
            poster=lambda p: (posted.append(p) or True),
            client=client or FakeClient(),
        )
        return ing, posted

    def test_process_event_postea(self):
        ing, posted = self._mk(fake_settings())
        ing.process_event(obj(camera="cam_front"))
        self.assertEqual(len(posted), 1)
        self.assertEqual(posted[0]["type"], "person")
        self.assertEqual(ing.events_posted, 1)

    def test_dedup_entre_polls(self):
        ing, posted = self._mk(fake_settings())
        ev = obj(camera="cam_front")
        ing.process_event(ev)
        ing.process_event(ev)  # mismo evento re-polleado → no duplica
        self.assertEqual(len(posted), 1)

    def test_camara_desconocida_no_postea(self):
        ing, posted = self._mk(fake_settings(frigate_camera_map='{"otra": "uuid"}'))
        ing.process_event(obj(camera="cam_front"))
        self.assertEqual(posted, [])

    def test_snapshot_adjunto(self):
        client = FakeClient(snapshot="QkFTRTY0")
        ing, posted = self._mk(fake_settings(frigate_fetch_snapshots=True), client)
        ing.process_event(obj(camera="cam_front"))
        self.assertEqual(len(posted), 1)
        self.assertEqual(posted[0]["snapshotJpegBase64"], "QkFTRTY0")
        self.assertEqual(client.snapshot_calls, 1)

    def test_gate_disabled_no_postea(self):
        # FRIGATE_ENABLED=false ⇒ run() no consume ni POSTea nada.
        client = FakeClient(events=[obj(camera="cam_front")["after"]])
        ing, posted = self._mk(fake_settings(frigate_enabled=False), client)
        ing.run()  # retorna de inmediato
        self.assertEqual(posted, [])
        self.assertEqual(ing.status, "disabled")

    def test_exclusion_mutua_camera_ids(self):
        ing, _ = self._mk(fake_settings(frigate_camera_map='{"cam_front": "uuid-1"}'))
        self.assertEqual(ing.mapped_camera_ids(), {"uuid-1"})


if __name__ == "__main__":
    unittest.main()
