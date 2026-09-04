# VisionCore VMS — Sistema de Notificaciones y Alertas

## Arquitectura

```
healthWorker (background job)
  └─ Detecta: NVR offline, cámara offline, HDD lleno, error de auth
       └─ Crea Alert en DB (tabla alerts)
            └─ NotificationService (notification.service.ts)
                 ├─ Email (SMTP) → NotificationDelivery {status: sent/failed}
                 └─ WebSocket → broadcast a clientes conectados en tiempo real
```

---

## Modelos de base de datos

### `AlertSettings` (singleton — `id = "singleton"`)

Configuración global de notificaciones. Un solo registro compartido por toda la instalación.

| Campo | Tipo | Descripción |
|---|---|---|
| `emailEnabled` | Boolean | Habilita/deshabilita el envío de emails |
| `smtpHost` | String | Servidor SMTP |
| `smtpPort` | Int | Puerto SMTP (587 STARTTLS / 465 SSL directo) |
| `smtpSecure` | Boolean | `true` para SSL/TLS en puerto 465 |
| `smtpUser` | String | Usuario SMTP |
| `smtpPassword` | String | Contraseña SMTP |
| `smtpFromEmail` | String | Dirección del remitente |
| `smtpFromName` | String | Nombre visible (default: "VisionCore Alertas") |
| `recipientEmails` | String | Destinatarios separados por coma |
| `alertTypes` | Json | Tipos de alerta habilitados (ver abajo) |
| `minSeverity` | String | Severidad mínima: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |

### `NotificationDelivery`

Registro de cada intento de envío.

| Campo | Valores posibles |
|---|---|
| `channel` | `email`, `websocket`, `telegram`, `whatsapp` |
| `status` | `sent`, `failed`, `skipped`, `pending` |
| `error` | Mensaje de error si `status = failed` |
| `attempts` | Número de intentos realizados |

---

## Tipos de alerta

```json
{
  "CAMERA_OFFLINE":  true,
  "NVR_OFFLINE":     true,
  "HDD_FULL":        true,
  "HDD_ERROR":       true,
  "MOTION_DETECTED": false,
  "RECORDING_ERROR": true,
  "AUTH_FAILED":     false
}
```

Configurables individualmente desde la UI en **Configuración → Alertas**.

---

## Severidades

| Nivel | Color | Uso típico |
|---|---|---|
| `LOW` | Gris | Eventos informativos |
| `MEDIUM` | Amarillo | Advertencias no críticas |
| `HIGH` | Naranja | Cámara offline, NVR offline |
| `CRITICAL` | Rojo | Error de HDD, fallo de auth masivo |

---

## Configurar SMTP desde la UI

1. **Configuración → Alertas → Email**
2. Ingresar host, puerto, usuario y contraseña SMTP
3. Completar el campo "Destinatarios" (separados por coma)
4. Activar el switch "Email habilitado"
5. Presionar **"Enviar email de prueba"** para verificar

### Ejemplos de servidores SMTP

```
Gmail (App Password):   smtp.gmail.com  puerto 587  secure: false
Office 365:             smtp.office365.com  puerto 587  secure: false
SSL directo (port 465): smtp.ejemplo.com  puerto 465  secure: true
Relay interno sin auth: <smtp_relay_host>  puerto 25  secure: false
```

> Para Gmail con 2FA, generar una "Contraseña de aplicación" en la configuración de la cuenta Google.

---

## Endpoints de la API

```
GET  /api/alerts/settings                # Obtener configuración actual
PUT  /api/alerts/settings                # Actualizar configuración SMTP y tipos
POST /api/alerts/settings/test-email     # Enviar email de prueba
GET  /api/alerts/settings/deliveries     # Historial de notificaciones enviadas

GET  /api/alerts                         # Listar alertas (con filtros)
PUT  /api/alerts/:id/resolve             # Marcar alerta como resuelta
```

### Consultar historial de entregas

```bash
TOKEN=<jwt_token_admin>

# Últimas 20 entregas
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/alerts/settings/deliveries?limit=20"

# Solo las fallidas
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/alerts/settings/deliveries?status=failed"
```

---

## Script de diagnóstico SMTP

```bash
export VISIONCORE_TOKEN=<token_de_admin>

# Verificar configuración + enviar email de prueba
bash scripts/check-smtp.sh destinatario@ejemplo.com
```

El script realiza:
1. Obtiene la configuración SMTP actual vía `GET /api/alerts/settings`
2. Muestra problemas detectados: host vacío, sin destinatarios, email deshabilitado
3. Envía un email de prueba a la dirección indicada vía `POST /api/alerts/settings/test-email`
4. Lista las últimas 5 entregas registradas en la DB

---

## WebSocket — Alertas en tiempo real

El frontend se conecta a:
```
ws://servidor/ws/alerts    (HTTP)
wss://servidor/ws/alerts   (HTTPS)
```

El token JWT se valida al establecer la conexión. Si el token expira, el frontend reconecta automáticamente con uno nuevo. nginx debe tener `proxy_read_timeout 3600s` en el bloque `/ws/`.

---

## healthWorker — Lógica de detección

El worker de salud verifica periódicamente cada NVR y cámara:

1. **NVR offline:** `GET /ISAPI/System/deviceInfo` falla → crea alerta `NVR_OFFLINE` (HIGH)
2. **Cámara offline:** Estado en `InputProxy/channels` = offline → alerta `CAMERA_OFFLINE` (HIGH)
3. **HDD lleno:** Uso en `ContentMgmt/Storage` > 90% → alerta `HDD_FULL` (CRITICAL)
4. **HDD error:** Estado de disco = Error → alerta `HDD_ERROR` (CRITICAL)
5. **Auth fallida:** HTTP 401 repetido → alerta `AUTH_FAILED` (MEDIUM)

Al crear cada alerta, `NotificationService` evalúa si cumple los filtros de `AlertSettings` (tipo habilitado + severidad >= minSeverity) antes de intentar el envío.
