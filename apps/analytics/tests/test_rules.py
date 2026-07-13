# Tests de la lógica pura de reglas (sin cv2/onnx). Ejecutable con:
#   python -m unittest   (sandbox)  ·  pytest -q   (CI, descubre TestCase)
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # apps/analytics

from app.rules import (  # noqa: E402
    CooldownTracker, TrackDedup, CircuitBreaker, within_schedule, backoff_delay,
)


class TestCooldown(unittest.TestCase):
    def test_respeta_cooldown(self):
        c = CooldownTracker()
        self.assertTrue(c.should_emit("k", 10, now=100))
        self.assertFalse(c.should_emit("k", 10, now=105))   # dentro del cooldown
        self.assertTrue(c.should_emit("k", 10, now=111))    # ya pasó
        self.assertTrue(c.should_emit("otra", 10, now=105)) # clave distinta


class TestDedup(unittest.TestCase):
    def test_reporta_una_vez(self):
        d = TrackDedup()
        self.assertTrue(d.is_new(1))
        self.assertFalse(d.is_new(1))
        self.assertTrue(d.is_new(2))

    def test_tope_de_memoria(self):
        d = TrackDedup(cap=3)
        for i in range(3):
            d.is_new(i)
        d.is_new(99)          # supera el tope → limpia
        self.assertTrue(d.is_new(0))  # 0 fue olvidado


class TestSchedule(unittest.TestCase):
    def _t(self, wday, hh, mm):
        # struct_time con wday y hora controlados
        return time.struct_time((2026, 1, 1, hh, mm, 0, wday, 1, 0))

    def test_sin_horario_siempre_activo(self):
        self.assertTrue(within_schedule(None, self._t(0, 3, 0)))
        self.assertTrue(within_schedule([], self._t(0, 3, 0)))

    def test_ventana_diurna(self):
        sched = [{"days": [0, 1, 2, 3, 4], "start": "08:00", "end": "18:00"}]
        self.assertTrue(within_schedule(sched, self._t(0, 9, 0)))   # lun 09:00
        self.assertFalse(within_schedule(sched, self._t(0, 19, 0))) # lun 19:00
        self.assertFalse(within_schedule(sched, self._t(5, 9, 0)))  # sáb fuera de días

    def test_ventana_cruza_medianoche(self):
        sched = [{"start": "22:00", "end": "06:00"}]
        self.assertTrue(within_schedule(sched, self._t(0, 23, 30)))
        self.assertTrue(within_schedule(sched, self._t(0, 2, 0)))
        self.assertFalse(within_schedule(sched, self._t(0, 12, 0)))


class TestBackoff(unittest.TestCase):
    def test_escala(self):
        sched = (10, 30, 60, 300)
        self.assertEqual(backoff_delay(1, sched), 10)
        self.assertEqual(backoff_delay(2, sched), 30)
        self.assertEqual(backoff_delay(4, sched), 300)
        self.assertEqual(backoff_delay(9, sched), 300)  # clamp al último
        self.assertEqual(backoff_delay(0, sched), 0)


class TestCircuitBreaker(unittest.TestCase):
    def test_abre_tras_max_fallos_y_resetea(self):
        cb = CircuitBreaker(max_failures=3)
        self.assertFalse(cb.record_failure())
        self.assertFalse(cb.record_failure())
        self.assertTrue(cb.record_failure())   # 3º → abre
        self.assertTrue(cb.is_open())
        cb.record_success()
        self.assertFalse(cb.is_open())
        self.assertEqual(cb.failures, 0)


if __name__ == "__main__":
    unittest.main()
