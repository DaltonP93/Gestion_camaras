# Runbook — Validación en producción de la capacidad de reproducción por NVR

Valida en un entorno real el control de admisión por NVR (leases + cola) que
introdujeron los PR #143, #144 y #145.

**Objetivo**: confirmar que dos cámaras del mismo NVR ya no producen
`453 Not Enough Bandwidth`, que la segunda espera en cola y arranca sola, y que
**ningún cupo se libera antes de que FFmpeg haya salido de verdad**.

> **Nunca** pegues en un informe contraseñas, tokens ni URI RTSP completas. Los
> logs del API enmascaran credenciales, pero la URI puede aparecer truncada en
> algunos mensajes: recortá antes de compartir.

---

## 1. Preparación

### 1.1 Servicios y contenedores afectados

| Contenedor | Servicio compose | Rol en esta validación |
|---|---|---|
| `visioncore_api` | `api` | Admisión, leases, cola, FFmpeg de preview |
| `visioncore_web` | `web` | UI de Grabaciones (estado "En espera") |
| `visioncore_nginx` | `nginx` | Proxy de `/api` y del stream fMP4 |
| `visioncore_postgres` | `postgres` | `nvrs.maxConcurrentPlaybackSessions`, `recordings_settings` |

Sólo se reinicia `api` si hay que cambiar variables de entorno.

### 1.2 Variables de entorno relacionadas

Todas se declaran en `.env` (ver `.env.example`). El servicio `api` las recibe
por `env_file: .env`, y además figuran explícitamente en su bloque
`environment:` de `docker-compose.yml` con su valor por defecto.

| Variable | Default | Efecto |
|---|---|---|
| `RECORDINGS_PREVIEW_KILL_GRACE_MS` | `2000` | Espera entre SIGTERM y SIGKILL |
| `RECORDINGS_TERMINATION_WAIT_MS` | `12000` | Espera de la salida real antes de declarar `terminating_stuck` |
| `RECORDINGS_EXIT_CONFIRMATION_MARGIN_MS` | `3000` | Margen para recibir exit/close y actualizar `aliveCount` |
| `RECORDINGS_UNCONSUMED_LEASE_MS` | `45000` | Plazo para que una reserva concedida abra su `/stream` |
| `RECORDINGS_NVR_CAPACITY_COOLDOWN_MS` | `120000` | Duración de la reducción temporal tras un 453 |

**Invariante garantizado por código**: la espera de terminación nunca es menor
que `KILL_GRACE + EXIT_CONFIRMATION_MARGIN`. Si configurás menos, el API la
eleva y registra **una** línea al arrancar:

```
recordings_termination_wait_clamped configuredTerminationWaitMs=... previewKillGraceMs=... exitConfirmationMarginMs=... effectiveTerminationWaitMs=...
```

### 1.3 Valores efectivos de kill grace y termination wait

Antes de empezar, dejá registrado qué valores están activos:

```bash
docker exec visioncore_api sh -lc 'echo "kill_grace=$RECORDINGS_PREVIEW_KILL_GRACE_MS wait=$RECORDINGS_TERMINATION_WAIT_MS margin=$RECORDINGS_EXIT_CONFIRMATION_MARGIN_MS unconsumed=$RECORDINGS_UNCONSUMED_LEASE_MS cooldown=$RECORDINGS_NVR_CAPACITY_COOLDOWN_MS"'

# ¿El API tuvo que elevar la espera al arrancar?
docker logs visioncore_api 2>&1 | grep -m1 recordings_termination_wait_clamped || echo "sin clamping (configuración coherente)"
```

Con los defaults: `kill_grace=2000`, `margin=3000` ⇒ mínimo `5000`; como el wait
por defecto es `12000`, el efectivo es **12000** y no hay clamping.

### 1.4 Endpoint administrativo de diagnóstico

Requiere un usuario con rol **ADMIN**. Obtené el token con el login normal de la
aplicación y exportalo (no lo pegues en informes):

```bash
export ADMIN_TOKEN='<token JWT de un usuario ADMIN>'
export BASE_URL='https://<tu-host>'      # o http://localhost si validás local

curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/api/admin/diagnostics/recording-playback-capacity" | jq .
```

> El endpoint refleja el estado **en memoria** del controlador: un NVR sin
> reproducciones ni cola **no aparece** en la lista, y los límites que muestra son
> los que se cargaron en la última reproducción/diagnóstico de ese NVR. Para ver
> la configuración persistida usá las consultas SQL de §1.6.

Salida relevante por NVR: `configuredLimit`, `effectiveLimit`,
`temporaryCapacityReduction`, `activeCount`, `queuedCount`, `last453At`,
`cooldownUntil`, más `active[]` (con `sessionId`, `cameraId`, `cameraName`,
`userId`, `slotIndex`, `pid`, `processAlive`, `acquiredAt`, `firstByteAt`,
`leaseType`, `consumed`, `state`, `terminating`) y `queue[]` (con `position`).

Atajo útil durante la prueba:

```bash
watch -n 2 "curl -s -H 'Authorization: Bearer $ADMIN_TOKEN' \
  '$BASE_URL/api/admin/diagnostics/recording-playback-capacity' \
  | jq '.nvrs[] | {nvrName, effectiveLimit, activeCount, queuedCount, active: [.active[] | {cameraName, state, leaseType, pid, processAlive}], queue: [.queue[] | {cameraName, position}]}'"
```

### 1.5 Seguir sólo los logs relevantes

```bash
# Eventos de capacidad, en vivo
docker logs -f visioncore_api 2>&1 | grep -E "nvr_playback_|nvr_diagnostic_lease_consumed|ffmpeg_close|ffmpeg_exit|first_byte"

# Sólo el ciclo de terminación (para verificar el ORDEN)
docker logs -f visioncore_api 2>&1 | grep -E "nvr_playback_lease_terminating|ffmpeg_exit|ffmpeg_close|nvr_playback_processes_exit_confirmed|nvr_playback_lease_released|nvr_playback_queue_promoted|nvr_playback_termination_stuck"
```

### 1.6 Identificar `nvrId`, `cameraId`, `sessionId` y `leaseType`

- **`nvrId` / `cameraId`**: aparecen en todos los logs `nvr_playback_*`. También
  se ven en la URL del frontend al abrir un NVR y en el endpoint de diagnóstico.
- **`sessionId`**: lo devuelve `POST /api/recordings/preview/start` y aparece en
  cada log de esa reproducción. En el navegador, la consola imprime
  `[recordings-ui] preview_queued slot=… sessionId=…`.
- **`leaseType`**: `preview` (reproducción de usuario) o `diagnostic`
  (diagnóstico ADMIN). Visible en el endpoint y en
  `nvr_diagnostic_lease_consumed`.

Consulta directa a la base para los límites configurados:

```bash
docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  'SELECT id, name, "maxConcurrentPlaybackSessions" FROM nvrs ORDER BY name;'
docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  'SELECT "recordingsDefaultMaxConcurrentPerNvr" FROM recordings_settings;'
```

> Usuario y base según `docker-compose.yml` (`POSTGRES_USER=visioncore`,
> `POSTGRES_DB=visioncore_db`). Ajustá si tu despliegue los cambió.

### 1.7 Respaldo, versión desplegada y rollback

```bash
# Versión actualmente desplegada (anotala). COMMIT_SHA se hornea en la imagen
# como build arg y se expone en el healthcheck.
curl -s "$BASE_URL/api/health" | jq .
docker inspect --format '{{.Config.Image}}' visioncore_api

# Respaldo de la base antes de la ventana
docker exec visioncore_postgres pg_dump -U visioncore visioncore_db \
  > backup_pre_validacion_$(date +%Y%m%d_%H%M).sql
```

**Rollback** (volver a la versión anterior):

```bash
# 1. Anotá el commit/imagen previos ANTES de desplegar.
git -C /ruta/al/repo checkout <commit-anterior>
docker compose build api web
docker compose up -d api web

# 2. Verificá que el API levantó y no hay leases colgados
docker logs --tail 50 visioncore_api
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/api/admin/diagnostics/recording-playback-capacity" | jq '.nvrs | length'
```

Las migraciones `0031`/`0032` son **aditivas** (columnas nuevas nullable y una
tabla nueva): revertir el código no requiere revertir la base. Si aun así
necesitás deshacerlas:

```sql
ALTER TABLE "nvrs" DROP COLUMN IF EXISTS "maxConcurrentPlaybackSessions";
ALTER TABLE "recordings_settings" DROP COLUMN IF EXISTS "recordingsDefaultMaxConcurrentPerNvr";
```

### 1.8 Selección de cámaras y ventana

- **Cámara A** y **cámara B**: dos cámaras **del mismo NVR**, de bajo impacto
  (pasillo, depósito, zona sin actividad crítica), con grabación disponible en
  el rango a reproducir.
- **Cámara C**: de **otro NVR**, para verificar que no hay bloqueo cruzado.
- **Ventana**: fuera del horario de mayor uso, con un operador disponible para
  confirmar que nadie más esté reproduciendo grabaciones de esos NVR
  (`activeCount` debe estar en 0 al comenzar).

---

## 2. Prueba principal con límite 1

### 2.1 Configurar o confirmar el límite efectivo

> **Antes de modificar nada, ANOTÁ el valor actual.** Si el NVR ya tenía un
> límite explícito distinto de 1, sobrescribirlo sin registrarlo dejaría todas
> sus reproducciones serializadas de forma permanente después de la prueba.
> La restauración es obligatoria en §2.4, tanto si el resultado es GO como
> NO-GO.

**Paso 0 — registrar el estado previo** (copiá la salida a la evidencia):

```bash
docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  "SELECT id, name, \"maxConcurrentPlaybackSessions\" AS valor_previo
     FROM nvrs WHERE id = '<nvrId-de-prueba>';"

docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  'SELECT "recordingsDefaultMaxConcurrentPerNvr" AS global_previo FROM recordings_settings;'
```

Anotá: `valor_previo = ____` (puede ser `NULL` = auto) y `global_previo = ____`.

**Opción A — por NVR (recomendada)**: sólo afecta al NVR de prueba.

```sql
UPDATE nvrs SET "maxConcurrentPlaybackSessions" = 1 WHERE id = '<nvrId-de-prueba>';
```

**Opción B — global**: úsala sólo si necesitás dejar el NVR en `auto`. Afecta a
**todos** los NVR sin límite propio, así que restaurala sí o sí al terminar.

```sql
UPDATE recordings_settings SET "recordingsDefaultMaxConcurrentPerNvr" = 1 WHERE id = 'singleton';
```

**Cómo verificar el cambio (importante):** el endpoint de diagnóstico expone el
estado **en memoria** del controlador (`admission.snapshot()`) y **no consulta la
base**. El límite por NVR y el global se cargan al controlador únicamente cuando
arranca un preview o un diagnóstico de ese NVR; además, un NVR sin actividad ni
siquiera aparece en el snapshot. Por lo tanto:

1. **Verificá la configuración en la BASE**, que es la fuente de verdad:

```bash
docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  "SELECT id, name, \"maxConcurrentPlaybackSessions\" FROM nvrs WHERE id = '<nvrId-de-prueba>';"
docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  'SELECT "recordingsDefaultMaxConcurrentPerNvr" FROM recordings_settings;'
```

2. El `effectiveLimit` del endpoint reflejará el valor nuevo **recién a partir de
   la primera reproducción posterior al cambio** (paso 2 de §2.2). Confirmalo
   ahí, no antes: esperar sin reproducir nada no lo actualiza.

### 2.2 Secuencia

| Paso | Acción | Resultado esperado |
|---|---|---|
| 1 | Confirmar `activeCount=0` y `queuedCount=0` en el NVR de prueba | punto de partida limpio |
| 2 | Reproducir **cámara A** en Grabaciones | A reproduce; log `first_byte`; endpoint: `activeCount=1`, `state` pasa a `active` |
| 3 | Reproducir **cámara B** (mismo NVR) en otro slot | B muestra **"En espera"** con posición 1 y `activo/límite` = `1/1`. **No** debe aparecer error rojo, ni "Códec no soportado", ni 503 |
| 4 | Verificar endpoint | `activeCount=1`, `queuedCount=1`, `queue[0].cameraName` = cámara B |
| 5 | Cerrar **A** (botón de cerrar slot) | comienza el cierre |
| 6 | Observar mientras `aliveCount > 0` | B **sigue** en "En espera" |
| 7 | Verificar el **orden** de los logs (ver abajo) | orden exacto |
| 8 | B arranca sola | una sola vez, con **el mismo `sessionId`** que ya tenía |

### 2.3 Orden obligatorio de eventos

```
nvr_playback_lease_terminating        nvrId=… sessionId=<A> aliveCount=1
ffmpeg_exit  (o ffmpeg_close)         sessionId=<A>
nvr_playback_processes_exit_confirmed nvrId=… sessionId=<A> aliveCount=0
nvr_playback_lease_released           nvrId=… sessionId=<A> reason=…
nvr_playback_queue_promoted           nvrId=… sessionId=<B>
```

Comando para capturarlo en orden cronológico:

```bash
docker logs --since 10m visioncore_api 2>&1 \
  | grep -E "nvr_playback_lease_terminating|ffmpeg_exit|ffmpeg_close|nvr_playback_processes_exit_confirmed|nvr_playback_lease_released|nvr_playback_queue_promoted" \
  | tail -20
```

> **Es FALLO** si `nvr_playback_queue_promoted` o `nvr_playback_lease_released`
> aparecen **antes** de `nvr_playback_processes_exit_confirmed` con
> `aliveCount=0`. Detené la validación y aplicá rollback.

Confirmá además que el `sessionId` de B en `nvr_playback_queue_promoted` es el
**mismo** que el de su `preview_queued` inicial (no se creó otra sesión).

### 2.4 Restaurar el límite (OBLIGATORIO, con GO o con NO-GO)

Al terminar la validación devolvé la configuración a su valor previo. Omitir
este paso deja las reproducciones de ese NVR —o de todos, si usaste la opción
B— innecesariamente serializadas.

```sql
-- Si usaste la opción A y el valor previo era un número:
UPDATE nvrs SET "maxConcurrentPlaybackSessions" = <valor_previo> WHERE id = '<nvrId-de-prueba>';

-- Si el valor previo era NULL (auto):
UPDATE nvrs SET "maxConcurrentPlaybackSessions" = NULL WHERE id = '<nvrId-de-prueba>';

-- Si usaste la opción B (global):
UPDATE recordings_settings SET "recordingsDefaultMaxConcurrentPerNvr" = <global_previo> WHERE id = 'singleton';
```

Verificá la restauración **en la base** (el endpoint no la relee):

```bash
docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  "SELECT id, name, \"maxConcurrentPlaybackSessions\" FROM nvrs WHERE id = '<nvrId-de-prueba>';"
docker exec visioncore_postgres psql -U visioncore -d visioncore_db -c \
  'SELECT "recordingsDefaultMaxConcurrentPerNvr" FROM recordings_settings;'
```

Si querés confirmarlo también en el endpoint, reproducí una vez cualquier cámara
de ese NVR y volvé a consultarlo: el controlador recarga el límite al arrancar
esa reproducción.

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/api/admin/diagnostics/recording-playback-capacity" \
  | jq '.nvrs[] | {nvrName, configuredLimit, effectiveLimit}'
```

Dejá constancia en la evidencia: `límite restaurado a ____ (hora ____)`.

---

## 3. Pruebas complementarias

| # | Escenario | Cómo | Resultado esperado |
|---|---|---|---|
| 1 | Cierre por `DELETE` | Cerrar el slot de A desde la UI | Mismo orden de eventos de §2.3 |
| 2 | Desconexión del cliente | Cerrar la pestaña del navegador con A reproduciendo | `reason=client_disconnect`; el lease **no** se libera hasta `aliveCount=0` |
| 3 | Cambio de cámara o playhead durante la espera | Con B en cola, cambiar su cámara o mover el playhead | `nvr_playback_queue_cancelled`; la solicitud vieja **no** arranca después |
| 4 | Fallo transitorio del polling | Con B en cola, cortar brevemente la red del navegador (DevTools → Offline unos 10 s) y restaurar | B **sigue** en "En espera"; en consola `nvr_playback_status_retry`; **no** se crea una segunda sesión (`sessionId` sin cambios) |
| 5 | Diagnóstico | Ejecutar el diagnóstico ADMIN de reproducción sobre una cámara del NVR | `nvr_diagnostic_lease_consumed`; en el endpoint `leaseType=diagnostic` y `consumed=true`; una preview del mismo NVR queda en cola y arranca al terminar |
| 6 | Otro NVR | Reproducir **cámara C** mientras A reproduce | C arranca de inmediato; sin bloqueo cruzado |
| 7 | Sin FFmpeg huérfanos | Tras cerrar todo, esperar ~1 min | `docker exec visioncore_api sh -lc 'ps -eo pid,etime,args \| grep -c "[f]fmpeg"'` → `0` |
| 8 | Sin duplicados | Revisar los logs de la ventana | Un solo `nvr_playback_lease_released` y un solo `nvr_playback_queue_promoted` por sesión |

> **No** fuerces un proceso realmente atascado en producción. Los escenarios de
> hard kill y `terminating_stuck` están cubiertos por los tests automatizados
> (`nvr-playback-admission.test.ts`, `termination-timing.test.ts`). Probalos en
> vivo sólo si tenés un entorno controlado y seguro.

Verificación de huérfanos y de liberaciones duplicadas:

```bash
# FFmpeg vivos dentro del contenedor del API
docker exec visioncore_api sh -lc 'ps -eo pid,etime,args | grep "[f]fmpeg" || echo "sin ffmpeg"'

# ¿Alguna sesión con más de un release o más de una promoción?
docker logs --since 30m visioncore_api 2>&1 \
  | grep -oE "nvr_playback_(lease_released|queue_promoted) [^ ]+ sessionId=[^ ]+" \
  | sort | uniq -c | sort -rn | head
```

---

## 4. Criterios de aprobación (GO)

- [ ] Ningún `453 Not Enough Bandwidth` causado por solapamiento.
- [ ] Nunca más de **una** reproducción real simultánea en el NVR con límite 1.
- [ ] Ninguna promoción antes de `nvr_playback_processes_exit_confirmed` con `aliveCount=0`.
- [ ] Sin `nvr_playback_termination_stuck` falsos (el proceso salió pero se marcó atascado).
- [ ] Sin esperar el barrido de 60 s cuando FFmpeg ya terminó.
- [ ] Sin bloqueos cruzados entre NVR (cámara C reproduce con A activa).
- [ ] Sin leases ni procesos FFmpeg huérfanos.
- [ ] Logs sin credenciales ni URI RTSP.
- [ ] La segunda cámara muestra **"En espera"**, no un error.
- [ ] B arranca automáticamente al cerrarse A, una sola vez y con su mismo `sessionId`.

## 5. Criterios de rollback (NO-GO)

Detené la validación y aplicá el rollback de §1.7 si ocurre **cualquiera**:

- Promoción antes de `aliveCount=0`.
- Lease retenido después de la salida confirmada.
- `453` por solapamiento.
- Proceso FFmpeg huérfano.
- Bloqueo de cámaras de otro NVR.
- `release` o promoción duplicados para la misma sesión.
- Errores nuevos y persistentes del API o del Web.

---

## 6. Plantilla de evidencia

```
Fecha/hora inicio (local):
Fecha/hora fin (local):
Versión desplegada (COMMIT_SHA / imagen):
Valores efectivos: kill_grace=____ wait=____ margin=____ unconsumed=____ cooldown=____
¿Hubo recordings_termination_wait_clamped al arrancar?  sí / no

NVR de prueba:      nvrId=____________  nombre=____________  effectiveLimit=____
Límite PREVIO del NVR (valor_previo):  ____________   (NULL = auto)
Límite global PREVIO (global_previo):  ____________
Opción usada para fijar el límite:     A (por NVR) / B (global)
Límite RESTAURADO a: ____________  hora: ____________
Cámara A:           cameraId=__________  nombre=____________
Cámara B:           cameraId=__________  nombre=____________
Cámara C (otro NVR):cameraId=__________  nombre=____________  nvrId=__________
```

| # | Prueba | Hora | Cámara | NVR | sessionId | Resultado | Observaciones |
|---|---|---|---|---|---|---|---|
| 2.2 | Principal límite 1 | | A→B | | | PASA / FALLA | |
| 3.1 | Cierre por DELETE | | A | | | PASA / FALLA | |
| 3.2 | Desconexión cliente | | A | | | PASA / FALLA | |
| 3.3 | Cambio playhead en espera | | B | | | PASA / FALLA | |
| 3.4 | Polling con fallo transitorio | | B | | | PASA / FALLA | |
| 3.5 | Diagnóstico | | — | | | PASA / FALLA | |
| 3.6 | Otro NVR | | C | | | PASA / FALLA | |
| 3.7 | Sin huérfanos | | — | | — | PASA / FALLA | |
| 3.8 | Sin duplicados | | — | | — | PASA / FALLA | |

**Logs del orden de terminación (pegar recortado, sin URI ni credenciales):**

```
nvr_playback_lease_terminating        …
ffmpeg_exit / ffmpeg_close            …
nvr_playback_processes_exit_confirmed …
nvr_playback_lease_released           …
nvr_playback_queue_promoted           …
```

**¿Se restauró el límite de capacidad?** sí / no  — obligatorio antes de cerrar.

**Conclusión:** GO / NO-GO
**Motivo (si NO-GO):**
**Acción tomada:**
