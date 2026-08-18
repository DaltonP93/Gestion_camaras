# PR A1 — Verdad del heartbeat, sesiones y limpieza de FFmpeg

Rama: `claude/fix-session-heartbeat-truth` · Base: `main` @ `45b0d6b5`

## 1. Estado del repositorio: qué está comprobado y qué no

La auditoría de Fase 0 se hizo sobre un **clon**, no sobre producción. La
distinción importa porque `COMMIT_SHA` es un *build arg*: el `HEAD` de un
repositorio no prueba qué imagen está corriendo.

```text
HEAD del clon inspeccionado:        45b0d6b5ecf08ce785d751e7ad414e916a6189d1
HEAD/runtime efectivo de producción: pendiente de verificación autorizada
```

**Comprobado** (sobre el clon en `/home/user/Gestion_camaras`):

- El árbol de trabajo está limpio.
- `main` apunta a `45b0d6b5`.
- Los PR #116–#145 están contenidos en ese `HEAD`, sin huecos.
- Los 614 tests de la base pasan (486 API + 128 web).

**No comprobado** — requiere una verificación autorizada en el servidor:

- El commit realmente ejecutado en producción.
- La imagen Docker desplegada.
- El estado del repositorio productivo `/home/sistemas/Gestion_camaras`.
- Si existe `docker-compose.override.yml` u otro archivo local no versionado.
  **Ningún override productivo debe borrarse, reemplazarse ni ignorarse durante
  una futura validación.**
- Las migraciones aplicadas en PostgreSQL.
- La configuración efectiva cargada por los contenedores.

## 2. Problema que resuelve este PR

Dos defectos que se realimentaban:

```text
ANTES
  ffmpegAlive → el limpiador renueva lastHeartbeat → la sesión nunca expira
              → nunca se llama a stopTranscodeProcess → ffmpegAlive sigue true
              → (ciclo cerrado: 26 h de sesión sin espectador)
              → la sesión cuenta como demanda en el monitor de pipeline
              → source_not_ready_with_demand → CAMERA_STREAM_ERROR falso

DESPUÉS
  heartbeat real del cliente  → sesión válida
  heartbeat vencido           → se elimina la referencia
  cero viewers válidos        → termina FFmpeg
```

El código eliminado era literalmente:

```ts
// stream-manager.ts (antes)
if (ffmpegAlive)    { session.lastHeartbeat = new Date(); continue }
if (recentActivity) { session.lastHeartbeat = new Date(); continue }
```

## 3. Modelo nuevo

Tres conceptos separados que no pueden sustituirse:

| Campo | Origen | ¿Sostiene la sesión? |
|---|---|---|
| `lastClientHeartbeat` | Hora del **servidor** al recibir actividad explícita de un cliente autenticado | **Sí, y es el único** |
| `lastMediaActivity` | Actividad de medio observada sobre el `streamPath` | No — diagnóstico |
| `processAlive` | `isTranscodeProcessAlive(streamPath)` | No — estado observado |

La decisión de vigencia vive en `apps/api/src/services/session-lifecycle.ts`,
cuyas funciones son **puras** y reciben el reloj por parámetro. `processAlive` y
`lastMediaActivity` **no figuran en la firma** de `decideSessionExpiry`: no
existe un parámetro por el que pudieran volver a colarse.

## 4. Variables

| Variable | Default | Rango | Efecto |
|---|---|---|---|
| `STREAM_IDLE_TIMEOUT` | 90 s | 15–3600 | TTL de sesiones `sub`/`main` sin heartbeat de cliente |
| `STREAM_HD_IDLE_TIMEOUT` | 90 s | 15–3600 | TTL de sesiones `main_h264`. Si no se define, hereda la anterior |

Se registran los valores **efectivos** al resolverlos:

```
stream_session_ttl_resolved standardTtlMs=… hdTtlMs=… requestedStandardSec=… requestedHdSec=… wasClamped=…
```

## 5. Comportamiento del cliente

1. Pestaña visible y player montado → heartbeat cada 30 s.
2. `document.hidden` → heartbeat **suspendido** (log `heartbeat_suspended`).
3. Vuelve antes del TTL → heartbeat inmediato; la sesión se conserva
   (`heartbeat_resumed`).
4. Oculta más que el TTL → el servidor expiró la sesión y liberó FFmpeg. Al
   volver se pide alta calidad **una sola vez** (`hd_reacquire_after_hidden`);
   si no hay cupo se mantiene baja calidad **sin overlay de error**
   (`hd_reacquire_failed`). Nunca pantalla negra.
5. Desmontaje, cambio de cámara/layout, cierre explícito y `pagehide` → cierre
   inmediato e idempotente con `keepalive`.
6. El TTL del servidor sigue siendo la garantía final.

### Por qué no `sendBeacon`

`navigator.sendBeacon` no permite fijar el encabezado `Authorization`. Las
alternativas serían poner el token en la URL (queda en los logs de nginx y en el
historial) o montar una cookie ad-hoc. Ambas empeoran la seguridad para resolver
un problema que `fetch(..., { keepalive: true })` resuelve sin ceder nada.

## 6. Logs estructurados agregados

```text
stream_session_ttl_resolved     valores EFECTIVOS de ambos TTL
view_session_expired            cameraId, streamType, viewId, reason,
                                clientHeartbeatAgeMs, generation,
                                observed_processAlive, observed_mediaActivityAgeMs
view_session_closed             cierre explícito, con generación y motivo
transcode_keepalive             el proceso sigue vivo: otro espectador lo usa
transcode_killed                terminado por refcount cero
heartbeat_ignored_stale         heartbeat descartado por cierre posterior
```

En el frontend: `heartbeat_suspended`, `heartbeat_resumed`,
`hd_reacquire_after_hidden`, `hd_reacquire_failed`.

Ninguno incluye credenciales, tokens ni URI RTSP.

## 7. Riesgos conocidos

1. **Una pestaña en segundo plano pierde el HD a los 90 s.** Es el
   comportamiento decidido, y es un cambio real respecto de hoy: antes
   sobrevivía indefinidamente. Al volver, la baja calidad sigue y el HD se
   re-pide una vez. Si el uso real muestra que 90 s es corto, se sube
   `STREAM_HD_IDLE_TIMEOUT` sin tocar código.
2. **Más terminaciones de FFmpeg que antes.** Es el objetivo, pero implica más
   arranques cuando el usuario alterna entre pestañas. Los límites de
   transcodificación no cambian en este PR (eso es B2).
3. **La guarda de respuestas tardías se apoya en la hora del servidor.** Si la
   petición llegó antes del cierre y se procesa después, se descarta
   correctamente. No cubre el caso de dos instancias de API con relojes
   desincronizados, porque hoy el estado de sesiones es en memoria y por
   proceso; con varias réplicas este módulo necesitaría estado compartido.
4. **No verificado contra NVRs reales.** Ver sección 9.

## 8. Compatibilidad

- **Sin migraciones.** El estado de sesiones es en memoria.
- Las rutas `POST /cameras/:id/stop-stream` y
  `POST /cameras/cleanup-my-sessions` se conservan intactas; las nuevas `DELETE`
  se agregan al lado.
- Los DTO de diagnóstico renombran `lastHeartbeat` → `clientHeartbeatAgeMs` /
  `lastHeartbeatSecs` según el endpoint. No hay consumidores en el frontend
  (verificado con búsqueda en `apps/web/src`).
- Un despliegue que sólo define `STREAM_IDLE_TIMEOUT` se comporta igual que
  antes en cuanto a plazos: el TTL de HD lo hereda.

## 9. Qué NO se pudo verificar sin producción

- Que una pestaña real de Chrome/Edge emita el `DELETE` con `keepalive` al
  cerrarse (probado con mock de `fetch`, no en navegador real).
- Que FFmpeg muera efectivamente en el contenedor tras la expiración.
- Que la desaparición de sesiones fantasma reduzca los `CAMERA_STREAM_ERROR`
  falsos: eso depende también de A2.
- El comportamiento con las 141–144 cámaras reales y varios usuarios
  concurrentes.

Estas verificaciones requieren la ventana controlada descrita en la Fase 0
(canales 17, 23, 24 y 29 de `NVR_32_SAA_2023`), y **autorización explícita**.

## 9 bis. Validación A1 en producción: plazos reales y condiciones

Añadido tras la validación sobre `9efc680`, que dio PASS en todo salvo un punto:
la pestaña oculta siguió latiendo. Esta sección fija los números con los que se
mide, para que una espera corta no vuelva a leerse como un defecto —ni un
defecto como una espera corta—.

### Plazos reales

| Concepto | Valor | Dónde se define |
|---|---|---|
| TTL de `view_session` (grilla / substream) | **90 s** | `DEFAULT_STREAM_IDLE_TIMEOUT_SEC`, override `STREAM_IDLE_TIMEOUT` |
| TTL de sesión HD / transcodificada | **90 s** | `DEFAULT_STREAM_HD_IDLE_TIMEOUT_SEC`, override `STREAM_HD_IDLE_TIMEOUT` |
| Frecuencia del prune | **cada 2 min** (`*/2 * * * *`) | `cron.schedule` en `apps/api/src/jobs/healthWorker.ts` |
| Margen recomendado | **30 s** | criterio de esta validación |

El prune corre en minutos pares del reloj, no a partir del momento en que la
sesión vence: entre el vencimiento y la barrida puede pasar desde ~0 s hasta el
intervalo completo.

### Espera necesaria antes de declarar un fallo

```
espera = TTL + intervalo de prune + margen
       = 90 s + 120 s + 30 s
       = 240 s  (4 minutos)
```

**Los 150 s de la ejecución fallida no alcanzaban** ni con el heartbeat
detenido: 150 < 210. Cualquier prueba que verifique liberación por TTL debe
esperar **240 s** desde el último heartbeat y recién entonces mirar
`expiraciones`, lectores de MediaMTX y procesos FFmpeg.

Si se necesita una ventana más corta para iterar, bajar `STREAM_IDLE_TIMEOUT`
—no acortar la espera— y dejar constancia del valor usado en el informe.

### Condiciones de la corrida

- **NVR_32 debe mostrar 16 cámaras reales.** La ejecución que reportó 9 en la
  pestaña B no es válida como validación final: con 9 cámaras el cupo de
  transcodificación y el límite por usuario no se ejercitan igual.
- Ambas pestañas deben tener **viewId distintos** y ninguno puede ser
  `default`.
- La pestaña que se oculta debe permanecer oculta de verdad
  (`document.visibilityState === 'hidden'`), no simplemente detrás de otra
  ventana: un cambio de foco sin cambio de visibilidad no suspende el heartbeat
  y no es el caso que se está midiendo.

### Scripts interactivos por heredoc

Un script lanzado con `bash <<'EOF' … EOF` recibe el propio script por su
entrada estándar: cualquier `read` de una pausa consume el texto del script en
lugar de esperar al operador, y la corrida se desordena en silencio.

Las pausas deben leerse **explícitamente desde la terminal**:

```bash
read -rp "Ocultá la pestaña A y presioná Enter… " _ < /dev/tty
```

Lo mismo para cualquier confirmación intermedia. Si el script no tiene terminal
asociada (`[ -t 0 ]` falso y `/dev/tty` no disponible), debe **abortar con un
mensaje**, no continuar sin la pausa.

### Qué mirar al volver a la pestaña

1. Un único heartbeat inmediato (no una ráfaga).
2. `startedIds` no vacío si se superó el TTL → readquisición automática.
3. Sin `STREAM_LIMIT_REACHED`.
4. Reproducción restaurada sin recargar la página.

## 10. Rollback

Sin migraciones ni cambios de esquema: revertir el código alcanza.

```bash
# Volver al commit previo a esta rama y reconstruir sólo api y web.
git -C /home/sistemas/Gestion_camaras checkout <commit-previo>
COMMIT_SHA=<commit-previo> docker compose build api web
docker compose up -d --no-deps --force-recreate --no-build api web
docker exec visioncore_nginx nginx -t && docker exec visioncore_nginx nginx -s reload
```

Si sólo hace falta neutralizar el cambio de plazos sin revertir código, subir
`STREAM_HD_IDLE_TIMEOUT` recupera la tolerancia a pestañas en segundo plano —
pero **no** restaura la renovación por proceso vivo, que fue eliminada a
propósito.
