# VisionCore: experiencia de video, Frigate y clientes instalables

Estado: continuidad y proveedor NVR propuestos en entregas separadas para revisión,
**sin despliegue**. La corrección de dependencias del API es una base independiente.
Base inspeccionada: `94305f32ddba17b697b8f28b5fe3ef5108b0bc2c` (2026-10-06).
El PR #180 de alta calidad automática en 1×1 permanece separado.

## Objetivo acordado

Una experiencia integrada en VisionCore: vivo, grabaciones, eventos y configuración
con mejoras procedentes de Frigate, conservando login, permisos por cámara, usuarios,
roles, agrupación/alta de NVR y visores multicámara de VisionCore.

Todo vivo y archivo histórico se obtiene de los **NVR**. No se exige acceso directo
a cámaras. El archivo completo permanece en los NVR. El servidor conserva eventos
configurados y, cuando la política del evento lo requiera, sus snapshots/clips
extraídos del NVR. Un buffer temporal de reproducción no es un segundo archivo
permanente; cualquier caché futura necesita límite de tamaño y TTL explícitos.

## Arquitectura propuesta

| Responsabilidad | Implementación / evolución |
|---|---|
| Identidad y autorización | API de VisionCore; comprobar permisos en búsqueda, stream, eventos, imágenes y exportaciones |
| Vivo | Canales RTSP de NVR → relay autenticado → cliente; mantener main/sub y límites por espectador |
| Archivo | Búsqueda ISAPI y playback RTSP del NVR; adaptador que preserve intervalos, huecos, zona horaria y cancelación |
| Eventos | Detección configurada sobre substream del NVR; retener evidencia seleccionada, deduplicar detectores |
| Interfaz | Adaptar componentes de Frigate contra el contrato de medios de VisionCore; registrar procedencia y cambios |
| Cliente instalado | Reutilizar `apps/native`; web compartida y adaptadores de decodificación donde las mediciones los justifiquen |

El contrato del adaptador debe separar búsqueda/disponibilidad, apertura/cola,
adjuntar medio, primer fotograma, seek, cierre y exportación. Cada resultado conserva
la identidad de sesión y generación. Una respuesta antigua no puede reemplazar ni
cerrar la sesión nueva. La prioridad entre bloques no puede liberar capacidad antes
de que FFmpeg salga.

Frigate no es un adaptador automático del archivo propietario de un NVR: su
experiencia de historial depende de sus propios índices/segmentos. Reutilizar su
interfaz exige mapear esas operaciones al proveedor NVR. Copiar toda su aplicación
y apuntarla a las grabaciones existentes no resuelve ese contrato.

## Frigate como fuente versionada

Referencia inicial para evaluar componentes: **v0.18.0**, commit
`77a66e75c61862b048a07c1295877f4b31343504`, consultado el 2026-10-06.

- [Release](https://github.com/blakeblackshear/frigate/releases/tag/v0.18.0).
- [Licencia MIT](https://github.com/blakeblackshear/frigate/blob/77a66e75c61862b048a07c1295877f4b31343504/LICENSE).
- [Dependencias web](https://github.com/blakeblackshear/frigate/blob/77a66e75c61862b048a07c1295877f4b31343504/web/package.json).

Esta primera entrega **no copia código de Frigate ni lo activa**. Antes de importar
un componente, inventariar sus dependencias/transitivos, conservar copyright y
licencia en los archivos/avisos distribuidos, y registrar SHA original y modificaciones.
La marca y los servicios/modelos externos se evalúan por separado. La referencia
usa React 19/Vite 6; VisionCore usa React 18/Vite 5. El port debe decidir compatibilidad
por componente, sin reemplazar el lockfile entero.

La integración existente en `apps/analytics/app/frigate/` y `docs/frigate/` sirve
como punto de partida para eventos, no demuestra integración del reproductor.
Una futura activación mantiene flags OFF por defecto y requiere validación propia.

## Entregas y criterios de aceptación

1. **Continuidad y banco de reproducción (esta entrega).** Corregir el cierre
   prematuro del predecesor y evitar que el timer salte un bloque mientras espera
   video. Prueba de página real en Chromium con tres bloques, cola, 403, respuesta
   tardía, pausa, velocidad y hueco; registrar frames presentados. No cambia API,
   capacidad por NVR, autenticación, almacenamiento ni contenedores.
2. **Proveedor NVR y medición de campo.** Contrato tipado separado de la página
   implementado en la segunda entrega (ver detalle debajo); medición de campo pendiente:
   medir clic→primer frame, último frame→primer frame siguiente, tiempo en cola,
   buffering, CPU/RAM y frames descartados. Probar 1 cámara y multicámara en un
   NVR y en dos NVR, con clientes/codec identificados. Definir objetivos sobre esa
   línea base; no convertir primer byte o una descarga HTTP en éxito visual.
   Las pruebas que abren sesiones reales necesitan una ventana autorizada.
3. **Interfaz integrada.** Portar primero navegación/timeline y controles que
   funcionen con el contrato NVR. Luego vivo, revisión de eventos y configuración.
   Contrastar permisos denegados, revocación, exportación, tablet/táctil y accesibilidad.
   Registrar componentes reutilizados y conservar las atribuciones.
4. **Evidencia por evento.** Reglas explícitas de cámaras/horarios/zona/detector,
   pre/post evento, retención/cuota y reintentos acotados. Prueba de evidencia
   recuperada del NVR, hueco/no disponible mostrado con honestidad y borrado según
   retención. No duplicar toda la grabación ni activar todas las cámaras a la vez.
5. **Instaladores.** Ya existe base Tauri + shared-core en `apps/native`, pero sus
   documentos no acreditan instaladores publicados ni decodificación real. Primero
   cerrar relay autenticado, luego probar un cliente Windows; seguir con Android/iPad
   según dispositivos reales. Firma, actualizaciones y almacenamiento seguro forman
   parte de la entrega. Empaquetar la web no acelera por sí solo NVR/red/FFmpeg:
   comparar reproducción web y nativa en el mismo equipo y archivo antes de afirmar
   una mejora.

## Evidencia y límites de esta primera entrega

- Los dos casos de regresión fallan contra la página de `94305f3`: el sucesor ve
  el predecesor ya cerrado y, reteniendo los datos 6 s, el timer abre el siguiente
  bloque de 4 s sin haber reproducido el primero.
- El harness usa fMP4 **VP9 sintético** de 4 s y API simulada; la decodificación,
  los eventos de medio y `requestVideoFrameCallback` son reales. VP9 evita depender
  de soporte H.264 propietario en el Chromium de CI. No modifica el códec de producción.
- No prueba NVR, FFmpeg, capacidad física, audio, H.264/H.265, GPU, Safari, tablet,
  instalador ni latencia de red real. El JSON de frames se adjunta al reporte CI.
- Sigue pendiente medir/sincronizar el reloj global durante buffering multicámara;
  esta corrección evita el salto por timeout, no reemplaza el reloj compartido.
- Merge, despliegue, cambios operativos y activación de funciones se revisan por
  separado. Ninguna etapa justifica exponer credenciales de NVR al cliente.

## Segunda entrega: frontera del proveedor NVR

`apps/web/src/services/recordings/nvrRecordingProvider.ts` concentra las llamadas
de `RecordingsPage`: búsqueda por cámara/rango, comprobación de capacidades,
apertura/estado/cierre de preview y apertura/estado/cierre de MP4. Usa el cliente
autenticado de VisionCore; conserva cookies HttpOnly, refresh y errores HTTP.
No conecta el navegador al RTSP del NVR ni incorpora endpoints de Frigate.

El contrato declara el archivo de origen NVR y conserva sin reinterpretar las
fechas ya convertidas por la UI, los huecos, la URI opaca de reproducción, la cola
y el identificador del predecesor. `ready` sólo indica disponibilidad de URL;
`hadFirstByte` sólo indica llegada al servidor. Ninguno representa un fotograma
decodificado. La UI sigue controlando generaciones, polling, medio y cancelación;
el API sigue controlando permisos, admisión y salida real de FFmpeg.

Las pruebas de contrato usan el cliente HTTP real con un adaptador de red simulado:
cookies activas, fechas/huecos intactos, sucesor en cola sin cierres implícitos,
errores 403/404/410/429/503 y Retry-After conservados, exportación separada de preview,
cierre fallido sin éxito falso e identificadores confinados a su segmento de URL.
El banco Chromium de la primera entrega comprueba que el refactor conserva el
relevo, las generaciones y la reproducción de video sintético.

No se incorpora caché, retención, detector, cambio visual, código de Frigate ni
instalador en este tramo. El siguiente port de interfaz utilizará esta frontera.
La prueba en equipos reales y el reloj global multicámara siguen pendientes.
