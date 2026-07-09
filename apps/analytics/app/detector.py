# apps/analytics/app/detector.py
# Detector YOLOX sobre ONNX Runtime (todo Apache-2.0/MIT — sin AGPL).
# Implementa el pre/post-proceso estándar de YOLOX: letterbox 114, sin
# normalización, decode por grillas (strides 8/16/32) + NMS de supervision.
import logging
import os
import urllib.request

import cv2
import numpy as np
import onnxruntime as ort
import supervision as sv

from .config import settings

log = logging.getLogger("analytics.detector")


def _download_model(url: str, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    log.info("descargando modelo %s → %s", url, dest)
    urllib.request.urlretrieve(url, tmp)  # noqa: S310 — URL controlada por env
    os.replace(tmp, dest)
    log.info("modelo descargado (%.1f MB)", os.path.getsize(dest) / 1e6)


class YoloxDetector:
    def __init__(self) -> None:
        if not os.path.exists(settings.model_path):
            _download_model(settings.model_url, settings.model_path)

        providers = ort.get_available_providers()
        # CUDAExecutionProvider queda primero automáticamente si está instalado
        self.session = ort.InferenceSession(settings.model_path, providers=providers)
        self.input_name = self.session.get_inputs()[0].name
        self.size = settings.input_size
        log.info("modelo cargado: %s providers=%s input=%d",
                 settings.model_path, providers, self.size)

    def _preprocess(self, frame: np.ndarray) -> tuple[np.ndarray, float]:
        img = np.ones((self.size, self.size, 3), dtype=np.uint8) * 114
        ratio = min(self.size / frame.shape[0], self.size / frame.shape[1])
        rw, rh = int(frame.shape[1] * ratio), int(frame.shape[0] * ratio)
        resized = cv2.resize(frame, (rw, rh), interpolation=cv2.INTER_LINEAR)
        img[:rh, :rw] = resized
        blob = img.transpose(2, 0, 1)[None].astype(np.float32)
        return blob, ratio

    def _decode(self, output: np.ndarray) -> np.ndarray:
        # output: (1, N, 85) sin decode — aplicar grillas y strides
        grids, strides = [], []
        for stride in (8, 16, 32):
            gs = self.size // stride
            xv, yv = np.meshgrid(np.arange(gs), np.arange(gs))
            grid = np.stack((xv, yv), 2).reshape(1, -1, 2)
            grids.append(grid)
            strides.append(np.full((1, grid.shape[1], 1), stride))
        grids = np.concatenate(grids, axis=1)
        strides = np.concatenate(strides, axis=1)
        out = output.copy()
        out[..., :2] = (out[..., :2] + grids) * strides
        out[..., 2:4] = np.exp(out[..., 2:4]) * strides
        return out[0]  # (N, 85)

    def infer(self, frame: np.ndarray, min_confidence: float) -> sv.Detections:
        blob, ratio = self._preprocess(frame)
        output = self.session.run(None, {self.input_name: blob})[0]
        preds = self._decode(output)

        scores = preds[:, 4:5] * preds[:, 5:]          # obj * cls
        class_ids = scores.argmax(1)
        confidences = scores[np.arange(len(scores)), class_ids]
        keep = confidences >= min_confidence
        if not keep.any():
            return sv.Detections.empty()

        boxes_cxcywh = preds[keep, :4] / ratio
        xyxy = np.empty_like(boxes_cxcywh)
        xyxy[:, 0] = boxes_cxcywh[:, 0] - boxes_cxcywh[:, 2] / 2
        xyxy[:, 1] = boxes_cxcywh[:, 1] - boxes_cxcywh[:, 3] / 2
        xyxy[:, 2] = boxes_cxcywh[:, 0] + boxes_cxcywh[:, 2] / 2
        xyxy[:, 3] = boxes_cxcywh[:, 1] + boxes_cxcywh[:, 3] / 2

        h, w = frame.shape[:2]
        xyxy[:, [0, 2]] = xyxy[:, [0, 2]].clip(0, w - 1)
        xyxy[:, [1, 3]] = xyxy[:, [1, 3]].clip(0, h - 1)

        det = sv.Detections(
            xyxy=xyxy.astype(np.float32),
            confidence=confidences[keep].astype(np.float32),
            class_id=class_ids[keep].astype(int),
        )
        return det.with_nms(threshold=settings.nms_threshold)
