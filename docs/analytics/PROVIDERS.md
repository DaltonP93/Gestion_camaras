# Analítica — Providers de modelos

El pipeline no depende de un modelo concreto: usa la interfaz
`DetectionProvider`. Cambiar de modelo = nuevo provider, sin tocar el pipeline.

## DetectionProvider (`app/providers/base.py`)

Contrato **neutral** (sin numpy/cv2/onnx/supervision → testeable):

```python
class DetectionProvider(ABC):
    def load(self) -> None            # carga/descarga el modelo; lanza si falla
    def unload(self) -> None
    def infer(self, frame, min_confidence) -> list[Detection]
    def health(self) -> ProviderHealth        # loaded, error
    def metadata(self) -> ProviderMetadata     # name, model, input_size, classes, providers
```

`Detection = (x1,y1,x2,y2, confidence, class_id, class_name)` en píxeles del
frame. El pipeline convierte a `sv.Detections` para ByteTrack y zonas.

## Selección (`app/providers/factory.py`)

`ANALYTICS_PROVIDER` (o `PROVIDER`): `yolox_onnx` (default) | `mock`.
Import perezoso: usar `mock` no arrastra cv2/onnx.

## Providers incluidos

| Provider | Archivo | Licencia | Notas |
|---|---|---|---|
| `YoloxOnnxProvider` | `providers/yolox_onnx.py` | YOLOX Apache-2.0 · ONNX Runtime MIT | pre/post-proceso YOLOX + NMS numpy propio |
| `MockDetectionProvider` | `providers/mock.py` | — | detecciones scriptadas; tests / correr sin modelo |

## Agregar un provider ONNX nuevo

1. Implementá `DetectionProvider` en `app/providers/<nombre>.py` devolviendo
   `list[Detection]` (aplicá el pre/post-proceso propio del modelo).
2. Registralo en `factory.create_detection_provider` (import perezoso).
3. Verificá la licencia del modelo y los pesos (ver `LICENSING.md`).
4. `ANALYTICS_PROVIDER=<nombre>`.

## Scaffolds (requieren modelo externo)

- **Pose / Caídas** (`providers/pose.py`, `providers/fall.py`): interfaces
  `PoseEstimationProvider` / `FallDetectionProvider` + implementaciones
  deshabilitadas. Flag `ANALYTICS_FALL_DETECTION_ENABLED`.
- **ALPR** (`providers/plate.py`): `PlateDetectorProvider` / `PlateOcrProvider` +
  deshabilitados. Flag `ANALYTICS_ALPR_ENABLED`. `normalize_plate()` disponible.

Sin un modelo con licencia compatible, estos providers reportan `available()
== False` y no se activan. No se incluye ninguna dependencia AGPL.
