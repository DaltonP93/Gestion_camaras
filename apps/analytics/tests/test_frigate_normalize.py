# Tests del normalizador Frigate → payload interno (eventSchema).
# SOLO stdlib: no importa httpx/paho/cv2/onnx/pydantic. Ejecutable con:
#   python -m unittest   ·   pytest -q
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # apps/analytics

from app.frigate import normalize as norm  # noqa: E402

# Enum `type` del eventSchema (apps/api/src/routes/analytics.ts:75)
VALID_TYPES = {
    "person", "vehicle", "zone_intrusion", "line_crossing",
    "loitering", "occupancy_limit", "zone_exit", "zone_reminder",
}
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$")


def assert_event_schema(tc: unittest.TestCase, p: dict) -> None:
    """Verifica que un payload cumple el eventSchema al pie de la letra."""
    tc.assertIsInstance(p["cameraId"], str)
    tc.assertTrue(len(p["cameraId"]) >= 1)
    tc.assertIn(p["type"], VALID_TYPES)
    tc.assertIsInstance(p["className"], str)
    tc.assertTrue(1 <= len(p["className"]) <= 40)
    tc.assertIsInstance(p["confidence"], float)
    tc.assertTrue(0.0 <= p["confidence"] <= 1.0)
    tc.assertRegex(p["occurredAt"], ISO_RE)
    if "trackId" in p:
        tc.assertIsInstance(p["trackId"], int)
        tc.assertTrue(p["trackId"] >= 0)
    if "zoneName" in p:
        tc.assertIsInstance(p["zoneName"], str)
        tc.assertTrue(len(p["zoneName"]) <= 60)
    if "direction" in p:
        tc.assertIn(p["direction"], ("in", "out"))
    if "incidentId" in p:
        tc.assertIsInstance(p["incidentId"], str)
        tc.assertTrue(len(p["incidentId"]) <= 120)
    if "bboxes" in p:
        tc.assertIsInstance(p["bboxes"], list)
        tc.assertTrue(len(p["bboxes"]) <= 64)
        for row in p["bboxes"]:
            tc.assertEqual(len(row), 6)
            for n in row[:5]:
                tc.assertIsInstance(n, (int, float))
            tc.assertIsInstance(row[5], str)
    if "snapshotJpegBase64" in p:
        tc.assertIsInstance(p["snapshotJpegBase64"], str)
        tc.assertFalse(p["snapshotJpegBase64"].startswith("data:"))


def wrap(after: dict, ev_type: str = "update") -> dict:
    return {"type": ev_type, "before": {}, "after": after}


class TestStableTrackId(unittest.TestCase):
    def test_estable_y_positivo(self):
        a = norm.stable_track_id("1699999999.1-abc")
        b = norm.stable_track_id("1699999999.1-abc")
        self.assertEqual(a, b)  # estable entre llamadas
        self.assertGreaterEqual(a, 0)
        self.assertLess(a, 2 ** 31)

    def test_distintos_ids_distinto_hash(self):
        self.assertNotEqual(norm.stable_track_id("a"), norm.stable_track_id("b"))

    def test_none_no_crashea(self):
        self.assertIsInstance(norm.stable_track_id(None), int)


class TestTimestamp(unittest.TestCase):
    def test_epoch_a_iso_000z(self):
        # 2023-11-14T22:13:20 UTC
        self.assertEqual(norm.epoch_to_iso(1700000000), "2023-11-14T22:13:20.000Z")

    def test_none_usa_ahora_con_formato(self):
        self.assertRegex(norm.epoch_to_iso(None), ISO_RE)


class TestBbox(unittest.TestCase):
    def test_box_valido(self):
        row = norm.frigate_box_to_bbox([10, 20, 110, 220], 0.912345, "person")
        self.assertEqual(row, [10.0, 20.0, 110.0, 220.0, 0.912, "person"])

    def test_box_invalido_devuelve_none(self):
        self.assertIsNone(norm.frigate_box_to_bbox(None, 0.5, "car"))
        self.assertIsNone(norm.frigate_box_to_bbox([1, 2], 0.5, "car"))


class TestNormalizePerson(unittest.TestCase):
    def test_person_basico(self):
        ev = wrap({
            "id": "1700000000.1-xyz", "camera": "cam_front", "label": "person",
            "score": 0.87, "start_time": 1700000000,
            "current_zones": [], "entered_zones": [], "box": [1, 2, 3, 4],
        })
        p = norm.normalize_event(ev, "cam-uuid-1", min_confidence=0.6)
        self.assertIsNotNone(p)
        self.assertEqual(p["type"], "person")
        self.assertEqual(p["className"], "person")
        self.assertEqual(p["cameraId"], "cam-uuid-1")
        self.assertEqual(p["confidence"], 0.87)
        self.assertNotIn("zoneName", p)  # person sin zona no lleva zoneName
        assert_event_schema(self, p)


class TestNormalizeVehicle(unittest.TestCase):
    def test_vehicle_desde_car(self):
        ev = wrap({"id": "e1", "camera": "c", "label": "car", "top_score": 0.71,
                   "start_time": 1700000000})
        p = norm.normalize_event(ev, "cam2", min_confidence=0.6)
        self.assertEqual(p["type"], "vehicle")
        self.assertEqual(p["className"], "car")
        self.assertEqual(p["confidence"], 0.71)
        assert_event_schema(self, p)


class TestNormalizeZoneIntrusion(unittest.TestCase):
    def test_entered_zones_da_zone_intrusion(self):
        ev = wrap({"id": "e2", "camera": "c", "label": "person", "score": 0.9,
                   "start_time": 1700000000, "entered_zones": ["Entrada"],
                   "current_zones": ["Entrada"]})
        p = norm.normalize_event(ev, "cam3", min_confidence=0.6)
        self.assertEqual(p["type"], "zone_intrusion")
        self.assertEqual(p["zoneName"], "Entrada")
        self.assertIn("incidentId", p)
        self.assertTrue(p["incidentId"].startswith("cam3:Entrada:"))
        assert_event_schema(self, p)


class TestNormalizeLoitering(unittest.TestCase):
    def test_stationary_da_loitering(self):
        ev = wrap({"id": "e3", "camera": "c", "label": "person", "score": 0.8,
                   "start_time": 1700000000, "stationary": True,
                   "current_zones": ["Pasillo"], "entered_zones": []})
        p = norm.normalize_event(ev, "cam4", min_confidence=0.6)
        self.assertEqual(p["type"], "loitering")
        self.assertEqual(p["zoneName"], "Pasillo")
        assert_event_schema(self, p)


class TestNormalizeDescartes(unittest.TestCase):
    def test_clase_no_soportada(self):
        ev = wrap({"id": "e", "camera": "c", "label": "dog", "score": 0.99,
                   "start_time": 1700000000})
        self.assertIsNone(norm.normalize_event(ev, "cam", min_confidence=0.6))

    def test_confianza_baja(self):
        ev = wrap({"id": "e", "camera": "c", "label": "person", "score": 0.4,
                   "start_time": 1700000000})
        self.assertIsNone(norm.normalize_event(ev, "cam", min_confidence=0.6))

    def test_sin_camera_id_resuelto(self):
        ev = wrap({"id": "e", "camera": "c", "label": "person", "score": 0.9})
        self.assertIsNone(norm.normalize_event(ev, "", min_confidence=0.6))

    def test_clase_soportada_configurable(self):
        ev = wrap({"id": "e", "camera": "c", "label": "car", "score": 0.9,
                   "start_time": 1700000000})
        # si solo se soporta person, un car se descarta
        self.assertIsNone(norm.normalize_event(
            ev, "cam", min_confidence=0.6, supported_classes={"person"}))


class TestSelectObject(unittest.TestCase):
    def test_prefiere_after(self):
        obj = norm.select_object({"type": "update", "after": {"label": "person"}, "before": {"label": "car"}})
        self.assertEqual(obj["label"], "person")

    def test_objeto_plano_api(self):
        obj = norm.select_object({"id": "x", "label": "car", "camera": "c"})
        self.assertEqual(obj["label"], "car")

    def test_no_dict(self):
        self.assertIsNone(norm.select_object("nope"))


if __name__ == "__main__":
    unittest.main()
