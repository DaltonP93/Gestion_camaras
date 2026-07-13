# Analítica — Eventos y reglas

## Tipos de evento

| Evento (worker) | AlertType | Cómo se dispara | Alerta por defecto |
|---|---|---|---|
| `person` | PERSON_DETECTED | track nuevo clase person | sí (LOW) |
| `vehicle` | VEHICLE_DETECTED | track nuevo clase car/truck/bus/moto/bici | sí (LOW) |
| `zone_intrusion` | ZONE_INTRUSION | objeto de clase vigilada dentro de una zona | sí (HIGH) + email |
| `line_crossing` | LINE_CROSSING | cruce de línea (in/out) | no (solo conteo) |
| `loitering` | LOITERING | track en zona ≥ `loiteringSec` | sí (HIGH) + email |
| `occupancy_limit` | OCCUPANCY_LIMIT | objetos en zona > `occupancyLimit` | sí (HIGH) + email |

> Señal perdida / tampering / obstrucción están previstos como evolución
> (no implementados en esta fase).

## Antifloods (una alerta ≠ un frame)

Implementado en `rules.py` + pipeline:
- **Deduplicación por tracker id**: un objeto nuevo se reporta una sola vez.
- **Cooldown por tipo/clase/zona**: configurable (`cooldownByEvent`,
  `cooldownSec`), evita repetir el mismo evento en el intervalo.
- **Horario (`schedule`)**: los eventos solo se emiten dentro de la ventana
  (soporta cruce de medianoche); el conteo de líneas sigue acumulando siempre.
- **Confianza por clase** (`confidenceByClass`) además del umbral global.

## Configuración por cámara (`CameraAnalyticsConfig`)

`enabled, classes, confidenceByClass, sampleFps, maximumProcessingWidth,
cooldownSec, alertConfig{[evento]:{generateAlert,sendEmail,severity,cooldownSec}},
zones[{name,points,classes,loiteringSec,occupancyLimit}],
lines[{name,start,end,classes}], schedule`.

## Persistencia (`AnalyticsEvent`)

`cameraId, nvrId (via cámara), type, className, confidence, trackId, zoneName,
direction, bboxes, snapshotUrl, alertId, occurredAt`. Índices para forense:
`(cameraId|type|className|zoneName|direction, occurredAt)` (migración 0020).

## Alertas y notificaciones

- La **alerta** (campana/WS) y el **delivery** (email) son entidades separadas
  (`Alert`, `NotificationDelivery`): si el email falla, el evento y la alerta no
  se pierden.
- El envío de email no bloquea al worker (fire-and-forget en el API).
- Respeta severidad y la configuración global de Alertas (SMTP, severidad mínima).
- Arquitectura preparada para canales futuros (WhatsApp/Telegram/SMS) sin
  integraciones concretas en esta fase.

## Métricas relacionadas (`/metrics`)

`visioncore_analytics_events_total{type}`,
`visioncore_analytics_events_rejected_total{reason}`,
`visioncore_analytics_alerts_created_total{type}`,
`visioncore_analytics_workers{status}`, `visioncore_mediamtx_consumers{type}`.
