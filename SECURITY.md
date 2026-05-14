# SECURITY.md — Seguridad VisionCore VMS

## Principios aplicados

1. **Sin contraseñas en texto plano** — NVR passwords encriptados con AES en DB
2. **Sin contraseñas en logs** — URLs RTSP siempre con `***` en lugar de contraseña
3. **Sin contraseñas en API** — El campo `password` nunca se retorna en respuestas
4. **JWT Bearer auth** — Token en localStorage, refresh automático
5. **Roles de acceso** — 4 niveles con permisos diferenciados
6. **Auditoría** — Toda acción crítica queda registrada

## Encriptación de credenciales NVR

```typescript
// Variable de entorno (apps/api/.env)
NVR_CREDENTIAL_KEY=clave_secreta_muy_larga_y_aleatoria

// Al guardar NVR
const encrypted = CryptoJS.AES.encrypt(password, ENCRYPTION_KEY).toString()

// Al usar NVR (dentro del API, nunca expuesto al frontend)
const plain = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)
```

**IMPORTANTE:** Rotar `NVR_CREDENTIAL_KEY` requiere re-ingresar todas las contraseñas de NVRs.

## URLs RTSP enmascaradas

Nunca exponer la contraseña del NVR en logs, respuestas de API o UI:
```
❌ rtsp://admin:MiClave123@192.168.1.10:554/Streaming/Channels/101
✅ rtsp://admin:***@192.168.1.10:554/Streaming/Channels/101
```

La función `buildRtspUrlMasked()` en `hikvision.ts` siempre retorna la URL con `***`.

## Roles del sistema

| Rol | Acceso |
|-----|--------|
| ADMIN | Todo: NVRs, usuarios, configuración, auditoría |
| SUPERVISOR | Ver todo, grabaciones, sincronizar NVR, diagnóstico |
| OPERATOR | Solo cámaras asignadas, live view |
| AUDITOR | Solo grabaciones asignadas |

Las rutas críticas verifican rol en `preHandler`:
```typescript
server.post('/nvrs/:id/reboot', { preHandler: [server.authorize(['ADMIN'])] }, ...)
server.post('/nvrs/:id/sync',   { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, ...)
```

## Permisos granulares por cámara

Para usuarios OPERATOR/AUDITOR, acceso definido en tabla `user_permissions`:
```sql
-- Ver qué cámaras puede ver un usuario
SELECT camera_id, can_view, can_playback, can_ptz
FROM user_permissions
WHERE user_id = '...';
```

## Auditoría

Toda acción crítica se registra en tabla `audit_logs`:
- Usuario que realizó la acción
- IP de origen
- Acción (`NVR_CREATED`, `NVR_DELETED`, `PTZ_COMMAND`, `LOGIN`, etc.)
- Recurso afectado (ID del NVR/cámara)
- Timestamp

**Lo que NO se guarda en auditoría:** contraseñas, tokens JWT, RTSP completo.

## Variables de entorno sensibles (.env)

```bash
# Rotar periódicamente
JWT_SECRET=secret_muy_largo_aleatorio
NVR_CREDENTIAL_KEY=otra_clave_larga_aleatoria

# No exponer en logs de Docker
DATABASE_URL=postgresql://visioncore:PASS@postgres:5432/visioncore
```

## HTTPS

Activar HTTPS después de obtener certificado SSL:
```bash
# Obtener certificado (primera vez)
bash infra/certbot/init-ssl.sh camaras.ejemplo.com admin@ejemplo.com

# Activar HTTPS en nginx
bash infra/certbot/upgrade-to-https.sh
```

El sistema funciona en HTTP hasta activar HTTPS. En producción, HTTPS es obligatorio.

## Endpoints que requieren ADMIN

- `DELETE /api/nvrs/:id` — eliminar NVR
- `POST /api/nvrs/:id/reboot` — reiniciar NVR
- `POST /api/nvrs/:id/cameras/adopt` — adoptar cámara
- `POST /api/users` — crear usuario
- `PUT /api/alerts/settings` — cambiar SMTP
- `DELETE /api/cameras/:id` — eliminar cámara

## Recomendaciones operativas

1. Cambiar contraseña por defecto del usuario `admin` de VisionCore
2. Usar contraseñas fuertes en los NVRs Hikvision
3. Mantener NVRs en VLAN separada, solo accesibles desde el servidor VisionCore
4. Revisar `audit_logs` periódicamente desde la UI (Actividad)
5. Rotar `JWT_SECRET` y `NVR_CREDENTIAL_KEY` periódicamente
6. No exponer el puerto 9997 (MediaMTX API) a redes externas
