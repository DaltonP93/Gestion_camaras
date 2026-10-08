# Prototipo navegable — experiencia VisionCore con la organización de Frigate

**Sólo datos simulados.** No hay login, ni peticiones de red, ni video: el prototipo no puede
contactar la API, PostgreSQL, Redis, MediaMTX, NVR ni cámaras (no tiene proxy ni cliente HTTP).
Sirve para revisar la experiencia **antes** de implementar la integración (propuesta en
`docs/frigate/NATIVE_INTEGRATION_PROPOSAL.md`, rama `docs/frigate-native-plan`, PR #185).

```bash
cd apps/web
npm run prototype            # http://localhost:5198
npm run prototype:build      # estático en dist-prototype/ (abrir dist-prototype/index.html)
npm run typecheck:prototype
npx vitest run prototype     # lógica (permisos, visores, pistas, admisión, reloj)
npm run test:e2e:prototype   # navegador: PC 1440×900, tablet 1180×820 y 820×1180 (táctil)
```

No forma parte del build de producción (`vite.config.ts` no lo incluye) ni de la imagen.

## Qué se puede revisar

| Pantalla | Qué muestra | Reglas aplicadas (mismas que la API actual) |
|---|---|---|
| **Vivo** | Visores personales, compartidos y "de otros usuarios" (sólo ADMIN); crear, editar celdas y diseño, compartir (público o usuarios), borrar; ampliar 1×1; PTZ | Crear/editar/borrar: ADMIN y SUPERVISOR (SUPERVISOR sólo los propios). Ver: ADMIN todos; el resto públicos, propios o con acceso. Una celda con una cámara no permitida queda bloqueada y no pide video. HD al ampliar sólo con `canHighQuality`. PTZ sólo con cámara PTZ y `canPtz`. |
| **Grabaciones** | Reproducción multicámara con reloj común: reproducir/pausa, ±10 s, 0.5×–4×, deslizador, timeline por cámara con pista principal/subflujo/huecos, "esperar a todas las celdas" | OPERATOR sin acceso; AUDITOR sólo cámaras con `canPlayback`. **No asume subflujo grabado**: cada celda usa una pista archivada en el instante del reloj; huecos visibles con "ir al próximo tramo"; sesiones por NVR hasta su límite y el resto **en cola con posición**. |
| **Eventos** | Lista filtrable, retención del clip | OPERATOR sin acceso; quien no es ADMIN sólo ve cámaras con `canView` explícito (hoy también SUPERVISOR: inconsistencia a decidir). |
| **Configuración** | Grupos Sistema · Dispositivos · Acceso · Notificaciones · Vivo · Análisis; formulario por sección con "cambios sin guardar · Guardar · Deshacer"; sólo lectura según rol; fuente de datos real de cada sección | Tabla sección × rol en `model/permissions.ts`, derivada de los `authorize([...])` de la API. |

La persistencia de visores usa `localStorage` para **simular** `/api/views`; en la integración
real los visores siguen en PostgreSQL (`CameraView`/`CameraViewAccess`) y la última selección
pasa a ser una preferencia del usuario en el servidor.

## Qué NO prueba

- Rendimiento, latencia, decodificación ni sesiones reales: eso es la parte **M** de
  `docs/frigate/PLAYER_TEST_PLAN.md` (pendiente de hardware y NVR reales).
- La carga ("cargando") es un tiempo simulado determinista, no el primer frame real.
- Guardar en Configuración sólo afecta a la pestaña abierta.
