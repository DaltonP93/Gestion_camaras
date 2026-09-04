# Tests de la cota de tamaño del snapshot en FrigateHttpClient.get_snapshot_b64.
# SOLO stdlib: se inyecta un transport fake con .status_code/.content/.headers.
import base64
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.frigate.client import FrigateHttpClient, DEFAULT_MAX_SNAPSHOT_BYTES  # noqa: E402


class FakeResp:
    def __init__(self, *, status_code=200, content=b"", headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}


class FakeTransport:
    def __init__(self, resp):
        self._resp = resp
        self.calls = []

    def get(self, url, params=None):
        self.calls.append((url, params))
        return self._resp


class TestSnapshotCap(unittest.TestCase):
    def _client(self, resp, **kw):
        return FrigateHttpClient("http://frigate:5000", transport=FakeTransport(resp), **kw)

    def test_snapshot_normal_ok(self):
        content = b"\xff\xd8jpegbytes"
        c = self._client(FakeResp(content=content))
        out = c.get_snapshot_b64("e1")
        self.assertEqual(out, base64.b64encode(content).decode("ascii"))

    def test_snapshot_excede_por_body_se_descarta(self):
        c = self._client(FakeResp(content=b"x" * 100), max_snapshot_bytes=50)
        self.assertIsNone(c.get_snapshot_b64("e1"))

    def test_snapshot_excede_por_content_length_se_descarta(self):
        # Content-Length declarado supera el límite → rechazo temprano (aunque el
        # body fake sea pequeño, no debe llegar a codificarse).
        c = self._client(
            FakeResp(content=b"small", headers={"content-length": "999999"}),
            max_snapshot_bytes=1000,
        )
        self.assertIsNone(c.get_snapshot_b64("e1"))

    def test_snapshot_en_el_limite_ok(self):
        content = b"y" * 50
        c = self._client(FakeResp(content=content), max_snapshot_bytes=50)
        self.assertEqual(c.get_snapshot_b64("e1"), base64.b64encode(content).decode("ascii"))

    def test_limite_cero_desactiva_la_cota(self):
        content = b"z" * 10_000
        c = self._client(FakeResp(content=content), max_snapshot_bytes=0)
        self.assertEqual(c.get_snapshot_b64("e1"), base64.b64encode(content).decode("ascii"))

    def test_default_es_5_mib(self):
        c = FrigateHttpClient("http://frigate:5000")
        self.assertEqual(c._max_snapshot_bytes, DEFAULT_MAX_SNAPSHOT_BYTES)
        self.assertEqual(DEFAULT_MAX_SNAPSHOT_BYTES, 5 * 1024 * 1024)

    def test_content_length_ilegible_no_rompe(self):
        content = b"ok"
        c = self._client(
            FakeResp(content=content, headers={"content-length": "no-numero"}),
            max_snapshot_bytes=1000,
        )
        self.assertEqual(c.get_snapshot_b64("e1"), base64.b64encode(content).decode("ascii"))

    def test_status_no_200_devuelve_none(self):
        c = self._client(FakeResp(status_code=404, content=b"nope"))
        self.assertIsNone(c.get_snapshot_b64("e1"))

    def test_event_id_vacio_devuelve_none(self):
        c = self._client(FakeResp(content=b"x"))
        self.assertIsNone(c.get_snapshot_b64(""))


if __name__ == "__main__":
    unittest.main()
