# VisionCore VMS — Integración Hikvision ISAPI

## Autenticación

Todos los endpoints ISAPI utilizan **HTTP Digest Authentication**. VisionCore implementa el handshake completo en `apps/api/src/services/hikvision.ts`:

1. Primera request al NVR → responde `401` con `WWW-Authenticate: Digest realm=..., nonce=...`
2. VisionCore calcula el hash MD5 y reintenta con `Authorization: Digest username=..., response=...`

El interceptor de Axios maneja esto automáticamente en cada llamada. No se requiere preautenticación.

```bash
# Prueba manual desde terminal
curl -v --digest -u admin:Password http://192.168.1.10/ISAPI/System/deviceInfo
```

---

## Endpoints utilizados por VisionCore

### Información del dispositivo
```
GET /ISAPI/System/deviceInfo
```
Retorna: modelo, firmware, número de serie, versión de encoding/web, cantidad de canales, HDDs y MAC.

---

### Canales de video (NVR legacy / analógico)
```
GET /ISAPI/System/Video/inputs/channels
```
Lista canales de video locales/analógicos del NVR.

---

### Cámaras IP conectadas al NVR
```
GET /ISAPI/ContentMgmt/InputProxy/channels
```
Lista las cámaras IP gestionadas: IP, protocolo (HIKVISION, ONVIF, RTSP), estado (online/offline), nombre de canal, puerto de gestión (8000), estado de seguridad.

```
POST /ISAPI/ContentMgmt/InputProxy/channels        # Agregar cámara IP al NVR
PUT  /ISAPI/ContentMgmt/InputProxy/channels/{ch}   # Actualizar configuración de cámara IP
```

---

### Almacenamiento (HDDs)
```
GET /ISAPI/ContentMgmt/Storage
```
Estado de discos: capacidad total, espacio libre, porcentaje de uso, tipo (local, NAS), estado (Normal, Error, Uninitialized, Formatting).

---

### Usuarios del NVR
```
GET /ISAPI/Security/users
```
Lista usuarios configurados con nivel: `Administrator`, `Operator`, `User`.

---

### Encoding de video (información de stream)
```
GET /ISAPI/Streaming/channels/{canal}01   # Stream principal
GET /ISAPI/Streaming/channels/{canal}02   # Substream
```
Retorna codec (H.264/H.265), resolución, FPS y bitrate configurados para cada stream.

---

### PTZ — Control de cámara
```
PUT /ISAPI/PTZCtrl/channels/{canal}/continuous
```
Body: `{ PTZData: { pan: N, tilt: N, zoom: N } }` con valores entre -100 y 100.
Para detener: enviar `{ pan: 0, tilt: 0, zoom: 0 }`.

---

### Captura de imagen (snapshot)
```
GET /ISAPI/Streaming/channels/{canal}01/picture
```
Retorna imagen JPEG del frame actual. Requiere que el canal esté activo y la cámara online.

---

### Reinicio del dispositivo
```
PUT /ISAPI/System/reboot
```
El NVR se reinicia; la conexión puede cerrarse sin respuesta (comportamiento normal).

---

### Búsqueda de grabaciones
```
POST /ISAPI/ContentMgmt/search
```
Body XML con rango de fechas (`startTime`, `endTime`) y número de canal. Retorna lista de clips con timestamps y tamaño.

---

## Rutas RTSP de Hikvision

```
# Stream principal (main) — alta resolución
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/<canal>01

# Substream — resolución reducida, recomendado para web
rtsp://<usuario>:<contraseña>@<ip_nvr>:554/Streaming/Channels/<canal>02
```

Los números de canal son base-1. Canal 3 → `301` (main), `302` (sub). Canal 10 → `1001`, `1002`.

---

## NVRs configurados

| IP | Canales | Notas |
|---|---|---|
| 192.168.1.10 | 62 | NVR principal |
| 192.168.1.110 | 16 | NVR secundario A |
| 192.168.1.111 | 32 | NVR secundario B |
| 192.168.1.112 | 31 | NVR secundario C |

Puerto HTTP ISAPI: 80 (default). Puerto RTSP: 554. Puerto SDK: 8000.

---

## Errores comunes ISAPI

| Código / Error | Causa | Solución |
|---|---|---|
| HTTP 401 | Credenciales incorrectas o expiradas | Verificar usuario/contraseña en UI → NVRs → Editar |
| HTTP 403 | Usuario sin nivel suficiente | Usar usuario con nivel Operator o Administrator |
| HTTP 404 | Endpoint no soportado por el firmware | Actualizar firmware (requiere V4.x+) |
| Timeout / connection refused | NVR inaccesible o firewall en puerto 80 | `ping <ip>`, verificar rutas de red |
| XML parse error | Firmware antiguo con formato de respuesta diferente | Revisar versión; puede requerir adaptación del parser |

---

## Diagnóstico

```bash
# Verificar conectividad ISAPI y RTSP con todos los NVRs
bash scripts/check-nvrs.sh

# Probar RTSP de una cámara específica (main + sub)
bash scripts/probe-camera.sh 192.168.1.10 1 admin MiClave

# Llamadas ISAPI manuales
curl --digest -u admin:Pass http://192.168.1.10/ISAPI/System/deviceInfo
curl --digest -u admin:Pass http://192.168.1.10/ISAPI/ContentMgmt/InputProxy/channels
curl --digest -u admin:Pass http://192.168.1.10/ISAPI/ContentMgmt/Storage
```
