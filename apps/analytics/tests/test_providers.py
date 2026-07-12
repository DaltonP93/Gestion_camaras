# Tests de la abstracción de providers (mock + factory + scaffolds).
# No requieren cv2/onnx/supervision (el mock y los scaffolds son puros).
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.providers.base import Detection, DetectionProvider  # noqa: E402
from app.providers.mock import MockDetectionProvider  # noqa: E402
from app.providers.factory import create_detection_provider  # noqa: E402
from app.providers.fall import DisabledFallDetectionProvider  # noqa: E402
from app.providers.plate import (  # noqa: E402
    DisabledPlateDetectorProvider, DisabledPlateOcrProvider, normalize_plate,
)


class TestMockProvider(unittest.TestCase):
    def test_lifecycle_e_infer(self):
        script = [
            [Detection(0, 0, 10, 10, 0.9, 0, "person")],
            [Detection(0, 0, 10, 10, 0.3, 2, "car")],  # baja confianza
        ]
        p = MockDetectionProvider(script=script)
        self.assertFalse(p.health().loaded)
        with self.assertRaises(RuntimeError):
            p.infer(None, 0.5)  # sin load
        p.load()
        self.assertTrue(p.health().loaded)
        f1 = p.infer(None, 0.5)
        self.assertEqual(len(f1), 1)
        self.assertEqual(f1[0].class_name, "person")
        f2 = p.infer(None, 0.5)   # car 0.3 < 0.5 → filtrado
        self.assertEqual(len(f2), 0)
        self.assertIsInstance(p, DetectionProvider)

    def test_metadata(self):
        p = MockDetectionProvider()
        p.load()
        md = p.metadata()
        self.assertEqual(md.name, "mock")
        self.assertIn("person", md.classes)


class TestFactory(unittest.TestCase):
    def test_mock(self):
        self.assertIsInstance(create_detection_provider("mock"), MockDetectionProvider)

    def test_desconocido(self):
        with self.assertRaises(ValueError):
            create_detection_provider("inexistente")

    def test_yolox_lazy_import(self):
        # En el sandbox cv2/onnx no están; create de yolox debe fallar al importar,
        # nunca silenciosamente devolver algo inválido. En CI (con deps) esto
        # construiría el provider real, así que aceptamos ambos caminos.
        try:
            prov = create_detection_provider("yolox_onnx")
            self.assertEqual(prov.metadata().name, "yolox_onnx")
        except (ImportError, ModuleNotFoundError):
            pass  # esperado sin cv2/onnx instalados


class TestScaffolds(unittest.TestCase):
    def test_fall_disabled(self):
        f = DisabledFallDetectionProvider()
        self.assertFalse(f.available())
        self.assertEqual(f.analyze([], 0.0), [])
        with self.assertRaises(RuntimeError):
            f.load()

    def test_alpr_disabled(self):
        d = DisabledPlateDetectorProvider()
        o = DisabledPlateOcrProvider()
        self.assertFalse(d.available())
        self.assertFalse(o.available())
        self.assertEqual(d.detect(None), [])
        self.assertIsNone(o.read(None))

    def test_normalize_plate(self):
        self.assertEqual(normalize_plate("abc-123 x"), "ABC123X")
        self.assertEqual(normalize_plate(""), "")


if __name__ == "__main__":
    unittest.main()
