# apps/analytics/app/pipeline.py
# Un worker (hilo) por cámara: lee el substream RTSP, muestrea frames,
# detecta con YOLOX, trackea con ByteTrack (supervision), evalúa zonas
# poligonales y publica eventos al API Node con snapshot anotado.
import base64
import logging
import threading
import time
from typing import Any

import cv2
import numpy as np
import httpx
import supervision as sv

from .config import settings, COCO_CLASS_IDS, CLASS_NAME_BY_ID, VEHICLE_CLASSES
from .detector import YoloxDetector

log = logging.getLogger("analytics.pipeline")


class CameraWorker(threading.Thread):
    def __init__(self, cam: dict[str, Any], detector: YoloxDetector):
        super().__init__(daemon=True, name=f"cam-{cam['cameraId'][:8]}")
        self.cam = cam
        self.detector = detector
        self.stop_event = threading.Event()
        self.tracker = sv.ByteTrack()
        self.box_annotator = sv.BoxAnnotator(thickness=2)
        self.label_annotator = sv.LabelAnnotator(text_scale=0.5)
        # cooldowns: clave (tipo, clase|zona) → epoch del último evento enviado
        self.last_event_at: dict[tuple[str, str], float] = {}
        # track_ids ya reportados como "detección nueva" (evita repetir por frame)
        self.reported_tracks: set[int] = set()
        self.zones: list[dict[str, Any]] = []
        self.zone_objects: list[sv.PolygonZone] = []
        self.frame_size: tuple[int, int] | None = None
        self.status = "starting"
        self.frames_processed = 0
        self.events_sent = 0
        self.last_error: str | None = None

    # La config de zonas viene normalizada 0-1 — se materializa al conocer
    # el tamaño real del frame
    def _build_zones(self, w: int, h: int) -> None:
        self.zones = list(self.cam.get("zones") or [])
        self.zone_objects = []
        for z in self.zones:
            pts = np.array([[int(px * w), int(py * h)] for px, py in z["points"]], dtype=np.int32)
            self.zone_objects.append(sv.PolygonZone(polygon=pts))
        if self.zones:
            log.info("[%s] %d zonas materializadas (%dx%d)", self.cam["cameraName"], len(self.zones), w, h)

    def _watched_class_ids(self) -> set[int]:
        return {COCO_CLASS_IDS[c] for c in self.cam["classes"] if c in COCO_CLASS_IDS}

    def _cooldown_ok(self, key: tuple[str, str]) -> bool:
        now = time.time()
        if now - self.last_event_at.get(key, 0) < self.cam.get("cooldownSec", 60):
            return False
        self.last_event_at[key] = now
        return True

    def _post_event(self, ev_type: str, class_name: str, confidence: float,
                    frame: np.ndarray, detections: sv.Detections,
                    track_id: int | None = None, zone_name: str | None = None) -> None:
        annotated = frame.copy()
        labels = [
            f"{CLASS_NAME_BY_ID.get(int(c), str(c))} {conf:.0%}"
            for c, conf in zip(detections.class_id, detections.confidence)
        ]
        annotated = self.box_annotator.annotate(annotated, detections)
        annotated = self.label_annotator.annotate(annotated, detections, labels=labels)
        for z, zobj in zip(self.zones, self.zone_objects):
            cv2.polylines(annotated, [zobj.polygon], True, (0, 0, 255), 2)
            cv2.putText(annotated, z["name"], tuple(zobj.polygon[0]),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

        if annotated.shape[1] > settings.snapshot_max_width:
            scale = settings.snapshot_max_width / annotated.shape[1]
            annotated = cv2.resize(annotated, None, fx=scale, fy=scale)
        ok, jpeg = cv2.imencode(".jpg", annotated,
                                [cv2.IMWRITE_JPEG_QUALITY, settings.snapshot_jpeg_quality])
        snapshot_b64 = base64.b64encode(jpeg.tobytes()).decode() if ok else None

        bboxes = [
            [round(float(x1), 1), round(float(y1), 1), round(float(x2), 1), round(float(y2), 1),
             round(float(conf), 3), CLASS_NAME_BY_ID.get(int(cid), str(cid))]
            for (x1, y1, x2, y2), conf, cid
            in zip(detections.xyxy, detections.confidence, detections.class_id)
        ][:64]

        payload = {
            "cameraId": self.cam["cameraId"],
            "type": ev_type,
            "className": class_name,
            "confidence": round(float(confidence), 3),
            "trackId": int(track_id) if track_id is not None else None,
            "zoneName": zone_name,
            "bboxes": bboxes,
            "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z",
            "snapshotJpegBase64": snapshot_b64,
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        try:
            r = httpx.post(
                f"{settings.api_base_url}/api/analytics/internal/events",
                json=payload,
                headers={"x-analytics-secret": settings.analytics_secret},
                timeout=15,
            )
            r.raise_for_status()
            self.events_sent += 1
            log.info("[%s] evento %s/%s enviado (conf %.2f zona=%s)",
                     self.cam["cameraName"], ev_type, class_name, confidence, zone_name)
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] fallo al enviar evento: %s", self.cam["cameraName"], exc)

    def _process(self, frame: np.ndarray) -> None:
        detections = self.detector.infer(frame, self.cam["minConfidence"])
        watched = self._watched_class_ids()
        if len(detections) > 0:
            mask = np.isin(detections.class_id, list(watched))
            detections = detections[mask]
        if len(detections) == 0:
            return

        detections = self.tracker.update_with_detections(detections)
        self.frames_processed += 1

        # 1) Detección de objeto nuevo (track_id nuevo) → person / vehicle
        if detections.tracker_id is not None:
            for i, tid in enumerate(detections.tracker_id):
                if tid is None or int(tid) in self.reported_tracks:
                    continue
                self.reported_tracks.add(int(tid))
                if len(self.reported_tracks) > 5000:
                    self.reported_tracks.clear()
                cname = CLASS_NAME_BY_ID.get(int(detections.class_id[i]), "")
                ev_type = "person" if cname == "person" else ("vehicle" if cname in VEHICLE_CLASSES else None)
                if ev_type and self._cooldown_ok((ev_type, cname)):
                    self._post_event(ev_type, cname, float(detections.confidence[i]),
                                     frame, detections, track_id=int(tid))

        # 2) Zonas de intrusión
        for z, zobj in zip(self.zones, self.zone_objects):
            zone_classes = set(z.get("classes") or self.cam["classes"])
            inside = zobj.trigger(detections)
            for i, is_in in enumerate(inside):
                if not is_in:
                    continue
                cname = CLASS_NAME_BY_ID.get(int(detections.class_id[i]), "")
                if cname not in zone_classes:
                    continue
                if self._cooldown_ok(("zone", f"{z['name']}|{cname}")):
                    tid = detections.tracker_id[i] if detections.tracker_id is not None else None
                    self._post_event("zone_intrusion", cname, float(detections.confidence[i]),
                                     frame, detections,
                                     track_id=int(tid) if tid is not None else None,
                                     zone_name=z["name"])

    def run(self) -> None:
        interval = 1.0 / max(0.2, float(self.cam.get("sampleFps", 2)))
        rtsp = self.cam["rtspUrl"]
        masked = self.cam.get("rtspMasked", "rtsp://***")
        log.info("[%s] worker iniciado url=%s fps=%.1f clases=%s",
                 self.cam["cameraName"], masked, self.cam.get("sampleFps", 2), self.cam["classes"])

        while not self.stop_event.is_set():
            cap = cv2.VideoCapture(rtsp, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                self.status = "rtsp_down"
                self.last_error = "no se pudo abrir RTSP"
                log.warning("[%s] RTSP inaccesible (%s), reintento en %ds",
                            self.cam["cameraName"], masked, settings.rtsp_reconnect_sec)
                if self.stop_event.wait(settings.rtsp_reconnect_sec):
                    break
                continue

            self.status = "running"
            last_sample = 0.0
            while not self.stop_event.is_set():
                ok = cap.grab()
                if not ok:
                    self.last_error = "stream cortado"
                    break
                now = time.time()
                if now - last_sample < interval:
                    continue
                last_sample = now
                ok, frame = cap.retrieve()
                if not ok or frame is None:
                    continue
                if self.frame_size != (frame.shape[1], frame.shape[0]):
                    self.frame_size = (frame.shape[1], frame.shape[0])
                    self._build_zones(*self.frame_size)
                try:
                    self._process(frame)
                except Exception as exc:  # noqa: BLE001
                    self.last_error = str(exc)
                    log.exception("[%s] error procesando frame", self.cam["cameraName"])

            cap.release()
            if not self.stop_event.is_set():
                self.status = "reconnecting"
                self.stop_event.wait(settings.rtsp_reconnect_sec)

        self.status = "stopped"
        log.info("[%s] worker detenido", self.cam["cameraName"])

    def stop(self) -> None:
        self.stop_event.set()


class PipelineManager:
    """Sincroniza los workers con la configuración del API cada N segundos."""

    def __init__(self) -> None:
        self.detector: YoloxDetector | None = None
        self.workers: dict[str, CameraWorker] = {}
        self.lock = threading.Lock()
        self.last_refresh: float | None = None
        self.last_refresh_error: str | None = None

    def start(self) -> None:
        self.detector = YoloxDetector()
        threading.Thread(target=self._refresh_loop, daemon=True, name="refresh").start()

    def _fetch_cameras(self) -> list[dict[str, Any]]:
        r = httpx.get(
            f"{settings.api_base_url}/api/analytics/internal/cameras",
            headers={"x-analytics-secret": settings.analytics_secret},
            timeout=15,
        )
        r.raise_for_status()
        return r.json().get("cameras", [])

    def _refresh_loop(self) -> None:
        while True:
            try:
                cams = self._fetch_cameras()
                self._reconcile(cams)
                self.last_refresh = time.time()
                self.last_refresh_error = None
            except Exception as exc:  # noqa: BLE001
                self.last_refresh_error = str(exc)
                log.warning("no se pudo refrescar configs: %s", exc)
            time.sleep(settings.refresh_interval_sec)

    def _reconcile(self, cams: list[dict[str, Any]]) -> None:
        assert self.detector is not None
        with self.lock:
            desired = {c["cameraId"]: c for c in cams}
            # Detener workers de cámaras deshabilitadas o con config cambiada
            for cam_id in list(self.workers):
                w = self.workers[cam_id]
                cfg = desired.get(cam_id)
                if cfg is None or cfg.get("updatedAt") != w.cam.get("updatedAt"):
                    w.stop()
                    del self.workers[cam_id]
                    if cfg is not None:
                        log.info("[%s] config cambió — reiniciando worker", cfg["cameraName"])
            # Arrancar los que faltan
            for cam_id, cfg in desired.items():
                if cam_id not in self.workers:
                    worker = CameraWorker(cfg, self.detector)
                    self.workers[cam_id] = worker
                    worker.start()

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "workers": [
                    {
                        "cameraId": w.cam["cameraId"],
                        "cameraName": w.cam["cameraName"],
                        "status": w.status,
                        "framesProcessed": w.frames_processed,
                        "eventsSent": w.events_sent,
                        "lastError": w.last_error,
                    }
                    for w in self.workers.values()
                ],
                "lastRefresh": self.last_refresh,
                "lastRefreshError": self.last_refresh_error,
            }
