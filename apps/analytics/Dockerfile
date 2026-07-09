# apps/analytics/Dockerfile — VisionCore Analytics (CPU por defecto)
# Para GPU NVIDIA: cambiar onnxruntime→onnxruntime-gpu en requirements.txt,
# usar base nvidia/cuda y correr con `--gpus all` (ver README.md).
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# El modelo ONNX se descarga al primer arranque a /models (volumen persistente)
VOLUME /models
ENV MODEL_PATH=/models/yolox_s.onnx

EXPOSE 8500
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:8500/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8500"]
