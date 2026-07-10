# apps/analytics/app/pipeline.py
# Un worker (hilo) por cámara. Consume el RESTREAM de MediaMTX (una sola
# sesión RTSP contra el NVR, compartida con la vista en vivo) y solo cae al
# RTSP directo del NVR como último recurso. Detecta con YOLOX, trackea con
# ByteTrack (supervision), evalúa zonas/líneas/permanencia/aforo y publica
# eventos al API con snapshot anotado.
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
        self.reported_tracks: set[int] = set()
        self.zones: list[dict[str, Any]] = []
        self.zone_objects: list[sv.PolygonZone] = []
        self.lines: list[dict[str, Any]] = []
        self.line_objects: list[sv.LineZone] = []
        # Permanencia (loitering): (zona_idx, track_id) → epoch de entrada
        self.zone_entry_at: dict[tuple[int, int], float] = {}
        self.loitering_reported: set[tuple[int, int]] = set()
        self.frame_size: tuple[int, int] | None = None
        # Estado observable
        self.status = "starting"
        self.frames_processed = 0
        self.events_sent = 0
        self.last_error: str | None = None
        self.last_detection_at: float | None = None
        self.consecutive_failures = 0
        self.using_fallback = False
        self.fps_actual = 0.0
        self.last_annotated_jpeg: bytes | None = None
        self.zone_occupancy: dict[str, int] = {}
        self.line_counts: dict[str, dict[str, int]] = {}

    # ── Config materialization ────────────────────────────────────────────
    def _build_zones(self, w: int, h: int) -> None:
        self.zones = list(self.cam.get("zones") or [])
        self.zone_objects = []
        for z in self.zones:
            pts = np.array([[int(px * w), int(py * h)] for px, py in z["points"]], dtype=np.int32)
            self.zone_objects.append(sv.PolygonZone(polygon=pts))
        self.lines = list(self.cam.get("lines") or [])
        self.line_objects = []
        for ln in self.lines:
            start = sv.Point(int(ln["start"][0] * w), int(ln["start"][1] * h))
            end = sv.Point(int(ln["end"][0] * w), int(ln["end"][1] * h))
            self.line_objects.append(sv.LineZone(start=start, end=end))
        if self.zones or self.lines:
            log.info("[%s] %d zonas + %d líneas materializadas (%dx%d)",
                     self.cam["cameraName"], len(self.zones), len(self.lines), w, h)

    def _watched_class_ids(self) -> set[int]:
        return {COCO_CLASS_IDS[c] for c in self.cam["classes"] if c in COCO_CLASS_IDS}

    def _cooldown_ok(self, key: tuple[str, str], ev_type: str) -> bool:
        # cooldown por tipo de evento si está configurado, si no el global
        alert_cfg = (self.cam.get("alertConfig") or {}).get(ev_type) or {}
        cooldown = alert_cfg.get("cooldownSec") or self.cam.get("cooldownSec", 60)
        now = time.time()
        if now - self.last_event_at.get(key, 0) < cooldown:
            return False
        self.last_event_at[key] = now
        return True

    # ── Snapshot anotado ──────────────────────────────────────────────────
    def _annotate(self, frame: np.ndarray, detections: sv.Detections) -> np.ndarray:
        annotated = frame.copy()
        if len(detections) > 0:
            labels = []
            for i in range(len(detections)):
                cname = CLASS_NAME_BY_ID.get(int(detections.class_id[i]), "?")
                tid = detections.tracker_id[i] if detections.tracker_id is not None else None
                tid_s = f"#{int(tid)} " if tid is not None else ""
                labels.append(f"{tid_s}{cname} {detections.confidence[i]:.0%}")
            annotated = self.box_annotator.annotate(annotated, detections)
            annotated = self.label_annotator.annotate(annotated, detections, labels=labels)
        for z, zobj in zip(self.zones, self.zone_objects):
            occ = self.zone_occupancy.get(z["name"], 0)
            cv2.polylines(annotated, [zobj.polygon], True, (0, 0, 255), 2)
            cv2.putText(annotated, f"{z['name']} ({occ})", tuple(zobj.polygon[0]),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        for ln, lobj in zip(self.lines, self.line_objects):
            p1 = (int(lobj.vector.start.x), int(lobj.vector.start.y))
            p2 = (int(lobj.vector.end.x), int(lobj.vector.end.y))
            cv2.line(annotated, p1, p2, (255, 180, 0), 2)
            cv2.putText(annotated, f"{ln['name']} in:{lobj.in_count} out:{lobj.out_count}",
                        (p1[0], max(20, p1[1] - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 180, 0), 2)
        return annotated

    def _store_live_frame(self, annotated: np.ndarray) -> None:
        img = annotated
        if img.shape[1] > settings.snapshot_max_width:
            scale = settings.snapshot_max_width / img.shape[1]
            img = cv2.resize(img, None, fx=scale, fy=scale)
        ok, jpeg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            self.last_annotated_jpeg = jpeg.tobytes()

    # ── Publicación de eventos ────────────────────────────────────────────
    def _post_event(self, ev_type: str, class_name: str, confidence: float,
                    annotated: np.ndarray, detections: sv.Detections,
                    track_id: int | None = None, zone_name: str | None = None,
                    direction: str | None = None) -> None:
        img = annotated
        if img.shape[1] > settings.snapshot_max_width:
            scale = settings.snapshot_max_width / img.shape[1]
            img = cv2.resize(img, None, fx=scale, fy=scale)
        ok, jpeg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, settings.snapshot_jpeg_quality])
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
            "direction": direction,
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
            log.info("analytics_event_sent camera=%s type=%s class=%s conf=%.2f zone=%s dir=%s",
                     self.cam["cameraName"], ev_type, class_name, confidence, zone_name, direction)
        except Exception as exc:  # noqa: BLE001
            log.warning("analytics_event_rejected camera=%s type=%s err=%s",
                        self.cam["cameraName"], ev_type, exc)

    # ── Procesamiento de un frame ─────────────────────────────────────────
    def _process(self, frame: np.ndarray) -> None:
        detections = self.detector.infer(frame, self.cam["minConfidence"])
        watched = self._watched_class_ids()
        if len(detections) > 0:
            mask = np.isin(detections.class_id, list(watched))
            detections = detections[mask]

        detections = self.tracker.update_with_detections(detections)
        self.frames_processed += 1
        if len(detections) > 0:
            self.last_detection_at = time.time()

        # Ocupación por zona (para overlay + evento occupancy_limit)
        zone_inside: list[np.ndarray] = []
        for z, zobj in zip(self.zones, self.zone_objects):
            inside = zobj.trigger(detections) if len(detections) > 0 else np.array([], dtype=bool)
            zone_inside.append(inside)
            self.zone_occupancy[z["name"]] = int(inside.sum()) if len(inside) else 0

        annotated = self._annotate(frame, detections)
        self._store_live_frame(annotated)
        if len(detections) == 0:
            return

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
                if ev_type and self._cooldown_ok((ev_type, cname), ev_type):
                    self._post_event(ev_type, cname, float(detections.confidence[i]),
                                     annotated, detections, track_id=int(tid))

        # 2) Líneas de conteo por cruce
        for ln, lobj in zip(self.lines, self.line_objects):
            line_classes = set(ln.get("classes") or self.cam["classes"])
            crossed_in, crossed_out = lobj.trigger(detections)
            self.line_counts[ln["name"]] = {"in": int(lobj.in_count), "out": int(lobj.out_count)}
            for i in range(len(detections)):
                direction = "in" if crossed_in[i] else ("out" if crossed_out[i] else None)
                if direction is None:
                    continue
                cname = CLASS_NAME_BY_ID.get(int(detections.class_id[i]), "")
                if cname not in line_classes:
                    continue
                tid = detections.tracker_id[i] if detections.tracker_id is not None else None
                self._post_event("line_crossing", cname, float(detections.confidence[i]),
                                 annotated, detections,
                                 track_id=int(tid) if tid is not None else None,
                                 zone_name=ln["name"], direction=direction)

        # 3) Zonas: intrusión + permanencia (loitering) + aforo (occupancy)
        now = time.time()
        for zi, (z, zobj) in enumerate(zip(self.zones, self.zone_objects)):
            zone_classes = set(z.get("classes") or self.cam["classes"])
            inside = zone_inside[zi]
            inside_tids: set[int] = set()
            for i, is_in in enumerate(inside):
                if not is_in:
                    continue
                cname = CLASS_NAME_BY_ID.get(int(detections.class_id[i]), "")
                if cname not in zone_classes:
                    continue
                tid = detections.tracker_id[i] if detections.tracker_id is not None else None

                if self._cooldown_ok(("zone", f"{z['name']}|{cname}"), "zone_intrusion"):
                    self._post_event("zone_intrusion", cname, float(detections.confidence[i]),
                                     annotated, detections,
                                     track_id=int(tid) if tid is not None else None,
                                     zone_name=z["name"])

                # Loitering: track dentro de la zona más de loiteringSec
                loitering_sec = z.get("loiteringSec")
                if loitering_sec and tid is not None:
                    tkey = (zi, int(tid))
                    inside_tids.add(int(tid))
                    entered = self.zone_entry_at.setdefault(tkey, now)
                    if now - entered >= loitering_sec and tkey not in self.loitering_reported:
                        self.loitering_reported.add(tkey)
                        self._post_event("loitering", cname, float(detections.confidence[i]),
                                         annotated, detections,
                                         track_id=int(tid), zone_name=z["name"])

            # limpiar tracks que salieron de la zona
            for tkey in [k for k in self.zone_entry_at if k[0] == zi and k[1] not in inside_tids]:
                self.zone_entry_at.pop(tkey, None)
                self.loitering_reported.discard(tkey)

            # Aforo: más objetos dentro que el límite configurado
            occupancy_limit = z.get("occupancyLimit")
            occ = self.zone_occupancy.get(z["name"], 0)
            if occupancy_limit and occ > occupancy_limit:
                if self._cooldown_ok(("occupancy", z["name"]), "occupancy_limit"):
                    self._post_event("occupancy_limit", "person", 1.0,
                                     annotated, detections, zone_name=z["name"])

    # ── Loop principal con backoff ────────────────────────────────────────
    def _open_capture(self) -> "cv2.VideoCapture | None":
        """MediaMTX primero (sesión compartida con live view); RTSP directo
        al NVR SOLO como fallback explícito — nunca debe competir con live."""
        primary = self.cam.get("analyticsRtspUrl")
        fallback = self.cam.get("directRtspUrl") or self.cam.get("rtspUrl")
        for url, is_fallback in ((primary, False), (fallback, True)):
            if not url:
                continue
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            if cap.isOpened():
                self.using_fallback = is_fallback
                if is_fallback:
                    log.warning("analytics_rtsp_fallback_direct camera=%s (MediaMTX no disponible)",
                                self.cam["cameraName"])
                return cap
            cap.release()
            log.warning("analytics_rtsp_open_failed camera=%s source=%s",
                        self.cam["cameraName"], "mediamtx" if not is_fallback else "direct")
        return None

    def run(self) -> None:
        interval = 1.0 / max(0.2, float(self.cam.get("sampleFps", 2)))
        log.info("analytics_worker_started camera=%s fps=%.1f clases=%s via=%s",
                 self.cam["cameraName"], self.cam.get("sampleFps", 2), self.cam["classes"],
                 "mediamtx" if self.cam.get("analyticsRtspUrl") else "direct")

        while not self.stop_event.is_set():
            cap = self._open_capture()
            if cap is None:
                self.consecutive_failures += 1
                self.last_error = "no se pudo abrir el stream (MediaMTX ni directo)"
                if self.consecutive_failures >= settings.rtsp_max_consecutive_failures:
                    self.status = "disabled_due_errors"
                    log.error("analytics_worker_disabled camera=%s tras %d fallos — "
                              "requiere cambio de config para reintentar",
                              self.cam["cameraName"], self.consecutive_failures)
                    return
                idx = min(self.consecutive_failures - 1, len(settings.rtsp_backoff_schedule) - 1)
                wait = settings.rtsp_backoff_schedule[idx]
                self.status = "rtsp_down"
                log.warning("analytics_rtsp_backoff camera=%s intento=%d espera=%ds",
                            self.cam["cameraName"], self.consecutive_failures, wait)
                if self.stop_event.wait(wait):
                    break
                continue

            self.status = "running"
            self.consecutive_failures = 0
            last_sample = 0.0
            fps_window_start, fps_frames = time.time(), 0
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
                    fps_frames += 1
                    if now - fps_window_start >= 10:
                        self.fps_actual = round(fps_frames / (now - fps_window_start), 2)
                        fps_window_start, fps_frames = now, 0
                except Exception as exc:  # noqa: BLE001
                    self.last_error = str(exc)
                    log.exception("[%s] error procesando frame", self.cam["cameraName"])

            cap.release()
            if not self.stop_event.is_set():
                self.consecutive_failures += 1
                if self.consecutive_failures >= settings.rtsp_max_consecutive_failures:
                    self.status = "disabled_due_errors"
                    log.error("analytics_worker_disabled camera=%s tras %d cortes",
                              self.cam["cameraName"], self.consecutive_failures)
                    return
                idx = min(self.consecutive_failures - 1, len(settings.rtsp_backoff_schedule) - 1)
                self.status = "reconnecting"
                self.stop_event.wait(settings.rtsp_backoff_schedule[idx])

        self.status = "stopped"
        log.info("analytics_worker_stopped camera=%s", self.cam["cameraName"])

    def stop(self) -> None:
        self.stop_event.set()


class PipelineManager:
    """Sincroniza los workers con la configuración del API. El modelo se
    carga acá con reintentos — un modelo caído deja el servicio en
    model_error pero el proceso sigue vivo."""

    def __init__(self) -> None:
        self.detector: YoloxDetector | None = None
        self.model_error: str | None = None
        self.workers: dict[str, CameraWorker] = {}
        self.lock = threading.Lock()
        self.last_refresh: float | None = None
        self.last_refresh_error: str | None = None

    def start(self) -> None:
        threading.Thread(target=self._model_loop, daemon=True, name="model").start()
        threading.Thread(target=self._refresh_loop, daemon=True, name="refresh").start()

    def _model_loop(self) -> None:
        while self.detector is None:
            try:
                self.detector = YoloxDetector()
                self.model_error = None
                log.info("analytics_model_loaded")
            except Exception as exc:  # noqa: BLE001
                self.model_error = str(exc)
                log.error("analytics_model_error err=%s — reintento en %ds",
                          exc, settings.model_retry_sec)
                time.sleep(settings.model_retry_sec)

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
            if self.detector is not None:
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
            for cam_id in list(self.workers):
                w = self.workers[cam_id]
                cfg = desired.get(cam_id)
                if cfg is None or cfg.get("updatedAt") != w.cam.get("updatedAt"):
                    # disabled_due_errors solo se rearma si la config CAMBIÓ
                    w.stop()
                    del self.workers[cam_id]
                    if cfg is not None:
                        log.info("[%s] config cambió — reiniciando worker", cfg["cameraName"])
            for cam_id, cfg in desired.items():
                if cam_id not in self.workers:
                    worker = CameraWorker(cfg, self.detector)
                    self.workers[cam_id] = worker
                    worker.start()

    def get_last_frame(self, camera_id: str) -> bytes | None:
        w = self.workers.get(camera_id)
        return w.last_annotated_jpeg if w else None

    def status(self) -> dict[str, Any]:
        with self.lock:
            workers = [
                {
                    "cameraId": w.cam["cameraId"],
                    "cameraName": w.cam["cameraName"],
                    "status": w.status,
                    "framesProcessed": w.frames_processed,
                    "eventsSent": w.events_sent,
                    "fpsActual": w.fps_actual,
                    "usingFallback": w.using_fallback,
                    "lastError": w.last_error,
                    "lastDetectionAt": w.last_detection_at,
                    "zoneOccupancy": w.zone_occupancy,
                    "lineCounts": w.line_counts,
                }
                for w in self.workers.values()
            ]
            return {
                "serviceStatus": "model_error" if self.detector is None else "running",
                "modelLoaded": self.detector is not None,
                "modelError": self.model_error,
                "lastRefresh": self.last_refresh,
                "lastRefreshError": self.last_refresh_error,
                "workers": workers,
            }
