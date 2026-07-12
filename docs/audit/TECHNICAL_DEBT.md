# VisionCore — Deuda técnica

Prioridad: 🔴 alta · 🟡 media · 🟢 baja. Se marca lo que esta rama resuelve.

## 🔴 Estado compartido solo en memoria
- `stream.ts` refcount de analytics: `Map` en memoria → se pierde al reiniciar el
  API y no sirve con múltiples workers. **Resuelto** con `StreamConsumerRegistry`
  (Redis + fallback memoria).
- `recordings.ts`: sesiones de preview/VOD en Maps de módulo (down­load tokens ya
  migrados a Redis vía `session-store`). Las sesiones que sostienen un FFmpeg son
  locales por naturaleza (necesitan sticky routing) — se documenta, no se fuerza.

## 🔴 Pipeline de analítica acoplado a YOLOX
- `pipeline.py` depende de `YoloxDetector` concreto. **Resuelto** con
  `DetectionProvider` + `YoloxOnnxProvider`; el worker usa la interfaz.

## 🟡 Monolitos grandes
- `apps/api/src/routes/recordings.ts` (~2000 líneas) y `services/hikvision.ts`
  (~2200) y `stream.ts` mezclan capas. Extracción parcial ya hecha
  (`recordings/rtsp-url.ts`, `credentials.ts`, `session-store.ts`). Resto: deuda
  documentada, refactor gradual con tests — no se toca en esta rama para no
  arriesgar regresión en flujos productivos.

## 🟡 Máquina de estados de Grabaciones implícita
- Los estados de reproducción viven en `status` de slot sin un tipo formal.
  Se documenta el conjunto formal en `docs/recordings/ARCHITECTURE.md` y se
  refuerza con tests de continuidad; el refactor del componente de 2000 líneas
  queda como deuda para evitar regresión.

## 🟡 Falta de métricas Prometheus
- Solo hay logs. **Resuelto** con `/metrics` (API) — expone consumidores,
  sesiones de preview y contadores de error.

## 🟡 Cobertura de tests desigual
- El servicio Python no tenía tests. **Resuelto parcialmente** con una suite
  pytest de pipeline/providers/reglas usando mocks (sin cv2/onnx reales).
- Falta cobertura de UI (Live/Recordings/Analytics) con testing-library — deuda
  documentada; se priorizan tests de lógica pura y de backend por mayor ROI.

## 🟢 Índices DB incompletos para Forense
- Faltan índices compuestos `className/zoneName/direction + occurredAt`.
  **Resuelto** con migración `0020`.

## 🟢 Delivery de notificaciones sin retry formal
- `NotificationDelivery` registra estado pero el reintento no es explícito.
  Se documenta la arquitectura (evento ≠ delivery) y se deja el retry como
  mejora acotada; no se cambia el pipeline SMTP productivo en esta rama.

## 🟢 Chunk del bundle web > 500 kB
- Vite avisa. Deuda: code-splitting por ruta. No crítico.

## Riesgos de regresión asumidos
- Los cambios de esta rama se concentran en: `stream.ts` (registry, con la misma
  semántica pública previa + wrappers de compatibilidad), `apps/analytics`
  (refactor a providers, con el mismo comportamiento observable), migración
  aditiva `0020` (solo índices), y adiciones nuevas (metrics, docs, tests).
  No se renombran ni eliminan columnas, rutas ni componentes existentes.
