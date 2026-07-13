# apps/analytics/app/config.py
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # API Node de VisionCore (red interna de docker)
    api_base_url: str = "http://api:4000"
    # Secreto compartido con el API — mismo valor que ANALYTICS_SECRET del API
    analytics_secret: str = ""

    # Provider de detección: "yolox_onnx" (real) o "mock" (sin modelo, para
    # validar el flujo o correr sin pesos). Se resuelve en providers/factory.py.
    provider: str = Field(default="yolox_onnx",
                          validation_alias=AliasChoices("ANALYTICS_PROVIDER", "PROVIDER"))

    # Modelo de detección ONNX (Apache-2.0). YOLOX de Megvii — NO ultralytics (AGPL).
    model_path: str = "/models/yolox_s.onnx"
    model_url: str = (
        "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx"
    )
    input_size: int = 640  # 640 para yolox_s/m, 416 para yolox_tiny/nano

    # Reintento de descarga/carga del modelo cuando falla (no reinicia el proceso)
    model_retry_sec: int = 300

    # Backoff por cámara cuando el stream falla: 10s → 30s → 60s → 5min.
    # Tras 5 fallos consecutivos el worker queda disabled_due_errors hasta
    # que cambie la config de esa cámara.
    rtsp_backoff_schedule: tuple = (10, 30, 60, 300)
    rtsp_max_consecutive_failures: int = 5

    # Ejecución
    refresh_interval_sec: int = 60      # relee configs de cámaras del API
    snapshot_max_width: int = 1280      # ancho máx del JPEG anotado enviado al API
    snapshot_jpeg_quality: int = 80
    rtsp_reconnect_sec: int = 10        # espera antes de reintentar un RTSP caído
    nms_threshold: float = 0.45

    # Transporte RTSP para OpenCV/FFmpeg. MediaMTX corre TCP-only
    # (MTX_PROTOCOLS=tcp) → si OpenCV intenta UDP no llegan frames y no se
    # generan eventos. TCP es obligatorio para leer el restream compartido.
    rtsp_transport: str = "tcp"
    # Timeout de apertura/lectura RTSP en microsegundos (5 s)
    rtsp_stimeout_us: int = 5_000_000

    # Límite de workers concurrentes (protección de CPU/memoria)
    max_workers: int = Field(default=16,
                             validation_alias=AliasChoices("ANALYTICS_MAX_WORKERS", "MAX_WORKERS"))

    # Feature flags de módulos que requieren modelo externo (scaffold).
    fall_detection_enabled: bool = Field(
        default=False, validation_alias=AliasChoices("ANALYTICS_FALL_DETECTION_ENABLED", "FALL_DETECTION_ENABLED"))
    alpr_enabled: bool = Field(
        default=False, validation_alias=AliasChoices("ANALYTICS_ALPR_ENABLED", "ALPR_ENABLED"))

    class Config:
        env_prefix = ""  # variables planas: API_BASE_URL, ANALYTICS_SECRET, MODEL_PATH...


settings = Settings()

# Clases COCO soportadas por el pipeline (ids del dataset COCO-80)
COCO_CLASS_IDS = {
    "person": 0,
    "bicycle": 1,
    "car": 2,
    "motorcycle": 3,
    "bus": 5,
    "truck": 7,
}
CLASS_NAME_BY_ID = {v: k for k, v in COCO_CLASS_IDS.items()}
VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "bicycle"}
