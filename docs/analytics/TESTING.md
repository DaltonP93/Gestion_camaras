# Analítica — Pruebas

## Python (`apps/analytics`)

Los módulos puros (`rules.py`, `providers/base.py`, `providers/mock.py`,
scaffolds) no dependen de cv2/onnx/supervision → se testean con stdlib.

```bash
cd apps/analytics
python -m unittest discover -s tests        # sin dependencias extra
# o, con dev deps:
pip install -r requirements-dev.txt
pytest -q                                    # pytest descubre los TestCase
```

Cobertura actual (`tests/`):
- `test_rules.py`: cooldown, dedup (+ tope de memoria), horarios (incl. cruce de
  medianoche), backoff, circuit breaker.
- `test_providers.py`: `MockDetectionProvider` (lifecycle/infer/metadata),
  factory (mock/desconocido/yolox lazy), scaffolds de caídas y ALPR,
  `normalize_plate`.

`YoloxOnnxProvider` y `pipeline.py` importan cv2/onnx/supervision: se validan en
CI con `requirements.txt` instalado; en entornos sin esas libs quedan fuera del
discover (import perezoso en el factory).

## API (`apps/api`)

```bash
cd apps/api && npm test        # vitest
```
Relevante a analítica:
- `stream-consumers.test.ts`: StreamConsumerRegistry (memoria + Redis simulado):
  acquire/renew/release/count/list/cleanupExpired, expiración por TTL, múltiples
  tipos por path, concurrencia.
- `metrics.test.ts`: formato Prometheus (counter/gauge/escape/collectors).

## Web (`apps/web`)

```bash
cd apps/web && npm test
```

## Qué NO está cubierto por tests automatizados

- Inferencia real del modelo (requiere pesos + cv2/onnx).
- E2E de UI de Analítica (config/vivo/dashboard/forense) — validación manual.
- Estos puntos se marcan explícitamente como "validado con mocks" o "pendiente
  de prueba funcional" en el PR.
