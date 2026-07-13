# apps/analytics/Dockerfile — VisionCore Analytics (CPU por defecto)
# Para GPU NVIDIA: cambiar onnxruntime→onnxruntime-gpu en requirements.txt,
# usar base nvidia/cuda y correr con `--gpus all` (ver README.md).
FROM python:3.11-slim

# libglib2.0-0 + libxcb1 + libgl1: requeridas por opencv en Debian slim.
#   libgl1 provee libGL.so.1 — aunque usamos opencv-python-headless, algunos
#   wheels/transitorios (p.ej. supervision→matplotlib) enlazan libGL en runtime.
#   Sin ella cv2 falla con "ImportError: libGL.so.1: cannot open shared object file"
#   y el servicio queda healthy (FastAPI responde) pero con el pipeline degradado.
# libgomp1: requerida por onnxruntime (OpenMP)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libxcb1 libgl1 libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Smoke test de dependencias nativas en build-time: si cv2/onnxruntime/supervision
# no importan (falta libGL, libgomp, etc.) el build FALLA aquí en lugar de arrancar
# un contenedor "healthy" con el pipeline roto. No resolver esto por instalación
# manual en producción — debe quedar horneado en la imagen.
RUN python -c "import cv2, onnxruntime, supervision; \
print('cv2', cv2.__version__); \
print('onnxruntime', onnxruntime.__version__); \
print('supervision', supervision.__version__)"

# El modelo ONNX se descarga al primer arranque a /models (volumen persistente)
VOLUME /models
ENV MODEL_PATH=/models/yolox_s.onnx

EXPOSE 8500
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:8500/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8500"]
