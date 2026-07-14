# Tests de la lógica pura de reglas (sin cv2/onnx). Ejecutable con:
#   python -m unittest   (sandbox)  ·  pytest -q   (CI, descubre TestCase)
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # apps/analytics

from app.rules import (  # noqa: E402
    CooldownTracker, TrackDedup, CircuitBreaker, ZoneIntrusionTracker,
    within_schedule, backoff_delay,
)


class TestZoneIntrusionTracker(unittest.TestCase):
    def _types(self, events):
        return [e["type"] for e in events]

    def test_una_sola_intrusion_mientras_permanece_dentro(self):
        # Un auto entra y permanece 5 minutos → UNA intrusión, no una por frame.
        z = ZoneIntrusionTracker(lost_grace_sec=5)
        first = z.mark_inside("cam1", "Zona1", 7, now=0.0)
        self.assertEqual(self._types(first), ["zone_intrusion"])
        incident = first[0]["incident_id"]
        # 300 s adentro, un frame por segundo → sin nuevas intrusiones
        for t in range(1, 301):
            evs = z.mark_inside("cam1", "Zona1", 7, now=float(t))
            self.assertEqual(evs, [])
        self.assertEqual(z.active_incidents(), 1)
        # mismo incidente durante toda la permanencia
        self.assertEqual(incident, "cam1:Zona1:7:0")

    def test_salida_y_reentrada_generan_incidentes_distintos(self):
        z = ZoneIntrusionTracker(lost_grace_sec=5)
        e1 = z.mark_inside("cam1", "Zona1", 7, now=0.0)
        inc1 = e1[0]["incident_id"]
        # deja de verse → tras lost_grace se emite zone_exit
        exits = z.sweep_exits(now=6.0)
        self.assertEqual(self._types(exits), ["zone_exit"])
        self.assertEqual(exits[0]["incident_id"], inc1)
        self.assertEqual(z.active_incidents(), 0)
        # vuelve a entrar → NUEVA intrusión con incidente distinto
        e2 = z.mark_inside("cam1", "Zona1", 7, now=100.0)
        self.assertEqual(self._types(e2), ["zone_intrusion"])
        self.assertNotEqual(e2[0]["incident_id"], inc1)

    def test_no_sale_por_perdida_breve_del_track(self):
        # El track desaparece 3 s (< lost_grace=5) y vuelve → NO se re-arma:
        # sigue siendo el mismo incidente, sin nueva intrusión.
        z = ZoneIntrusionTracker(lost_grace_sec=5)
        e1 = z.mark_inside("cam1", "Zona1", 7, now=0.0)
        inc1 = e1[0]["incident_id"]
        self.assertEqual(z.sweep_exits(now=3.0), [])   # aún dentro de la tolerancia
        again = z.mark_inside("cam1", "Zona1", 7, now=3.5)
        self.assertEqual(again, [])                     # sin nueva intrusión
        self.assertEqual(z.active_incidents(), 1)
        # y el incidente sigue siendo el mismo
        self.assertEqual(inc1, "cam1:Zona1:7:0")

    def test_loitering_una_vez_tras_dwell(self):
        z = ZoneIntrusionTracker(lost_grace_sec=5)
        z.mark_inside("cam1", "Zona1", 7, now=0.0, loitering_sec=60)
        # antes de 60 s: nada
        self.assertEqual(z.mark_inside("cam1", "Zona1", 7, now=30.0, loitering_sec=60), [])
        # a los 60 s: loitering una sola vez
        evs = z.mark_inside("cam1", "Zona1", 7, now=60.0, loitering_sec=60)
        self.assertEqual(self._types(evs), ["loitering"])
        self.assertEqual(z.mark_inside("cam1", "Zona1", 7, now=90.0, loitering_sec=60), [])

    def test_recordatorio_periodico_marcado_como_reminder(self):
        z = ZoneIntrusionTracker(lost_grace_sec=5)
        z.mark_inside("cam1", "Zona1", 7, now=0.0, reminder_sec=120)
        self.assertEqual(z.mark_inside("cam1", "Zona1", 7, now=60.0, reminder_sec=120), [])
        evs = z.mark_inside("cam1", "Zona1", 7, now=120.0, reminder_sec=120)
        self.assertEqual(self._types(evs), ["zone_reminder"])
        self.assertTrue(evs[0]["reminder"])

    def test_tracks_distintos_son_incidentes_independientes(self):
        z = ZoneIntrusionTracker(lost_grace_sec=5)
        a = z.mark_inside("cam1", "Zona1", 1, now=0.0)
        b = z.mark_inside("cam1", "Zona1", 2, now=0.0)
        self.assertEqual(self._types(a), ["zone_intrusion"])
        self.assertEqual(self._types(b), ["zone_intrusion"])
        self.assertNotEqual(a[0]["incident_id"], b[0]["incident_id"])
        self.assertEqual(z.active_incidents(), 2)


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
