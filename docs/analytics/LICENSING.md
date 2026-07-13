# Analítica — Licencias

Regla del proyecto: **sin dependencias GPL/AGPL** en producción (CI lo verifica).
El uso comercial cerrado exige modelos y librerías con licencia permisiva.

## Dependencias del servicio (permisivas)

| Componente | Licencia |
|---|---|
| Roboflow Supervision | MIT |
| ONNX Runtime | MIT |
| OpenCV (headless) | Apache-2.0 |
| FastAPI / Uvicorn / httpx / pydantic-settings | MIT / BSD |
| numpy | BSD-3 |
| YOLOX (código + pesos ONNX de Megvii) | Apache-2.0 |

**Prohibido**: `ultralytics` (YOLOv8/YOLOv11) es **AGPL-3.0** → no se usa. Cualquier
alternativa debe ser Apache-2.0/MIT/BSD.

## Detección de caídas (pendiente de modelo)

Requiere estimación de pose. Opciones a evaluar con licencia compatible antes de
activar `ANALYTICS_FALL_DETECTION_ENABLED`:
- Modelos de pose exportados a ONNX bajo Apache-2.0/MIT (p.ej. RTMPose/MMPose —
  **verificar la licencia exacta de los pesos**, no solo del código).
- MoveNet (Apache-2.0) exportado a ONNX.

No incluir modelos AGPL (p.ej. variantes YOLO-pose de ultralytics).

## ALPR / matrículas (pendiente de modelo)

Requiere detector de placa + OCR. Candidatos con licencia permisiva a validar
antes de activar `ANALYTICS_ALPR_ENABLED`:
- Detector de placa: modelos ONNX Apache-2.0/MIT.
- OCR de placa: motores/OCR con licencia permisiva (verificar pesos).

Verificar SIEMPRE: (1) licencia del **código**, (2) licencia de los **pesos**,
(3) restricciones de uso comercial del dataset de entrenamiento cuando se declare.

## Proceso al agregar un modelo

1. Documentar aquí modelo, versión, licencia de código y de pesos, y fuente.
2. Confirmar que no arrastra dependencias AGPL/GPL.
3. Mantener el modelo detrás de su feature flag hasta validarlo funcionalmente.
