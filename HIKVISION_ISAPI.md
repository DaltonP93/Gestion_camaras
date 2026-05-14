# HIKVISION_ISAPI.md — Integración con API ISAPI de Hikvision

## Autenticación

VisionCore usa **HTTP Digest Authentication** para conectarse a NVRs Hikvision. Las credenciales del NVR se almacenan **encriptadas** en PostgreSQL con AES.

```typescript
// La contraseña del NVR se encripta al guardar
const encrypted = CryptoJS.AES.encrypt(password, ENCRYPTION_KEY).toString()

// Y se desencripta antes de usar
const plain = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)
```

## Endpoints ISAPI utilizados

### Información del dispositivo
```
GET /ISAPI/System/deviceInfo
```
Retorna: modelo, serie, firmware, versión de codificación, web, canales, HDDs.

### Lista de cámaras IP conectadas al NVR
```
GET /ISAPI/ContentMgmt/InputProxy/channels
```
Retorna: canal, nombre real, IP de cámara, puerto de gestión, protocolo, estado de seguridad, estado online.

### Almacenamiento (HDDs)
```
GET /ISAPI/ContentMgmt/Storage
```
Retorna: número de disco, capacidad, espacio libre, porcentaje usado, estado, tipo, propiedad.

### Usuarios configurados en el NVR
```
GET /ISAPI/Security/users
```
Retorna: nombre de usuario, rol, permisos.

### Estado del dispositivo
```
GET /ISAPI/System/status
```
Retorna: uso de CPU, uso de HDD, temperatura.

### Reiniciar dispositivo
```
PUT /ISAPI/System/reboot
```

### Adoptar cámara IP
```
POST /ISAPI/ContentMgmt/InputProxy/channels
PUT  /ISAPI/ContentMgmt/InputProxy/channels/{id}
```

### Configuración de codificación de video
```
GET /ISAPI/Streaming/channels/{ch}01  # Main stream config
GET /ISAPI/Streaming/channels/{ch}02  # Sub stream config
```

### PTZ
```
PUT /ISAPI/PTZCtrl/channels/{ch}/continuous
```

### Snapshot
```
GET /ISAPI/Streaming/channels/{ch}01/picture
```

### Búsqueda de grabaciones
```
POST /ISAPI/ContentMgmt/search
```

## RTSP paths

```
Main stream: rtsp://USER:PASS@IP:554/Streaming/Channels/{channel}01
Sub stream:  rtsp://USER:PASS@IP:554/Streaming/Channels/{channel}02
Grabación:   rtsp://USER:PASS@IP:554/Streaming/tracks/{ch}00?starttime=...&endtime=...
```

Donde `{channel}` es el número de canal con padding (ej: canal 1 → `101`, canal 10 → `1001`).

## Respuestas XML/JSON

Los NVRs Hikvision responden en **XML** (más común) o **JSON** según el modelo y versión de firmware.

VisionCore intenta JSON primero y hace fallback a XML:
```typescript
// Parser XML helpers en hikvision.ts
function xmlGet(xml: string, tag: string): string | undefined
function xmlGetAll(xml: string, tag: string): string[]
```

## Errores frecuentes

| Error HTTP | Causa | Solución |
|-----------|-------|----------|
| 401 Unauthorized | Credenciales incorrectas | Verificar usuario/contraseña en la UI del NVR |
| 403 Forbidden | Usuario sin permisos | El usuario debe tener permisos de administración en el NVR |
| 404 Not Found | Endpoint no disponible en ese modelo | Verificar firmware/modelo. Algunos modelos más viejos no soportan ISAPI completa |
| 406 Not Acceptable | Formato de respuesta incompatible | El NVR puede necesitar header `Accept: application/xml` |
| ECONNREFUSED | Puerto HTTP cerrado o firewall | Verificar: `nc -vz 192.168.1.10 80` |
| ETIMEDOUT | NVR no alcanzable en la red | Verificar conectividad entre contenedor Docker y la red de los NVRs |

## NVRs reales del entorno

| NVR | IP | Modelo | Canales | Puerto HTTP | Puerto RTSP |
|-----|-----|--------|---------|------------|-------------|
| SAA Nueva Torre | 192.168.1.10 | DS-9664NI-I8 | 62 | 80 | 554 |
| Torre Vieja | 192.168.1.112 | DS-7732NI-K4 | 31 | 80 | 554 |
| UTI | 192.168.1.110 | DS-7616NI-K2/16P | 16 | 80 | 554 |
| SAA 2023 | 192.168.1.111 | DS-7732NI-K4 | 32 | 80 | 554 |

## Sincronización completa (POST /api/nvrs/:id/sync)

El endpoint `/sync` hace:
1. `getNVRStatus()` — actualiza online/firmware/lastSeen
2. `getDeviceInfo()` — actualiza encodingVersion/webVersion
3. `getIpCameraList()` — upsert cámaras con nombres reales (por `nvrId + channel`)
4. `getStorageInfo()` — upsert HDDs en tabla `nvr_hdds`
5. `publishAllStreams()` — registra todas las rutas en MediaMTX

No duplica cámaras: la clave única es `(nvrId, channel)`.
