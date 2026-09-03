# VisionCore VMS — Seguridad

## Almacenamiento de contraseñas

### Contraseñas de usuarios del sistema
Las contraseñas de los usuarios de VisionCore se almacenan como **hash bcrypt** en el campo `passwordHash` de la tabla `users`. Nunca se almacena ni transmite la contraseña en texto plano.

### Contraseñas de NVRs Hikvision
Las credenciales de los NVRs se cifran con **AES (crypto-js)** antes de guardarse en la columna `password` de la tabla `nvrs`:

```typescript
// Cifrado al guardar el NVR
CryptoJS.AES.encrypt(plainPassword, ENCRYPTION_KEY).toString()

// Descifrado al construir la URL RTSP o llamar ISAPI
CryptoJS.AES.decrypt(encryptedPassword, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)
```

La clave de cifrado proviene de `NVR_CREDENTIAL_KEY`. Si no está definida, se usa `JWT_SECRET` como fallback.

> **IMPORTANTE:** Si `NVR_CREDENTIAL_KEY` cambia en una instalación existente, las contraseñas cifradas quedan ilegibles. Deben re-ingresarse manualmente desde la UI.

---

## Autenticación JWT

VisionCore usa **Bearer Tokens JWT** almacenados en `localStorage` del navegador.

| Parámetro | Valor por defecto | Variable |
|---|---|---|
| Algoritmo | HS256 | — |
| Expiración access token | 60 minutos | `JWT_EXPIRES_IN` |
| Expiración refresh token | 7 días | `JWT_REFRESH_EXPIRES_IN` |
| Clave de firma | — | `JWT_SECRET` (mín. 32 chars) |

Los refresh tokens se almacenan en la tabla `sessions` con IP, User-Agent y fecha de expiración. Al hacer logout se elimina la sesión de la DB, invalidando el refresh token.

```bash
# Generar claves seguras
openssl rand -hex 64   # JWT_SECRET
openssl rand -hex 32   # NVR_CREDENTIAL_KEY
```

---

## Enmascaramiento de URLs RTSP

Las URLs RTSP contienen usuario y contraseña del NVR. VisionCore garantiza que **nunca se expongan** en:
- Respuestas JSON de la API al frontend
- Logs de la aplicación
- Registros de auditoría
- Salida de scripts de diagnóstico

```
# Salida enmascarada en probe-camera.sh y logs:
rtsp://admin:***@192.168.1.10:554/Streaming/Channels/101
```

---

## Control de acceso por roles (RBAC)

Cuatro roles con permisos incrementales definidos en `schema.prisma`:

| Rol | Ver cámaras | Grabaciones | PTZ | Usuarios | Config. sistema |
|---|---|---|---|---|---|
| `AUDITOR` | Solo asignadas | Solo asignadas | No | No | No |
| `OPERATOR` | Solo asignadas | No | Si (si habilitado) | No | No |
| `SUPERVISOR` | Todas | Todas | Si | No | Lectura |
| `ADMIN` | Todas | Todas | Si | Si | Total |

### Permisos granulares por recurso

La tabla `user_permissions` permite control fino independiente del rol:

```
canView     — ver stream en vivo de una cámara o NVR específico
canPlayback — acceder a grabaciones
canPtz      — controlar PTZ
```

Un `OPERATOR` solo puede ver las cámaras o NVRs a los que tenga `canView = true` asignado explícitamente.

---

## Log de auditoría

Todas las acciones relevantes se registran en la tabla `audit_logs`:

| Campo | Descripción |
|---|---|
| `userId` | Quién realizó la acción (`null` si es el sistema) |
| `action` | Qué acción (LOGIN, LOGOUT, NVR_EDIT, CAMERA_VIEW, USER_CREATE...) |
| `resource` | ID del recurso afectado (NVR, cámara, usuario) |
| `detail` | JSON con detalles adicionales (campos modificados, etc.) |
| `ipAddress` | IP del cliente |
| `userAgent` | Navegador/cliente |
| `createdAt` | Timestamp UTC |

```bash
# Consultar audit log (requiere rol ADMIN)
curl -H "Authorization: Bearer <token>" \
  "http://localhost/api/audit?limit=50&action=LOGIN"
```

---

## HTTPS y cookies seguras

### Activar HTTPS

```bash
# 1. Obtener certificado Let's Encrypt
bash infra/certbot/init-ssl.sh

# 2. Actualizar nginx a HTTPS (reemplaza nginx.conf)
bash infra/certbot/upgrade-to-https.sh

# 3. Recargar nginx
docker compose exec nginx nginx -s reload

# 4. Activar flag de cookie segura en .env
COOKIE_SECURE=true
docker compose restart api
```

> Si `COOKIE_SECURE=true` con el sitio en HTTP, las cookies de sesión no se envían y el login falla. Establecer `true` **solo después** de que HTTPS esté activo.

### Cabeceras de seguridad recomendadas para producción

Agregar en el bloque `server` de `nginx.conf`:
```nginx
add_header X-Frame-Options "SAMEORIGIN";
add_header X-Content-Type-Options "nosniff";
add_header Referrer-Policy "strict-origin-when-cross-origin";
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

---

## CORS

Controlado en la API Fastify mediante `CORS_ORIGINS` en `.env`:

```env
# Origen único
CORS_ORIGINS=https://camaras.saa.com.py

# Múltiples orígenes (coma-separados)
CORS_ORIGINS=https://camaras.saa.com.py,https://admin.saa.com.py

# Vacío = permite cualquier origen (SOLO en desarrollo)
CORS_ORIGINS=
```

---

## MediaMTX — Acceso a streams

MediaMTX está configurado sin autenticación propia (`authInternalUsers: any`).
El API controla quién puede crear una sesión y a quién entrega el `streamPath`,
pero la petición HLS posterior no vuelve a validar el JWT. Por eso la red y el
firewall siguen siendo parte de la frontera de seguridad; un path no debe
tratarse como una credencial fuerte:

- El frontend obtiene las URLs HLS/WebRTC **solo tras autenticarse** con JWT válido
- Las URLs expuestas al frontend contienen el `streamPath` pero **no las credenciales del NVR**
- nginx expone `/hls/` al exterior pero no la API de administración de MediaMTX (puerto 9997)

> En producción, no exponer el puerto 9997 de MediaMTX en el firewall del servidor.

Los puertos de medios 8554/8888/8889 tampoco constituyen una API pública para
clientes nativos mientras MediaMTX acepte `user: any`. Deben quedar limitados a
la red confiable/firewall. El futuro cliente Windows/Android/iOS sólo podrá usar
HEVC directo después de incorporar autorización por path y grants efímeros; no
recibirá credenciales ni URLs RTSP del NVR. Ver
`docs/native/LIVE_CLIENT_ARCHITECTURE.md`.
