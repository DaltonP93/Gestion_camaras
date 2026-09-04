# Tests de derive: line_crossing (in/out) y occupancy_limit desde zonas/tracks.
# SOLO stdlib.
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.frigate.derive import FrigateDeriver  # noqa: E402


class TestLineCrossing(unittest.TestCase):
    def test_entrar_a_zona_da_in(self):
        d = FrigateDeriver()
        trs = d.update("cam", "t1", ["Zona1"])
        self.assertEqual(trs, [{"zone": "Zona1", "direction": "in"}])

    def test_permanecer_no_repite(self):
        d = FrigateDeriver()
        d.update("cam", "t1", ["Zona1"])
        # mismas zonas en el siguiente poll → sin transición (idempotente)
        self.assertEqual(d.update("cam", "t1", ["Zona1"]), [])

    def test_salir_da_out(self):
        d = FrigateDeriver()
        d.update("cam", "t1", ["Zona1"])
        self.assertEqual(d.update("cam", "t1", []), [{"zone": "Zona1", "direction": "out"}])

    def test_end_flushea_out(self):
        d = FrigateDeriver()
        d.update("cam", "t1", ["Zona1"])
        trs = d.update("cam", "t1", ["Zona1"], ended=True)
        self.assertEqual(trs, [{"zone": "Zona1", "direction": "out"}])
        self.assertEqual(d.active_tracks(), 0)

    def test_cambio_de_zona_in_y_out(self):
        d = FrigateDeriver()
        d.update("cam", "t1", ["A"])
        trs = d.update("cam", "t1", ["B"])
        self.assertIn({"zone": "B", "direction": "in"}, trs)
        self.assertIn({"zone": "A", "direction": "out"}, trs)


class TestOccupancy(unittest.TestCase):
    def test_conteo_tracks_por_zona(self):
        d = FrigateDeriver()
        d.update("cam", "t1", ["Sala"])
        d.update("cam", "t2", ["Sala"])
        d.update("cam", "t3", ["Otra"])
        self.assertEqual(d.occupancy("cam", "Sala"), 2)
        self.assertEqual(d.occupancy("cam", "Otra"), 1)

    def test_occupancy_exceeded(self):
        d = FrigateDeriver()
        d.update("cam", "t1", ["Sala"])
        d.update("cam", "t2", ["Sala"])
        self.assertFalse(d.occupancy_exceeded("cam", "Sala", 2))  # 2 no supera 2
        d.update("cam", "t3", ["Sala"])
        self.assertTrue(d.occupancy_exceeded("cam", "Sala", 2))   # 3 > 2

    def test_limite_cero_nunca(self):
        d = FrigateDeriver()
        d.update("cam", "t1", ["Sala"])
        self.assertFalse(d.occupancy_exceeded("cam", "Sala", 0))

    def test_aislamiento_por_camara(self):
        d = FrigateDeriver()
        d.update("cam1", "t1", ["Sala"])
        d.update("cam2", "t1", ["Sala"])
        self.assertEqual(d.occupancy("cam1", "Sala"), 1)
        d.forget_camera("cam1")
        self.assertEqual(d.occupancy("cam1", "Sala"), 0)
        self.assertEqual(d.occupancy("cam2", "Sala"), 1)


if __name__ == "__main__":
    unittest.main()
