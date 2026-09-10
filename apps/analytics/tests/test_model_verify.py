# Tests del verificador de integridad del modelo (app/model_verify.py).
# Puros (sólo stdlib): no requieren cv2/onnx/supervision.
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.model_verify import sha256_file, verify_sha256, ModelChecksumError  # noqa: E402


class TestModelVerify(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "modelito.bin")
        self.data = b"visioncore-fake-model-bytes-1234567890"
        with open(self.path, "wb") as f:
            f.write(self.data)
        self.digest = hashlib.sha256(self.data).hexdigest()

    def tearDown(self):
        for f in os.listdir(self.tmp):
            os.remove(os.path.join(self.tmp, f))
        os.rmdir(self.tmp)

    def test_sha256_file(self):
        self.assertEqual(sha256_file(self.path), self.digest)

    def test_match_returns_digest_and_keeps_file(self):
        # coincide (case-insensitive) → retorna digest, no borra el archivo
        got = verify_sha256(self.path, self.digest.upper())
        self.assertEqual(got, self.digest)
        self.assertTrue(os.path.exists(self.path))

    def test_mismatch_raises_and_removes(self):
        bad = "0" * 64
        with self.assertRaises(ModelChecksumError):
            verify_sha256(self.path, bad)
        # por defecto borra el artefacto no confiable
        self.assertFalse(os.path.exists(self.path))

    def test_mismatch_keep_file_when_flag_off(self):
        bad = "0" * 64
        with self.assertRaises(ModelChecksumError):
            verify_sha256(self.path, bad, remove_on_mismatch=False)
        self.assertTrue(os.path.exists(self.path))

    def test_empty_expected_skips(self):
        # expected vacío → omite verificación (retorna None), no toca el archivo
        self.assertIsNone(verify_sha256(self.path, ""))
        self.assertTrue(os.path.exists(self.path))


if __name__ == "__main__":
    unittest.main()
