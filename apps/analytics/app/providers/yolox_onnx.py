# apps/analytics/app/providers/yolox_onnx.py
# Provider YOLOX sobre ONNX Runtime (Apache-2.0 / MIT — sin AGPL).
# Implementa el pre/post-proceso estándar de YOLOX (letterbox 114, decode por
# grillas strides 8/16/32) y NMS propio en numpy, devolviendo Detection neutrales.
from __future__ import annotations

import logging
import os
import socket
import urllib.request
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort

from ..config import settings, CLASS_NAME_BY_ID
from .base import Detection, DetectionProvider, ProviderHealth, ProviderMetadata

log = logging.getLogger("analytics.provider.yolox")


def _download_model(url: str, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    log.info("descargando modelo %s → %s", url, dest)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "visioncore-analytics"})
        with urllib.request.urlopen(req, timeout=30) as resp, open(tmp, "wb") as f:  # noqa: S310
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
        size = os.path.getsize(tmp)
        if size < 1_000_000:
            raise RuntimeError(f"descarga incompleta ({size} bytes)")
        os.replace(tmp, dest)
        log.info("modelo descargado (%.1f MB)", size / 1e6)
    except (OSError, socket.timeout, RuntimeError):
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    """NMS clásico en numpy. boxes: (N,4) xyxy. Devuelve índices a conservar."""
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1).clip(0) * (y2 - y1).clip(0)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = (xx2 - xx1).clip(0)
        h = (yy2 - yy1).clip(0)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_thr]
    return keep


class YoloxOnnxProvider(DetectionProvider):
    def __init__(self) -> None:
        self.session: ort.InferenceSession | None = None
        self._providers: list[str] = []
        self._error: str | None = None
        self.size = settings.input_size
        self.input_name = ""

    def load(self) -> None:
        try:
            if not os.path.exists(settings.model_path):
                _download_model(settings.model_url, settings.model_path)
            self._providers = ort.get_available_providers()
            self.session = ort.InferenceSession(settings.model_path, providers=self._providers)
            self.input_name = self.session.get_inputs()[0].name
            self._error = None
            log.info("modelo cargado: %s providers=%s input=%d",
                     settings.model_path, self._providers, self.size)
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc)
            self.session = None
            raise

    def unload(self) -> None:
        self.session = None

    def _preprocess(self, frame: np.ndarray) -> tuple[np.ndarray, float]:
        img = np.ones((self.size, self.size, 3), dtype=np.uint8) * 114
        ratio = min(self.size / frame.shape[0], self.size / frame.shape[1])
        rw, rh = int(frame.shape[1] * ratio), int(frame.shape[0] * ratio)
        resized = cv2.resize(frame, (rw, rh), interpolation=cv2.INTER_LINEAR)
        img[:rh, :rw] = resized
        blob = img.transpose(2, 0, 1)[None].astype(np.float32)
        return blob, ratio

    def _decode(self, output: np.ndarray) -> np.ndarray:
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
        return out[0]

    def infer(self, frame: Any, min_confidence: float) -> list[Detection]:
        if self.session is None:
            raise RuntimeError("yolox provider no cargado")
        blob, ratio = self._preprocess(frame)
        output = self.session.run(None, {self.input_name: blob})[0]
        preds = self._decode(output)

        scores_all = preds[:, 4:5] * preds[:, 5:]
        class_ids = scores_all.argmax(1)
        confidences = scores_all[np.arange(len(scores_all)), class_ids]
        keep = confidences >= min_confidence
        if not keep.any():
            return []

        boxes_cxcywh = preds[keep, :4] / ratio
        xyxy = np.empty_like(boxes_cxcywh)
        xyxy[:, 0] = boxes_cxcywh[:, 0] - boxes_cxcywh[:, 2] / 2
        xyxy[:, 1] = boxes_cxcywh[:, 1] - boxes_cxcywh[:, 3] / 2
        xyxy[:, 2] = boxes_cxcywh[:, 0] + boxes_cxcywh[:, 2] / 2
        xyxy[:, 3] = boxes_cxcywh[:, 1] + boxes_cxcywh[:, 3] / 2
        h, w = frame.shape[:2]
        xyxy[:, [0, 2]] = xyxy[:, [0, 2]].clip(0, w - 1)
        xyxy[:, [1, 3]] = xyxy[:, [1, 3]].clip(0, h - 1)

        conf = confidences[keep]
        cls = class_ids[keep]
        idxs = _nms(xyxy, conf, settings.nms_threshold)
        out: list[Detection] = []
        for i in idxs:
            cid = int(cls[i])
            out.append(Detection(
                x1=float(xyxy[i, 0]), y1=float(xyxy[i, 1]),
                x2=float(xyxy[i, 2]), y2=float(xyxy[i, 3]),
                confidence=float(conf[i]), class_id=cid,
                class_name=CLASS_NAME_BY_ID.get(cid, str(cid)),
            ))
        return out

    def health(self) -> ProviderHealth:
        return ProviderHealth(loaded=self.session is not None, error=self._error)

    def metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            name="yolox_onnx", model=os.path.basename(settings.model_path),
            input_size=self.size, classes=list(CLASS_NAME_BY_ID.values()),
            providers=self._providers,
        )
