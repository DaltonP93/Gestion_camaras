# NOTIFICATIONS.md — Sistema de Notificaciones VisionCore

## Arquitectura

```
Health Worker (cada 60s)
  └─ Detecta evento (NVR offline, cámara offline, HDD lleno)
       ├─ Crea alerta en DB (tabla alerts)
       ├─ Broadcast WebSocket → navegador en tiempo real
       └─ sendAlertNotification() → NotificationService
            ├─ Verifica reglas (emailEnabled, minSeverity, alertTypes)
            ├─ Verifica duplicados (< 30 min)
            └─ EmailProvider → nodemailer → SMTP
                 └─ Registra resultado en NotificationDelivery
```

## Configuración SMTP (UI → Configuración → Alertas)

| Campo | Descripción |
|-------|-------------|
| Email habilitado | Activa/desactiva el envío automático |
| SMTP Host | Servidor de correo (ej: smtp.gmail.com) |
| Puerto SMTP | 587 (TLS), 465 (SSL), 25 (sin cifrado) |
| SMTP Seguro | TLS/SSL habilitado |
| Usuario / Contraseña | Credenciales SMTP |
| Email remitente | dirección From |
| Destinatarios | Emails separados por coma |
| Severidad mínima | Solo enviar alertas de severidad >= X |
| Tipos de alerta | Habilitar/deshabilitar por tipo |

## Tipos de alertas y severidades

| Tipo | Severidad | ¿Email por defecto? |
|------|-----------|---------------------|
| NVR_OFFLINE | HIGH | ✅ |
| CAMERA_OFFLINE | MEDIUM | ✅ |
| HDD_FULL (≥90%) | HIGH | ✅ |
| HDD_FULL (≥95%) | CRITICAL | ✅ |
| HDD_ERROR | HIGH | ✅ |
| RECORDING_ERROR | HIGH | ✅ |
| MOTION_DETECTED | LOW | ❌ (deshabilitado) |
| AUTH_FAILED | MEDIUM | ❌ (deshabilitado) |

## API de notificaciones

```http
# Obtener configuración SMTP
GET /api/alerts/settings
Authorization: Bearer <token>

# Actualizar configuración SMTP
PUT /api/alerts/settings
Authorization: Bearer <token>
Content-Type: application/json
{"emailEnabled": true, "smtpHost": "smtp.example.com", ...}

# Enviar email de prueba
POST /api/alerts/settings/test-email
Authorization: Bearer <token>
{"testEmail": "admin@ejemplo.com"}

# Historial de notificaciones enviadas
GET /api/alerts/settings/deliveries?page=0&limit=50
Authorization: Bearer <token>
```

## Tabla NotificationDelivery

```sql
SELECT * FROM notification_deliveries
ORDER BY created_at DESC LIMIT 20;
```

Campos: `id, alertId, channel, status (sent/failed/skipped/pending), recipient, error, attempts, sentAt, createdAt`

## Reglas de no-duplicado

No se envía email si:
- `emailEnabled = false`
- Severidad de la alerta < `minSeverity` configurado
- El tipo de alerta está deshabilitado en `alertTypes`
- Ya existe un `NotificationDelivery` con `status = sent` para la misma alerta en los últimos 30 minutos

## Verificar sistema de notificaciones

```bash
# Verificar configuración SMTP y enviar email de prueba
bash scripts/check-smtp.sh admin@ejemplo.com

# Ver últimas notificaciones en DB
docker compose exec postgres psql -U visioncore -c \
  "SELECT channel, status, recipient, error, created_at FROM notification_deliveries ORDER BY created_at DESC LIMIT 10;"

# Ver logs del worker (incluye errores de email)
docker compose logs -f api | grep -i "email\|notification\|health"
```

## Extender con otros canales (futuro)

El diseño permite agregar canales sin modificar el healthWorker:

```typescript
// apps/api/src/services/notification.service.ts
// Agregar después de sendAlertEmail():
await sendTelegramAlert(prisma, alert)   // futuro
await sendWhatsAppAlert(prisma, alert)   // futuro
```

Canales preparados (no implementados): WhatsApp, Telegram, SMS, webhook.
