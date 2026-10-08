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
npx vitest run prototype     # lógica (permisos, visores, pistas, admisión, reloj, sincronía por celda, timeline, marcas de backend y sus endpoints)
npm run test:e2e:prototype   # navegador: PC 1440×900, tablet 1180×820 y 820×1180 (táctil)
```

No forma parte del build de producción (`vite.config.ts` no lo incluye) ni de la imagen.

## Qué se puede revisar

| Pantalla | Qué muestra | Reglas aplicadas (mismas que la API actual) |
|---|---|---|
| **Vivo** | Visores personales, compartidos y "de otros usuarios" (sólo ADMIN); crear, editar celdas y diseño, compartir (público o usuarios), borrar; ampliar 1×1; PTZ. Cada celda es un cuadro 16:9 | Crear/editar/borrar: ADMIN y SUPERVISOR (SUPERVISOR sólo los propios). Ver: ADMIN todos; el resto públicos, propios o con acceso. Una celda con una cámara no permitida queda bloqueada y no pide video. HD al ampliar sólo con `canHighQuality`. PTZ sólo con cámara PTZ y `canPtz`. |
| **Grabaciones** | Reproducción multicámara con reloj común sobre el día simulado completo (00:00–24:00): reproducir/pausa, ±10 s, 0.5×–4×, timeline con horas, zoom y huecos por cámara (tocar busca), deslizador del día, sincronía por celda con desfase y "Resincronizar", "Esperar a todas" opcional | OPERATOR sin acceso; AUDITOR sólo cámaras con `canPlayback`. **No asume subflujo grabado**: cada celda usa una pista archivada en el instante del reloj; huecos visibles con "ir al próximo tramo"; sesiones por NVR hasta su límite y el resto **en cola con posición**. |
| **Eventos** | Lista filtrable, retención del clip; marca de backend (`GET /api/analytics/events`, retención simulada) | OPERATOR sin acceso; quien no es ADMIN sólo ve cámaras con `canView` explícito (hoy también SUPERVISOR: inconsistencia a decidir). |
| **Configuración** | Grupos Sistema · Dispositivos · Acceso · Notificaciones · Vivo · Análisis; formulario por sección con "cambios sin guardar · Guardar · Deshacer"; sólo lectura según rol; fuente de datos real y **marca de backend** de cada sección y control | Tabla sección × rol en `model/permissions.ts`, derivada de los `authorize([...])` de la API. |
| **Zonas y máscaras** | Editor de polígonos de Frigate sobre React 18: dibujar con clic o toque, cerrar en el primer punto, arrastrar vértices, deshacer, reiniciar, reescalar al rotar la tablet; guarda en coordenadas 0–1 (formato de `CameraAnalyticsConfig.zones`) | ADMIN y SUPERVISOR editan (`PUT /api/analytics/config/:cameraId`); OPERATOR y AUDITOR no ven la sección. |

## Ajustes sobre las capturas (revisión del PR #188)

- **Tablet vertical**: el selector lateral (visores en Vivo, cámaras en Grabaciones, secciones en
  Configuración) se pliega detrás de un botón "Mostrar/Ocultar" (`aria-expanded`, Escape lo cierra),
  **plegado por defecto**; en PC y tablet horizontal (≥ 1024 px) sigue visible a la izquierda.
  Elegir un visor o una sección lo vuelve a plegar.
- **Proporción del video**: cada celda de video es un cuadro **16:9** (`aspect-ratio`), en vivo y en
  grabaciones; los textos y botones van superpuestos y no le quitan alto. En celdas **compactas**
  (menos de 300 px: 3×3 en PC, 2×2 y 3×3 en tablet horizontal, 3×3 en tablet vertical) se oculta el
  subtítulo, los detalles del estado ("el NVR no entrega datos", la palabra "desfasada") quedan sólo
  para lectores de pantalla y, mientras la celda está desfasada, se oculta el pie: desfase y
  "Resincronizar" (44 px de alto) van en un renglón y no se superponen con la insignia de pista ni con
  el pie (la e2e lo mide en los tres dispositivos, en 2×2 y 3×3). La grilla ya no
  estira las filas. En Grabaciones (PC y tablet horizontal) la grilla ocupa el **alto real que
  sobra** entre los controles y el timeline: un contenedor con `container-type: size` y el ancho
  calculado en unidades `cqw/cqh` (`gridFit`), sin constantes de reserva; si sobra ancho, quedan
  bandas a los costados (letterbox). Con 4 cámaras, grilla y timeline entran completos en 1440×900 y
  en 1180×820; con más cámaras, las celdas no bajan de 220 px de ancho y la página se desplaza. El
  aviso "Cargando…" tiene un lugar fijo, así que aparecer no cambia el tamaño de la grilla. En la
  integración real el `<video>` va con `object-fit: contain` dentro del cuadro.
- **Timeline**: una fila por cámara de la grilla y un **cabezal común**; marcas **HH:MM** según el
  zoom (24 h cada 2 h · 6 h cada 30 min · 1 h cada 5 min · 15 min cada minuto, con marcas menores);
  botones **−/+** de 44 px; el rango se centra en el cabezal al cambiar el zoom y se recentra si el
  cabezal sale de la vista. Los **huecos** (sin grabación en ninguna pista) se ven rayados en rojo,
  con `aria-label`/`title` "Sin grabación de HH:MM a HH:MM" y el texto del rango cuando entra.
  Tocar o hacer clic en la línea busca esa hora. El deslizador "Día" (encabezado del timeline) queda
  como control de teclado y arrastre; el cabezal arranca debajo del renglón de horas para no tapar
  la marca HH:MM. La leyenda va debajo de las filas.
- **Sincronía por celda** (`model/playback.ts`, `syncReducer`): el reloj común sigue aunque una celda
  cargue o se bloquee; cada celda tiene su posición. Al abrir, buscar o resincronizar, la celda carga y
  al terminar se ubica en la hora del reloj común; si el NVR deja de entregar datos a mitad de la
  reproducción, su posición se congela y al liberarse sigue **atrasada**, con "desfasada −X s" y un
  botón **Resincronizar** sólo para esa celda. **"Esperar a todas"** (sincronía estricta) queda como
  opción explícita, **apagada por defecto**: con ella, el reloj no avanza mientras haya una celda
  cargando o bloqueada. El bloqueo se provoca con el control "Simular bloqueo" (sólo prototipo); se
  conserva si la misma cámara cambia de pista y se descarta si otra cámara ocupa la celda. La
  admisión por límite de sesiones del NVR, la cola, los huecos y la carga siguen visibles.
- **Configuraciones simuladas identificadas** (`model/backend.ts`, `settings/sections.ts`): cada
  sección muestra una marca persistente "Simulado — no se aplica en el backend" o "Existe en backend
  (endpoint) — no conectado en el prototipo"; un control que difiere de su sección tiene su propia
  marca (p. ej. la zona horaria e idioma de General son simulados y el nombre del sitio existe en
  `AppearanceSettings`; "Sensibilidad de movimiento" no existe en `CameraAnalyticsConfig`; "Eventos
  de detección" no es un interruptor único en el backend: `AlertSettings.alertTypes` acepta una clave
  por tipo de detección (`PERSON_DETECTED`, `ZONE_INTRUSION`… — ausente se notifica, `false` no) y el
  control simulado agruparía esas claves; la retención de eventos hoy es sólo la
  variable de entorno `ANALYTICS_RETENTION_DAYS`). Guardar dice "Guardado sólo en esta pestaña. No se
  aplicó…" según la marca de **cada control cambiado** (no la de la sección): si se cambian controles
  simulados y existentes a la vez, un renglón por grupo con sus controles; las acciones (agregar NVR, sincronizar, validar,
  diagnóstico, agregar usuario) dicen "No se ejecutó en el backend…". Vivo (visores, PTZ, video),
  Grabaciones (búsqueda, admisión, sincronía, simulación de bloqueo) y Eventos llevan la misma marca;
  editar o compartir un visor la muestra junto a la barra (en vertical el selector está plegado) y
  guardar, compartir o borrar dice "… sólo en este navegador. No se aplicó en el backend…".
- **Endpoints y campos verificados**: `model/backendEndpoints.test.ts` lee `apps/api/src/server.ts`,
  `routes/*.ts` y `prisma/schema.prisma` (sólo el código; no contacta servidores) y exige que cada
  endpoint de una marca "Existe en backend" sea una ruta registrada con ese método; que cada
  "Modelo.campo" citado exista; y que cada **control** marcado "existente" tenga su campo real
  (`apiField`, p. ej. `primaryColor` o `alertTypes.CAMERA_OFFLINE`, o su `key`) en el esquema zod con
  el que la ruta de escritura citada valida el cuerpo **y** como columna del modelo que esa ruta
  escribe. Una tabla escrita a mano fija los simulados críticos (zona horaria, idioma, retención,
  detección, sensibilidad de movimiento) con la evidencia del código. Si un endpoint o un campo
  cambia o se inventa, la prueba falla.

## Editor de zonas portado (React 18)

- `vendor/frigate/`: `PolygonCanvas`, `PolygonDrawer`, `canvasUtil`, `types/canvas`,
  `use-polygon-states` y `api/baseUrl` **idénticos** a Frigate v0.18.0 (`77a66e7`) bajo un
  encabezado MIT; `api/index.tsx` reducido a `useApiHost`. `vendor/vendor.test.ts` compara cada
  archivo con el hash del original (`UPSTREAM.json`): editar el portado rompe la prueba.
- Adaptaciones de VisionCore fuera del portado: `zones/shims/` (estado de zona desde la API de
  VisionCore en lugar del WebSocket de Frigate; indicador con lucide) y `zones/editOps.ts`
  (deshacer/reiniciar adaptados de `PolygonEditControls`, conversión a 0–1, reescalado).
- Dependencias fijadas exactas: `react-konva` **18.2.16** y `konva` **10.2.3** (React 18.3).
  `zones/versions.test.ts` exige que React y react-konva compartan versión mayor; CI corre
  `npm ls --all`. El editor se carga diferido (`React.lazy`): ~93 kB gzip sólo al abrir la sección;
  el build de producción de la app no incluye konva.
- La imagen de fondo (`public/api/sim/latest.webp`) es sintética.

La persistencia de visores usa `localStorage` para **simular** `/api/views`; en la integración
real los visores siguen en PostgreSQL (`CameraView`/`CameraViewAccess`) y la última selección
pasa a ser una preferencia del usuario en el servidor.

## Qué NO prueba

- **No demuestra que desaparecieron las pausas entre grabaciones.** No hay video: el reloj, la
  carga, los bloqueos y los desfases son simulados. Demostrarlo requiere **video reproducible en las
  pruebas** (fixtures con cortes de bloque conocidos, medidos en el navegador) y, después,
  **mediciones autorizadas con NVR reales**. Grabaciones lo dice en pantalla.
- Rendimiento, latencia, decodificación ni sesiones reales: eso es la parte **M** de
  `docs/frigate/PLAYER_TEST_PLAN.md` (pendiente de hardware y NVR reales).
- La carga ("cargando") es un tiempo simulado determinista, no el primer frame real; la alineación al
  reloj común al terminar de cargar supone que el reproductor real tiene datos por delante (a validar).
- Guardar en Configuración sólo afecta a la pestaña abierta y nada se aplica en el backend (cada
  sección y control lo marca).
