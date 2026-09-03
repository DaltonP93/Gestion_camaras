# Tests de camera_map: resolución nombre-Frigate → cameraId VisionCore.
# SOLO stdlib.
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.frigate import camera_map as cm  # noqa: E402


class TestLoadCameraMap(unittest.TestCase):
    def test_vacio(self):
        self.assertEqual(cm.load_camera_map(""), {})
        self.assertEqual(cm.load_camera_map(None), {})

    def test_json_string(self):
        m = cm.load_camera_map('{"cam_front": "uuid-1", "cam_back": "uuid-2"}')
        self.assertEqual(m, {"cam_front": "uuid-1", "cam_back": "uuid-2"})

    def test_dict_directo(self):
        self.assertEqual(cm.load_camera_map({"a": "b"}), {"a": "b"})

    def test_json_invalido_fail_seguro(self):
        self.assertEqual(cm.load_camera_map("{no json}"), {})

    def test_valores_vacios_se_descartan(self):
        self.assertEqual(cm.load_camera_map('{"a": "", "b": "id"}'), {"b": "id"})


class TestResolveCameraId(unittest.TestCase):
    def test_por_mapa(self):
        m = {"cam_front": "uuid-1"}
        self.assertEqual(cm.resolve_camera_id("cam_front", m), "uuid-1")

    def test_mapa_no_contiene_desconocida_none(self):
        m = {"cam_front": "uuid-1"}
        self.assertIsNone(cm.resolve_camera_id("cam_x", m))

    def test_mapa_no_contiene_pero_es_id_conocido(self):
        m = {"cam_front": "uuid-1"}
        known = {"uuid-9"}
        self.assertEqual(cm.resolve_camera_id("uuid-9", m, known), "uuid-9")

    def test_match_directo_sin_mapa(self):
        self.assertEqual(cm.resolve_camera_id("uuid-7", {}), "uuid-7")

    def test_match_directo_con_known_ids(self):
        self.assertEqual(cm.resolve_camera_id("uuid-7", {}, {"uuid-7"}), "uuid-7")
        self.assertIsNone(cm.resolve_camera_id("uuid-x", {}, {"uuid-7"}))

    def test_camera_vacia_none(self):
        self.assertIsNone(cm.resolve_camera_id("", {"a": "b"}))
        self.assertIsNone(cm.resolve_camera_id(None, {}))


if __name__ == "__main__":
    unittest.main()
