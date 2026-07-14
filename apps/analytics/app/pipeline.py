# apps/analytics/app/pipeline.py
# Un worker (hilo) por cámara. Consume el RESTREAM de MediaMTX (una sola sesión
# RTSP contra el NVR, compartida con la vista en vivo) y solo cae al RTSP directo
# si el API lo permite explícitamente. Responsabilidades separadas:
#   captura → muestreo → inferencia (DetectionProvider) → tracking (ByteTrack)
#   → reglas (zonas/líneas/loitering/aforo) → eventos → snapshots → publicación.
# La lógica de detección está desacoplada del modelo vía DetectionProvider; las
# reglas puras (cooldown/dedup/horario/backoff/circuit-breaker) viven en rules.py.
import base64
import logging
import os
import threading
import time
from typing import Any

from .config import settings, COCO_CLASS_IDS, CLASS_NAME_BY_ID, VEHICLE_CLASSES
from .providers.base import Detection, DetectionProvider
from .providers.factory import create_detection_provider
from .rules import CooldownTracker, TrackDedup, CircuitBreaker, ZoneIntrusionTracker, within_schedule, backoff_delay

# Forzar transporte RTSP (TCP) y timeout ANTES de importar/usar cv2 — OpenCV lee
# OPENCV_FFMPEG_CAPTURE_OPTIONS al construir cada VideoCapture. Sin esto FFmpeg
# intenta UDP y MediaMTX (TCP-only) no entrega frames → sin eventos.
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    f"rtsp_transport;{settings.rtsp_transport}|stimeout;{settings.rtsp_stimeout_us}",
)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import httpx  # noqa: E402
import supervision as sv  # noqa: E402

log = logging.getLogger("analytics.pipeline")


def to_sv_detections(dets: list[Detection]) -> sv.Detections:
    """Convierte Detection neutrales del provider a sv.Detections para tracking."""
    if not dets:
        return sv.Detections.empty()
    xyxy = np.array([[d.x1, d.y1, d.x2, d.y2] for d in dets], dtype=np.float32)
    conf = np.array([d.confidence for d in dets], dtype=np.float32)
    cls = np.array([d.class_id for d in dets], dtype=int)
    return sv.Detections(xyxy=xyxy, confidence=conf, class_id=cls)


class CameraWorker(threading.Thread):
    def __init__(self, cam: dict[str, Any], provider: DetectionProvider):
        super().__init__(daemon=True, name=f"cam-{cam['cameraId'][:8]}")
        self.cam = cam
        self.provider = provider
        self.stop_event = threading.Event()
        self.tracker = sv.ByteTrack()
        self.box_annotator = sv.BoxAnnotator(thickness=2)
        self.label_annotator = sv.LabelAnnotator(text_scale=0.5)
        try:
            self.trace_annotator: Any = sv.TraceAnnotator(thickness=2, trace_length=30)
        except Exception:  # noqa: BLE001 — versiones viejas de supervision
            self.trace_annotator = None
        # Reglas puras
        self.cooldowns = CooldownTracker()
        self.dedup = TrackDedup()
        self.breaker = CircuitBreaker(max_failures=settings.rtsp_max_consecutive_failures)
        # Deduplicación de intrusiones por (cameraId+zona+track): una intrusión al
        # entrar, sin repetir mientras permanezca dentro; se re-arma al salir.
        self.zone_tracker = ZoneIntrusionTracker(
            lost_grace_sec=float(self.cam.get("zoneLostGraceSec", 5)))
        # Zonas / líneas materializadas al conocer el tamaño del frame
        self.zones: list[dict[str, Any]] = []
        self.zone_objects: list[sv.PolygonZone] = []
        self.zone_annotators: list[Any] = []
        self.lines: list[dict[str, Any]] = []
        self.line_objects: list[sv.LineZone] = []
        self.line_annotator: Any = None
        self.frame_size: tuple[int, int] | None = None
        # Estado observable
        self.status = "starting"
        self.frames_processed = 0
        self.events_sent = 0
        self.detections_total = 0
        self.last_error: str | None = None
        self.last_detection_at: float | None = None
        self.last_frame_at: float | None = None
        self.using_fallback = False
        self.fps_actual = 0.0
        self.last_inference_ms = 0.0
        self.last_annotated_jpeg: bytes | None = None
        self.zone_occupancy: dict[str, int] = {}
        self.line_counts: dict[str, dict[str, int]] = {}

    # ── Config materialization ────────────────────────────────────────────
    def _build_zones(self, w: int, h: int) -> None:
        self.zones = list(self.cam.get("zones") or [])
        self.zone_objects, self.zone_annotators = [], []
        for z in self.zones:
            pts = np.array([[int(px * w), int(py * h)] for px, py in z["points"]], dtype=np.int32)
            zone = sv.PolygonZone(polygon=pts)
            self.zone_objects.append(zone)
            try:
                self.zone_annotators.append(sv.PolygonZoneAnnotator(zone=zone, color=sv.Color.RED, thickness=2))
            except Exception:  # noqa: BLE001
                self.zone_annotators.append(None)
        self.lines = list(self.cam.get("lines") or [])
        self.line_objects = []
        for ln in self.lines:
            start = sv.Point(int(ln["start"][0] * w), int(ln["start"][1] * h))
            end = sv.Point(int(ln["end"][0] * w), int(ln["end"][1] * h))
            self.line_objects.append(sv.LineZone(start=start, end=end))
        try:
            self.line_annotator = sv.LineZoneAnnotator(thickness=2, text_scale=0.5)
        except Exception:  # noqa: BLE001
            self.line_annotator = None
        if self.zones or self.lines:
            log.info("[%s] %d zonas + %d líneas materializadas (%dx%d)",
                     self.cam["cameraName"], len(self.zones), len(self.lines), w, h)

    def _watched_class_ids(self) -> set[int]:
        return {COCO_CLASS_IDS[c] for c in self.cam["classes"] if c in COCO_CLASS_IDS}

    def _min_conf_for(self, class_name: str) -> float:
        by_class = self.cam.get("confidenceByClass") or {}
        return float(by_class.get(class_name, self.cam.get("minConfidence", 0.5)))

    def _cooldown_ok(self, key: str, ev_type: str) -> bool:
        alert_cfg = (self.cam.get("alertConfig") or {}).get(ev_type) or {}
        cooldown = alert_cfg.get("cooldownSec") or self.cam.get("cooldownSec", 60)
        return self.cooldowns.should_emit(key, cooldown)

    def _schedule_ok(self) -> bool:
        return within_schedule(self.cam.get("schedule"))

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
            if self.trace_annotator is not None:
                try:
                    annotated = self.trace_annotator.annotate(annotated, detections)
                except Exception:  # noqa: BLE001
                    pass
            annotated = self.box_annotator.annotate(annotated, detections)
            annotated = self.label_annotator.annotate(annotated, detections, labels=labels)
        for zi, (z, zobj) in enumerate(zip(self.zones, self.zone_objects)):
            zann = self.zone_annotators[zi] if zi < len(self.zone_annotators) else None
            if zann is not None:
                try:
                    annotated = zann.annotate(scene=annotated)
                except Exception:  # noqa: BLE001
                    cv2.polylines(annotated, [zobj.polygon], True, (0, 0, 255), 2)
            else:
                cv2.polylines(annotated, [zobj.polygon], True, (0, 0, 255), 2)
            occ = self.zone_occupancy.get(z["name"], 0)
            cv2.putText(annotated, f"{z['name']} ({occ})", tuple(zobj.polygon[0]),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        for ln, lobj in zip(self.lines, self.line_objects):
            if self.line_annotator is not None:
                try:
                    annotated = self.line_annotator.annotate(annotated, line_counter=lobj)
                    continue
                except Exception:  # noqa: BLE001
                    pass
            p1 = (int(lobj.vector.start.x), int(lobj.vector.start.y))
            p2 = (int(lobj.vector.end.x), int(lobj.vector.end.y))
            cv2.line(annotated, p1, p2, (255, 180, 0), 2)
            cv2.putText(annotated, f"{ln['name']} in:{lobj.in_count} out:{lobj.out_count}",
                        (p1[0], max(20, p1[1] - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 180, 0), 2)
        return annotated

    def _resize_for_jpeg(self, img: np.ndarray) -> np.ndarray:
        if img.shape[1] > settings.snapshot_max_width:
            scale = settings.snapshot_max_width / img.shape[1]
            return cv2.resize(img, None, fx=scale, fy=scale)
        return img

    def _store_live_frame(self, annotated: np.ndarray) -> None:
        ok, jpeg = cv2.imencode(".jpg", self._resize_for_jpeg(annotated), [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            self.last_annotated_jpeg = jpeg.tobytes()

    def _emit_zone_exits(self, now: float, schedule_ok: bool,
                         annotated: np.ndarray, detections: sv.Detections) -> None:
        """Barre salidas de zona (tracks ausentes > lost_grace) y emite zone_exit,
        re-armando el incidente. Se llama tanto en frames con detecciones como
        vacíos (si no, el último objeto que se va nunca cerraría su incidente)."""
        for ev in self.zone_tracker.sweep_exits(now):
            if schedule_ok:
                self._post_event(ev["type"], "object", 0.0, annotated, detections,
                                 track_id=int(ev["track_id"]), zone_name=ev["zone_name"],
                                 incident_id=ev["incident_id"])

    # ── Publicación de eventos ────────────────────────────────────────────
    def _post_event(self, ev_type: str, class_name: str, confidence: float,
                    annotated: np.ndarray, detections: sv.Detections,
                    track_id: int | None = None, zone_name: str | None = None,
                    direction: str | None = None, incident_id: str | None = None) -> None:
        ok, jpeg = cv2.imencode(".jpg", self._resize_for_jpeg(annotated),
                                [cv2.IMWRITE_JPEG_QUALITY, settings.snapshot_jpeg_quality])
        snapshot_b64 = base64.b64encode(jpeg.tobytes()).decode() if ok else None

        bboxes = [
            [round(float(x1), 1), round(float(y1), 1), round(float(x2), 1), round(float(y2), 1),
             round(float(conf), 3), CLASS_NAME_BY_ID.get(int(cid), str(cid))]
            for (x1, y1, x2, y2), conf, cid
            in zip(detections.xyxy, detections.confidence, detections.class_id)
        ][:64]

        payload = {
            "cameraId": self.cam["cameraId"], "type": ev_type, "className": class_name,
            "confidence": round(float(confidence), 3),
            "trackId": int(track_id) if track_id is not None else None,
            "zoneName": zone_name, "direction": direction, "bboxes": bboxes,
            "incidentId": incident_id,
            "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z",
            "snapshotJpegBase64": snapshot_b64,
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        try:
            r = httpx.post(f"{settings.api_base_url}/api/analytics/internal/events",
                           json=payload, headers={"x-analytics-secret": settings.analytics_secret},
                           timeout=15)
            r.raise_for_status()
            self.events_sent += 1
            log.info("analytics_event_sent camera=%s type=%s class=%s conf=%.2f zone=%s dir=%s",
                     self.cam["cameraName"], ev_type, class_name, confidence, zone_name, direction)
        except Exception as exc:  # noqa: BLE001
            log.warning("analytics_event_rejected camera=%s type=%s err=%s",
                        self.cam["cameraName"], ev_type, exc)

    # ── Procesamiento de un frame ─────────────────────────────────────────
    def _process(self, frame: np.ndarray) -> None:
        t0 = time.time()
        raw = self.provider.infer(frame, self.cam.get("minConfidence", 0.5))
        self.last_inference_ms = round((time.time() - t0) * 1000, 1)

        watched = self._watched_class_ids()
        # filtro por clase vigilada + umbral por clase
        raw = [d for d in raw if d.class_id in watched and d.confidence >= self._min_conf_for(d.class_name)]
        detections = to_sv_detections(raw)
        detections = self.tracker.update_with_detections(detections)
        self.frames_processed += 1
        self.detections_total += len(detections)
        if len(detections) > 0:
            self.last_detection_at = time.time()

        # Ocupación por zona
        zone_inside: list[Any] = []
        for z, zobj in zip(self.zones, self.zone_objects):
            inside = zobj.trigger(detections) if len(detections) > 0 else np.array([], dtype=bool)
            zone_inside.append(inside)
            self.zone_occupancy[z["name"]] = int(inside.sum()) if len(inside) else 0

        annotated = self._annotate(frame, detections)
        self._store_live_frame(annotated)
        if len(detections) == 0:
            # Aun sin detecciones hay que barrer salidas: si el último objeto se
            # fue y los frames siguientes están vacíos, sin esto zone_exit nunca se
            # emitiría y el incidente quedaría activo → una reaparición con el mismo
            # tracker id se tomaría como el mismo ocupante en vez de una re-entrada.
            self._emit_zone_exits(time.time(), self._schedule_ok(), annotated, detections)
            return

        schedule_ok = self._schedule_ok()

        # 1) Detección de objeto nuevo (track nuevo) → person / vehicle
        if detections.tracker_id is not None and schedule_ok:
            for i, tid in enumerate(detections.tracker_id):
                if tid is None or not self.dedup.is_new(int(tid)):
                    continue
                cname = CLASS_NAME_BY_ID.get(int(detections.class_id[i]), "")
                ev_type = "person" if cname == "person" else ("vehicle" if cname in VEHICLE_CLASSES else None)
                if ev_type and self._cooldown_ok(f"{ev_type}|{cname}", ev_type):
                    self._post_event(ev_type, cname, float(detections.confidence[i]),
                                     annotated, detections, track_id=int(tid))

        # 2) Líneas de conteo por cruce (el conteo se hace siempre; el evento respeta horario)
        for ln, lobj in zip(self.lines, self.line_objects):
            line_classes = set(ln.get("classes") or self.cam["classes"])
            crossed_in, crossed_out = lobj.trigger(detections)
            self.line_counts[ln["name"]] = {"in": int(lobj.in_count), "out": int(lobj.out_count)}
            if not schedule_ok:
                continue
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

        # 3) Zonas: intrusión (deduplicada por máquina de estado) + permanencia +
        #    salida + aforo. Un objeto que permanece dentro NO repite intrusión;
        #    sólo se re-arma tras salir (sweep_exits por ausencia del track).
        now = time.time()
        camera_id = str(self.cam["cameraId"])
        for zi, (z, zobj) in enumerate(zip(self.zones, self.zone_objects)):
            zone_classes = set(z.get("classes") or self.cam["classes"])
            inside = zone_inside[zi]
            loitering_sec = z.get("loiteringSec")
            reminder_sec = z.get("reminderSec")
            for i, is_in in enumerate(inside):
                if not is_in:
                    continue
                cname = CLASS_NAME_BY_ID.get(int(detections.class_id[i]), "")
                if cname not in zone_classes:
                    continue
                tid = detections.tracker_id[i] if detections.tracker_id is not None else None
                conf = float(detections.confidence[i])

                if tid is None:
                    # Sin tracker: no se puede deduplicar por objeto → cooldown clásico
                    if schedule_ok and self._cooldown_ok(f"zone|{z['name']}|{cname}", "zone_intrusion"):
                        self._post_event("zone_intrusion", cname, conf, annotated, detections,
                                         zone_name=z["name"])
                    continue

                zone_events = self.zone_tracker.mark_inside(
                    camera_id, z["name"], int(tid), now,
                    loitering_sec=float(loitering_sec) if loitering_sec else None,
                    reminder_sec=float(reminder_sec) if reminder_sec else None,
                )
                for ev in zone_events:
                    # loitering/reminder respetan horario; la traza de intrusión también
                    if not schedule_ok:
                        continue
                    self._post_event(ev["type"], cname, conf, annotated, detections,
                                     track_id=int(tid), zone_name=z["name"],
                                     incident_id=ev["incident_id"])

            occupancy_limit = z.get("occupancyLimit")
            occ = self.zone_occupancy.get(z["name"], 0)
            if occupancy_limit and occ > occupancy_limit and schedule_ok:
                if self._cooldown_ok(f"occupancy|{z['name']}", "occupancy_limit"):
                    self._post_event("occupancy_limit", "person", 1.0,
                                     annotated, detections, zone_name=z["name"])

        # Salidas: tracks que dejaron de verse dentro de cualquier zona (con
        # tolerancia lost_grace) → zone_exit, re-armando para futuras entradas.
        self._emit_zone_exits(now, schedule_ok, annotated, detections)

    # ── Apertura de captura ───────────────────────────────────────────────
    def _open_capture(self) -> "cv2.VideoCapture | None":
        primary = self.cam.get("analyticsRtspUrl")
        fallback = self.cam.get("directRtspUrl")  # None salvo opt-in explícito
        for url, is_fallback in ((primary, False), (fallback, True)):
            if not url:
                continue
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            if cap.isOpened():
                try:
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                except Exception:  # noqa: BLE001
                    pass
                self.using_fallback = is_fallback
                if is_fallback:
                    log.warning("analytics_rtsp_fallback_direct camera=%s", self.cam["cameraName"])
                else:
                    log.info("analytics_rtsp_connected camera=%s", self.cam["cameraName"])
                return cap
            cap.release()
            log.warning("analytics_rtsp_open_failed camera=%s source=%s transport=%s",
                        self.cam["cameraName"], "mediamtx" if not is_fallback else "direct",
                        settings.rtsp_transport)
        return None

    def run(self) -> None:
        interval = 1.0 / max(0.2, float(self.cam.get("sampleFps", 2)))
        log.info("analytics_worker_started camera=%s fps=%.1f clases=%s via=%s",
                 self.cam["cameraName"], self.cam.get("sampleFps", 2), self.cam["classes"],
                 "mediamtx" if self.cam.get("analyticsRtspUrl") else "direct")

        while not self.stop_event.is_set():
            cap = self._open_capture()
            if cap is None:
                if self.breaker.record_failure():
                    self.status = "disabled_due_errors"
                    log.error("analytics_worker_disabled camera=%s tras %d fallos",
                              self.cam["cameraName"], self.breaker.failures)
                    return
                wait = backoff_delay(self.breaker.failures, settings.rtsp_backoff_schedule)
                self.status = "rtsp_down"
                log.warning("analytics_rtsp_backoff camera=%s intento=%d espera=%ds",
                            self.cam["cameraName"], self.breaker.failures, wait)
                if self.stop_event.wait(wait):
                    break
                continue

            self.status = "running"
            self.breaker.record_success()
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
                self.last_frame_at = now
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
                if self.breaker.record_failure():
                    self.status = "disabled_due_errors"
                    log.error("analytics_worker_disabled camera=%s tras %d cortes",
                              self.cam["cameraName"], self.breaker.failures)
                    return
                self.status = "reconnecting"
                self.stop_event.wait(backoff_delay(self.breaker.failures, settings.rtsp_backoff_schedule))

        self.status = "stopped"
        log.info("analytics_worker_stopped camera=%s", self.cam["cameraName"])

    def stop(self) -> None:
        self.stop_event.set()


class PipelineManager:
    """Sincroniza los workers con la config del API. El provider de detección se
    carga con reintentos — un modelo caído deja el servicio en model_error pero
    el proceso sigue vivo."""

    def __init__(self) -> None:
        self.provider: DetectionProvider | None = None
        self.model_error: str | None = None
        self.workers: dict[str, CameraWorker] = {}
        self.lock = threading.Lock()
        self.last_refresh: float | None = None
        self.last_refresh_error: str | None = None

    # compat: el resto del código consultaba manager.detector para saber si el
    # modelo está cargado; exponemos un alias de solo lectura.
    @property
    def detector(self) -> DetectionProvider | None:
        return self.provider

    def start(self) -> None:
        threading.Thread(target=self._model_loop, daemon=True, name="model").start()
        threading.Thread(target=self._refresh_loop, daemon=True, name="refresh").start()

    def _model_loop(self) -> None:
        while self.provider is None:
            try:
                provider = create_detection_provider(settings.provider)
                provider.load()
                self.provider = provider
                self.model_error = None
                log.info("analytics_model_loaded provider=%s", settings.provider)
            except Exception as exc:  # noqa: BLE001
                self.model_error = str(exc)
                log.error("analytics_model_error provider=%s err=%s — reintento en %ds",
                          settings.provider, exc, settings.model_retry_sec)
                time.sleep(settings.model_retry_sec)

    def _fetch_cameras(self) -> list[dict[str, Any]]:
        r = httpx.get(f"{settings.api_base_url}/api/analytics/internal/cameras",
                      headers={"x-analytics-secret": settings.analytics_secret}, timeout=15)
        r.raise_for_status()
        return r.json().get("cameras", [])

    def _refresh_loop(self) -> None:
        while True:
            if self.provider is not None:
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
        assert self.provider is not None
        with self.lock:
            desired = {c["cameraId"]: c for c in cams}
            # límite de workers para proteger CPU/memoria
            if len(desired) > settings.max_workers:
                allowed = dict(list(desired.items())[: settings.max_workers])
                log.warning("límite de workers (%d) — %d cámaras ignoradas",
                            settings.max_workers, len(desired) - settings.max_workers)
                desired = allowed
            for cam_id in list(self.workers):
                w = self.workers[cam_id]
                cfg = desired.get(cam_id)
                if cfg is None or cfg.get("updatedAt") != w.cam.get("updatedAt"):
                    w.stop()
                    del self.workers[cam_id]
                    if cfg is not None:
                        log.info("[%s] config cambió — reiniciando worker", cfg["cameraName"])
            for cam_id, cfg in desired.items():
                if cam_id not in self.workers:
                    worker = CameraWorker(cfg, self.provider)
                    self.workers[cam_id] = worker
                    worker.start()

    def restart_worker(self, camera_id: str) -> bool:
        """Reinicia manualmente un worker (p.ej. tras disabled_due_errors)."""
        with self.lock:
            w = self.workers.pop(camera_id, None)
            if not w:
                return False
            cfg = w.cam
            w.stop()
            if self.provider is not None:
                nw = CameraWorker(cfg, self.provider)
                self.workers[camera_id] = nw
                nw.start()
            return True

    def get_last_frame(self, camera_id: str) -> bytes | None:
        w = self.workers.get(camera_id)
        return w.last_annotated_jpeg if w else None

    def has_worker(self, camera_id: str) -> bool:
        return camera_id in self.workers

    def status(self) -> dict[str, Any]:
        with self.lock:
            meta = self.provider.metadata() if self.provider else None
            workers = [
                {
                    "cameraId": w.cam["cameraId"], "cameraName": w.cam["cameraName"],
                    "status": w.status, "framesProcessed": w.frames_processed,
                    "eventsSent": w.events_sent, "detectionsTotal": w.detections_total,
                    "fpsActual": w.fps_actual, "inferenceMs": w.last_inference_ms,
                    "usingFallback": w.using_fallback, "lastError": w.last_error,
                    "lastDetectionAt": w.last_detection_at, "lastFrameAt": w.last_frame_at,
                    "zoneOccupancy": w.zone_occupancy, "lineCounts": w.line_counts,
                }
                for w in self.workers.values()
            ]
            return {
                "serviceStatus": "model_error" if self.provider is None else "running",
                "modelLoaded": self.provider is not None,
                "modelError": self.model_error,
                "provider": meta.name if meta else settings.provider,
                "providers": meta.providers if meta else [],
                "lastRefresh": self.last_refresh,
                "lastRefreshError": self.last_refresh_error,
                "workers": workers,
            }
