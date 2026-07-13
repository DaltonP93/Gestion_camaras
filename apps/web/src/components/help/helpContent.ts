// apps/web/src/components/help/helpContent.ts
// Contenido del manual integrado (centro de ayuda flotante).
// Cada sección se asocia a una ruta para abrirse automáticamente en contexto.

export interface HelpTopic {
  title: string
  steps: string[] // cada string es un párrafo/viñeta
}

export interface HelpSection {
  id: string
  route: string // prefijo de ruta que activa esta sección
  title: string
  emoji: string
  intro: string
  topics: HelpTopic[]
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'inicio',
    route: '/',
    title: 'Primeros pasos y roles',
    emoji: '🚀',
    intro: 'VisionCore es el sistema de gestión de cámaras: vista en vivo, grabaciones estilo iVMS, analítica con IA y alertas, todo desde el navegador.',
    topics: [
      {
        title: 'Ingreso al sistema',
        steps: [
          'Entrá con tu usuario y contraseña. Si tu cuenta tiene 2FA activado, el sistema te pedirá el código de tu app autenticadora.',
          'Si olvidaste la contraseña, usá "¿Olvidaste tu contraseña?" en el login — llega un correo con el enlace de restablecimiento (requiere SMTP configurado).',
          'La sesión se renueva sola mientras usás el sistema. Si ves un 401 momentáneo en la consola del navegador es normal: el token se refresca automáticamente.',
        ],
      },
      {
        title: 'Roles y qué puede hacer cada uno',
        steps: [
          'ADMIN: acceso total — NVRs, cámaras, usuarios, configuración, analítica, grabaciones.',
          'SUPERVISOR: ve todo, opera grabaciones y analítica, pero no administra usuarios ni configuración global.',
          'OPERATOR: solo vista en vivo de las cámaras que tenga asignadas. No accede a Grabaciones.',
          'AUDITOR: solo grabaciones de las cámaras con permiso de reproducción asignado.',
          'Los permisos finos por cámara/NVR (ver, reproducir, PTZ, descargar) se asignan en Usuarios → editar usuario → Permisos.',
        ],
      },
      {
        title: 'Navegación',
        steps: [
          'El menú lateral lleva a cada módulo. La campana de arriba muestra las alertas sin leer y se actualiza en tiempo real.',
          'Este manual se abre desde el botón flotante "?" y muestra primero la sección de la página donde estés.',
        ],
      },
    ],
  },
  {
    id: 'live',
    route: '/live',
    title: 'Vista en vivo',
    emoji: '📺',
    intro: 'Monitoreo en tiempo real de todas las cámaras. El video viaja del NVR a MediaMTX una sola vez y de ahí a todos los espectadores — no satura los NVRs.',
    topics: [
      {
        title: 'Ver cámaras en vivo',
        steps: [
          'Elegí el layout (1, 4, 9, 16) y hacé clic en las cámaras del árbol para asignarlas a los canales.',
          'Por defecto se usa el substream (liviano y fluido). El botón HD cambia al stream principal para ver el detalle de una cámara puntual.',
          'Si una cámara aparece offline, revisá su estado de salud en NVRs → detalle: el sistema diagnostica RTSP main/sub automáticamente.',
        ],
      },
      {
        title: 'Cámaras HEVC (H.265)',
        steps: [
          'Los navegadores no reproducen HEVC directo: el sistema lo transcodifica a H.264 automáticamente cuando activás HD en una cámara HEVC.',
          'Hay un límite de transcodificaciones simultáneas (MAX_TRANSCODE_SESSIONS) para no saturar la CPU del servidor.',
        ],
      },
    ],
  },
  {
    id: 'views',
    route: '/views',
    title: 'Visores (vistas guardadas)',
    emoji: '🖥️',
    intro: 'Los visores son composiciones de cámaras guardadas: ideales para pantallas de monitoreo fijas.',
    topics: [
      {
        title: 'Crear y compartir un visor',
        steps: [
          'Visores → Nuevo: elegí layout, arrastrá cámaras a los canales y guardá con un nombre.',
          'Podés marcarlo público (lo ven todos) o asignar acceso a usuarios específicos.',
          'El modo presentación (slideshow) rota automáticamente entre páginas de cámaras cada N segundos — perfecto para un videowall.',
        ],
      },
    ],
  },
  {
    id: 'recordings',
    route: '/recordings',
    title: 'Grabaciones (reproducción remota)',
    emoji: '🎞️',
    intro: 'Reproducción de las grabaciones almacenadas en los NVR, estilo iVMS-4200: multi-cámara sincronizada, timeline, continuidad automática entre clips y descarga MP4.',
    topics: [
      {
        title: 'Buscar grabaciones',
        steps: [
          '1. Marcá las cámaras en el árbol de la izquierda (casilla = incluir en la búsqueda; clic en el nombre = asignar al canal activo).',
          '2. Definí el rango Desde/Hasta o usá los atajos (Últ. 4h, Hoy, Ayer, 7d). El botón "Días" abre el calendario que marca qué días tienen grabación.',
          '3. Presioná Buscar. Los bloques grabados aparecen como barras rojas en el timeline, una fila por cámara.',
          'Tip: si marcás una cámara nueva DESPUÉS de buscar, el sistema la busca solo para el mismo rango — no hace falta volver a apretar Buscar.',
        ],
      },
      {
        title: 'Reproducir (multi-cámara sincronizada)',
        steps: [
          'Presioná ▶ Play: arrancan TODOS los canales asignados a la vez, sincronizados por un reloj maestro. No hace falta tocar el timeline antes.',
          'Arrastrá el cabezal del timeline para saltar a otro momento: todos los canales se reposicionan juntos.',
          'Cuando un clip termina, el sistema salta solo al siguiente bloque grabado (continuidad automática). Si hay un hueco grande muestra "Sin grabación" con botón para saltar al siguiente bloque.',
          'Velocidades: 1/16x a 16x. Frame a frame con el botón ⏭ (pausa y avanza un cuadro).',
          'La X del canal cierra solo ese video (la cámara y su fila del timeline se conservan). Desmarcar la casilla del árbol quita la cámara y oculta su fila.',
        ],
      },
      {
        title: 'Audio, captura y zoom',
        steps: [
          'Audio: el video arranca silenciado (política del navegador) — activalo con el ícono de volumen del reproductor. El audio del NVR se convierte automáticamente para el navegador.',
          'Captura: el botón "Captura" guarda un PNG del cuadro actual del canal activo, con nombre cámara_fecha-hora.',
          'Zoom digital: rueda del mouse sobre el video acerca hacia el cursor (hasta 8x); arrastrá para moverte; doble clic restablece.',
        ],
      },
      {
        title: 'Descargar MP4',
        steps: [
          '"Generar MP4…" crea el archivo en segundo plano SIN interrumpir la reproducción. Cuando termina aparece "Descargar MP4".',
          'El enlace de descarga dura 24 horas y sobrevive reinicios del servidor.',
          'Los MP4 generados quedan en caché: pedir el mismo clip de nuevo descarga al instante.',
        ],
      },
      {
        title: 'Errores comunes',
        steps: [
          '"El NVR rechazó esta segunda reproducción (453)": el NVR tiene un tope de reproducciones remotas simultáneas (2-3 típico). Cerrá otra reproducción del mismo NVR o esperá — el sistema además intenta automáticamente el substream, que consume menos cupo.',
          '"Codec no soportado": usá el botón "Reintentar con H.264" — convierte el video HEVC al vuelo.',
          'Reproducción reversa: no disponible (limitación de la tecnología web de streaming; iVMS lo hace con su SDK de escritorio).',
        ],
      },
    ],
  },
  {
    id: 'analytics',
    route: '/analytics',
    title: 'Analítica de video (IA)',
    emoji: '🤖',
    intro: 'Detección de personas y vehículos con IA local (sin nube ni cuentas externas), zonas de intrusión, conteo por líneas, permanencia y aforo. Corre en el contenedor "analytics" con Roboflow Supervision + YOLOX.',
    topics: [
      {
        title: 'Habilitar analítica en una cámara',
        steps: [
          '1. Pestaña Configuración → elegí la cámara → activá "Analítica habilitada".',
          '2. Elegí las clases a detectar (personas, autos, camiones, buses, motos, bicis).',
          '3. Ajustá la confianza mínima (50% recomendado), el muestreo (2 fps es suficiente) y el cooldown (segundos entre alertas repetidas).',
          '4. Guardá. El servicio toma el cambio en menos de 60 segundos.',
          'Importante: la analítica consume el MISMO stream que la vista en vivo (compartido vía MediaMTX) — activarla no roba sesiones del NVR ni tira la vista en vivo.',
        ],
      },
      {
        title: 'Zonas de intrusión, permanencia y aforo',
        steps: [
          'En el editor, con el modo "Zona" hacé clic sobre la imagen para marcar los vértices del polígono (mínimo 3) y cerrá la zona con su nombre.',
          'Cada objeto detectado dentro de la zona genera un evento de INTRUSIÓN (alerta + email por defecto).',
          'Permanencia (loitering): definí los segundos en la fila de la zona — si alguien queda dentro más de ese tiempo, dispara PERMANENCIA.',
          'Aforo: definí el máximo de la zona — si hay más objetos dentro que el límite, dispara AFORO SUPERADO.',
        ],
      },
      {
        title: 'Líneas de conteo (entradas/salidas)',
        steps: [
          'Modo "Línea de conteo": dos clics sobre la imagen definen la línea y le ponés nombre.',
          'Cada cruce cuenta como entrada (in) o salida (out) según la dirección. Por defecto los cruces SOLO cuentan (no alertan) — activá "Alerta" en la matriz de alertas si querés que suenen.',
          'Los contadores en vivo se ven en la pestaña "En vivo" y los acumulados en el Dashboard.',
        ],
      },
      {
        title: 'Alertas por tipo de evento',
        steps: [
          'La matriz "Alertas por tipo de evento" controla, por cámara: si genera alerta (campana), si manda email, la severidad y el cooldown propio.',
          'Defaults: detecciones sueltas = solo campana (LOW); intrusión/permanencia/aforo = campana + email (HIGH); cruce de línea = solo conteo.',
          'El email respeta además la configuración global de Alertas (SMTP, severidad mínima, tipos habilitados).',
        ],
      },
      {
        title: 'Pestañas En vivo, Dashboard y Forense',
        steps: [
          'En vivo: muestra el último frame ANALIZADO (con cajas, IDs de seguimiento, zonas y contadores) actualizado cada 2 segundos, más el estado de cada worker (fps real, frames, eventos, errores).',
          'Dashboard: eventos por hora, ranking de cámaras con más actividad, conteos in/out por línea y últimos snapshots.',
          'Forense: buscá eventos por cámara, tipo, clase, zona/línea, dirección y rango de fechas. Cada resultado tiene "Ver grabación" que salta al momento exacto en Grabaciones.',
          'El chip de estado del encabezado indica si el servicio de analítica está conectado y el modelo cargado.',
        ],
      },
      {
        title: 'Requisitos y rendimiento',
        steps: [
          'No hace falta GPU: en CPU (4 núcleos) el sistema analiza 4-8 cámaras a 2 fps. Con GPU NVIDIA escala a decenas (ver apps/analytics/README.md).',
          'El modelo de IA (~35 MB) se descarga solo la primera vez y corre 100% local en tu servidor.',
          'Lectura de matrículas (ALPR): preparado pero deshabilitado — el detector actual no lee chapas; requiere un modelo dedicado (ANALYTICS_ALPR_ENABLED).',
        ],
      },
      {
        title: 'Estados del servicio y de los workers',
        steps: [
          'El chip del encabezado indica si el servicio está conectado y el modelo cargado. Estados del servicio: running (operativo), degraded/model_error (el modelo no cargó — el servicio sigue vivo y reintenta), api_error.',
          'Cada cámara tiene un worker con estado: running, reconnecting, rtsp_down (no pudo abrir el stream), disabled_due_errors (falló 5 veces seguidas — se rearma al cambiar su configuración) y stopped.',
          'Si un worker queda "deshabilitado por errores", revisá que la cámara esté online y volvé a guardar su configuración para reintentar.',
          'El panel de workers muestra FPS real, frames procesados, eventos enviados y el último error por cámara.',
        ],
      },
      {
        title: 'Modelo, provider y uso de CPU',
        steps: [
          'La detección usa un provider intercambiable (por defecto YOLOX ONNX). Se puede correr en modo "mock" para validar el flujo sin un modelo real.',
          'Para bajar el uso de CPU: reducí el fps de muestreo (2 fps alcanza), limitá las clases a las necesarias y subí la confianza mínima.',
          'Hay un límite de workers simultáneos para proteger CPU/memoria; si tenés muchas cámaras conviene GPU.',
        ],
      },
      {
        title: 'Detección de caídas (preparada, requiere modelo)',
        steps: [
          'La arquitectura de caídas está preparada (pose + reglas temporales, no una simple caja inclinada) pero deshabilitada por defecto.',
          'Requiere instalar un modelo de pose con licencia compatible y activar ANALYTICS_FALL_DETECTION_ENABLED. Hasta entonces figura como "modelo no instalado".',
        ],
      },
    ],
  },
  {
    id: 'alerts',
    route: '/alerts',
    title: 'Alertas y notificaciones',
    emoji: '🔔',
    intro: 'Todas las alertas del sistema en un solo lugar: NVR/cámara offline, disco lleno, y los eventos de analítica.',
    topics: [
      {
        title: 'Campana y gestión de alertas',
        steps: [
          'La campana del encabezado muestra las no leídas y llega en tiempo real (WebSocket).',
          'En la página Alertas podés marcarlas leídas, resolverlas, o resolver/leer todas de una vez.',
          'Las alertas de analítica incluyen el snapshot anotado en su detalle.',
          'Retención: las alertas resueltas se purgan automáticamente después de 90 días (configurable con ALERTS_RETENTION_DAYS).',
        ],
      },
      {
        title: 'Configurar el correo (SMTP)',
        steps: [
          '1. Configuración → Alertas y correo: host, puerto, usuario, contraseña y remitente SMTP.',
          '2. Elegí qué tipos de alerta mandan email y la severidad mínima (HIGH por defecto para no saturar).',
          '3. Cargá los destinatarios separados por coma y usá "Probar envío" para verificar.',
          'Puerto 465 = SSL, puerto 587 = STARTTLS — el sistema lo deduce solo.',
        ],
      },
    ],
  },
  {
    id: 'nvrs',
    route: '/nvrs',
    title: 'NVRs y cámaras',
    emoji: '🗄️',
    intro: 'Administración de los grabadores Hikvision y sus canales. El sistema habla ISAPI (HTTP) para gestión y RTSP para video.',
    topics: [
      {
        title: 'Agregar un NVR',
        steps: [
          '1. NVRs → Agregar: IP, puerto (80), puerto RTSP (554), usuario y contraseña.',
          '2. "Probar conexión" valida credenciales y detecta modelo, firmware y canales automáticamente.',
          '3. Al guardar, el sistema sincroniza todas las cámaras del NVR (nombres, IPs, códecs, estado).',
          'Las credenciales se guardan cifradas (AES) y NUNCA aparecen en pantalla ni en logs.',
        ],
      },
      {
        title: 'Salud y sincronización',
        steps: [
          'Cada 60 segundos el sistema verifica cada NVR: online, uso de disco y estado de cada canal — genera alertas si algo cae.',
          'Cada 5 minutos sincroniza nombres/estados de cámaras desde el NVR.',
          'En el detalle del NVR ves los discos (capacidad, uso, estado) y podés revalidar la compatibilidad ISAPI de grabaciones.',
          'También podés editar la configuración de video/audio de cada canal — el sistema hace un respaldo automático antes de cada cambio, con opción de restaurar.',
        ],
      },
    ],
  },
  {
    id: 'users',
    route: '/users',
    title: 'Usuarios y permisos',
    emoji: '👥',
    intro: 'Gestión de cuentas, roles y permisos finos por NVR y por cámara (solo ADMIN).',
    topics: [
      {
        title: 'Crear usuarios y asignar permisos',
        steps: [
          '1. Usuarios → Nuevo: nombre, email, rol y contraseña inicial (podés forzar cambio en el primer ingreso).',
          '2. En Permisos, marcá por NVR y por cámara qué puede hacer: ver en vivo, reproducir grabaciones, PTZ, descargar, usar stream principal, etc.',
          '3. Los permisos de funcionalidades controlan qué módulos ve en el menú (dashboard, grabaciones, alertas, diagnósticos…).',
          'Seguridad: bloqueo automático tras intentos fallidos, historial de contraseñas, 2FA opcional por usuario y cierre de sesiones remotas.',
        ],
      },
      {
        title: 'Auditoría',
        steps: [
          'Actividad registra quién hizo qué y cuándo: logins, visualizaciones, búsquedas de grabaciones, descargas, cambios de configuración.',
          'Los registros de auditoría se conservan 365 días por defecto (AUDIT_RETENTION_DAYS).',
        ],
      },
    ],
  },
  {
    id: 'troubleshoot',
    route: '/__never__',
    title: 'Solución de problemas',
    emoji: '🛠️',
    intro: 'Los problemas más comunes y cómo resolverlos.',
    topics: [
      {
        title: 'Video',
        steps: [
          'Cámara offline en vivo: revisá NVRs → detalle → estado RTSP del canal. Si el canal está bien en el NVR pero falla acá, el botón de diagnóstico muestra el error exacto.',
          'Grabación no reproduce con error 453: límite de sesiones del NVR — cerrá otras reproducciones de ese NVR y usá "Reintentar cuando haya sesión libre".',
          'Video HEVC no abre: usá "Reintentar con H.264".',
        ],
      },
      {
        title: 'Analítica',
        steps: [
          '"Servicio desconectado" en el encabezado de Analítica: verificá en el servidor `docker compose ps` (el contenedor analytics debe estar Up) y `docker compose logs analytics --tail 50`.',
          '"Servicio degradado: modelo no cargado": el contenedor no pudo descargar el modelo (necesita internet la primera vez). Reintenta solo cada 5 minutos.',
          'Worker "Deshabilitado por errores": esa cámara falló 5 veces seguidas — corregí el problema (¿cámara offline?) y guardá de nuevo su configuración para rearmarlo.',
          'Sin eventos: verificá que la cámara esté habilitada, que las clases correctas estén marcadas y que la confianza no esté demasiado alta (probá 40-50%).',
          'Errores RTSP en analítica: la analítica lee el mismo restream de MediaMTX que la Vista en vivo (no abre una segunda sesión al NVR). Si el worker queda en "rtsp_down", probá abrir esa cámara en Vista en vivo — si tampoco carga, el problema es del NVR/red, no de la analítica.',
          'Activar analítica no debe tumbar la Vista en vivo: ambas comparten el stream. Si notás lo contrario, revisá los logs del API por "mediamtx_path_kept" (el path no debe borrarse mientras haya consumidores).',
        ],
      },
      {
        title: 'Sistema',
        steps: [
          'Emails no llegan: Configuración → Alertas → "Probar envío" muestra el error exacto del SMTP.',
          'Estado general del servidor: GET /api/health/deep muestra base de datos, Redis y versión desplegada.',
          'Logs del servidor: `docker compose logs -f api` (backend), `docker compose logs -f analytics` (IA).',
        ],
      },
    ],
  },
]
