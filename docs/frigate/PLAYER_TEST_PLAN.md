# Plan de pruebas — reproductor, timeline y sesiones (NVR simulado → NVR real)

> Estado: **PLAN**. Acompaña a `NATIVE_INTEGRATION_PROPOSAL.md` (etapas E1–E8). Revisión 2 — 2026-10-08:
> corrige el criterio de grabaciones en grilla (no se asume subflujo grabado; ver §1.1).
> Regla: **simulado** prueba lógica y contratos; **no** se usa para declarar rendimiento. Toda afirmación
> de rendimiento, latencia o capacidad requiere la parte **M** con hardware y NVR reales.

## 0. Niveles y dónde corren

| Nivel | Qué es real | Qué es simulado | Dónde | Estado |
|---|---|---|---|---|
| **U** — unitario | lógica pura del controlador de reproducción y del proveedor | todo I/O | `vitest` (web/api), CI | ejecutable hoy |
| **E** — navegador | `<video>`, decodificación VP9/fMP4 y temporizadores del navegador (Chromium) | API de VisionCore y NVR (`page.route`), clip sintético `recording-synthetic.mp4` | Playwright (`apps/web/e2e`), CI job `web-e2e` | ejecutable hoy (harness existente; fixtures de #181) |
| **I** — integración backend | API, FFmpeg, MediaMTX, PostgreSQL y Redis | **NVR simulado**: servidor ISAPI falso (búsqueda XML) + MediaMTX local publicando `testsrc` de FFmpeg en `Streaming/tracks/<canal*100+1>` | contenedores locales/CI, sin red externa | **a construir** (E1) |
| **M** — medición real | todo | nada | servidor nuevo (Dell) + NVR reales, en ventana autorizada | **PENDIENTE de hardware** |

El NVR simulado del nivel **I** no imita la semántica de playback de Hikvision (`starttime`/`endtime`
se ignoran en el RTSP); sirve para el ciclo de vida de FFmpeg, leases, admisión y revocación, no
para validar tiempos del archivo.

## 1. Suite simulada S1–S9

### 1.1 Criterio de pistas en grabaciones (corrección)

La revisión 1 asumía "grabaciones en grilla ⇒ substream". **No se puede asumir** que el NVR grabó
el subflujo: muchos sólo graban la pista principal, otros graban ambas sólo en parte del día.
En el código no hay una regla "grilla ⇒ substream" (el layout no viaja a `/preview/start`; 1×1 y
grilla usan el mismo plan de intentos). El supuesto estaba en la documentación. Lo que sí hace el
código es **usar el subflujo sin saber si existe**:
- la búsqueda ISAPI y `dailyDistribution` consultan sólo `trackID = canal*100+1`
  (`apps/api/src/services/hikvision.ts:1760`, `:1929`): timeline y calendario sólo muestran la
  cobertura de la principal, y los resultados no guardan la pista;
- el subflujo `canal*100+2` se **deriva** sumando 1 (`toSubstreamTrackUrl`,
  `apps/api/src/services/recordings/rtsp-url.ts:174-182`) y se agrega al final del plan de intentos
  en modo `auto` (`buildPlaybackAttemptPlan`, `rtsp-url.ts:349`, `:388-397`; ruta heredada
  `buildVariantChain`, `:202-225`);
- **se generaliza por NVR**: si un intento de subflujo funciona en una cámara, todo el NVR pasa a
  preferir `sub_full` (`apps/api/src/routes/recordings.ts:2884-2893`); un 400 en la pista `+2`
  marca a todo el NVR "sin subflujo" durante 6 h (`recordings.ts:3058-3067`, `:487-493`). Ambas
  confunden "esta cámara o este instante no tiene la pista" con "el NVR no la soporta".
- el reloj maestro avanza aunque una celda esté cargando y el re-buffering a mitad de reproducción
  no se detecta (no hay listeners `waiting`/`stalled`; `apps/web/src/pages/RecordingsPage.tsx:424-470`,
  `:1835-1840`).

Las líneas son de `main` (`94305f3`); se verificaron por lectura, sin ejecutar contra un NVR.

Criterio nuevo (el prototipo #188 lo implementa con datos simulados):
1. **Descubrir** las pistas archivadas por cámara y ventana: búsqueda por `canal*100+1` y
   `canal*100+2`; guardar la cobertura de cada pista.
2. **Elegir por celda y por instante del reloj común** una pista **con grabación en ese instante**:
   grilla ⇒ subflujo si está archivado, si no principal (con aviso); 1×1 ⇒ principal, si no
   subflujo (con aviso).
3. **Huecos:** sin grabación en ninguna pista ⇒ la celda lo muestra, ofrece "ir al próximo tramo"
   y no abre sesión.
4. **Buffering:** "cargando" por celda; política de reloj común configurable (sincronía estricta:
   el reloj espera; si no, la celda se resincroniza).
5. **Límites:** las sesiones se admiten por NVR hasta `maxConcurrentPlaybackSessions`; el
   excedente queda **en cola con posición visible**. Una celda con la principal porque no hay
   subflujo cuesta más ancho de banda del NVR: se informa, no se oculta.


Notación: **[existe]** = prueba ya escrita (repo o PR pospuesto, a portar al controlador), **[nueva]**.

### S1 — Continuidad entre bloques
| ID | Nivel | Escenario | Aserción | Origen |
|---|---|---|---|---|
| S1.1 | E | tres bloques contiguos | el sucesor se **registra antes** de cerrar el predecesor; se reproducen los 3 sin clic | [existe] #181 `recordings-continuity.spec.ts` |
| S1.2 | E | hueco de 6 s entre bloques en 1×1 | continúa solo, sin pedir clic; el timeline muestra el hueco | [existe] #181 |
| S1.3 | E | espera de datos mayor que el bloque | no salta video no reproducido | [existe] #181 |
| S1.4 | E | cerrar mientras llega un sucesor | la respuesta tardía se descarta (identidad), no se publica ni fuga | [existe] #181 |
| S1.5 | I | fin de bloque con FFmpeg real | el lease del predecesor se libera **después** de la salida real de FFmpeg, nunca antes | [nueva] |

### S2 — Seek
| ID | Nivel | Escenario | Aserción |
|---|---|---|---|
| S2.1 | E | seek dentro del bloque cargado | sólo `currentTime`; ninguna petición nueva |
| S2.2 | E | seek fuera del bloque | 1 sesión nueva en la posición pedida; la anterior se cierra por identidad; respuestas viejas descartadas |
| S2.3 | E | seeks rápidos encadenados (5 en 1 s) | sólo la última posición publica video; ≤1 sesión activa al final |
| S2.4 | E | seek sobre un hueco del NVR | salta al siguiente bloque con aviso, no reproduce un clip local |
| S2.5 | I | seek fuera del bloque con FFmpeg real | el FFmpeg viejo termina (salida observada) antes de liberar su lease |

### S3 — Pausa
| ID | Nivel | Escenario | Aserción | Origen |
|---|---|---|---|---|
| S3.1 | E | pausa durante el bloque | el timer de continuidad no avanza; al reanudar se reprograma desde `currentTime` | [existe] #181 |
| S3.2 | E | pausa larga (> TTL de sesión) | al reanudar, sesión renovada o reabierta sin saltos; sin sesiones huérfanas | [nueva] |
| S3.3 | E | buffering (`waiting`) | igual que pausa: no avanza el timer | [existe] #181 (listeners `waiting`/`seeking`) |

### S4 — Velocidades
| ID | Nivel | Escenario | Aserción | Origen |
|---|---|---|---|---|
| S4.1 | E | 0.5×, 1×, 2×, 4× | el timer de continuidad usa video consumido, no reloj de pared; el reloj del timeline avanza al ritmo elegido | [existe parcial] #181 |
| S4.2 | E | cambio de velocidad a mitad de bloque | no adelanta bloque; reprograma | [existe] #181 |
| S4.3 | E | velocidad en multicámara | todas las celdas comparten el reloj; ninguna avanza sola | [nueva] |

### S5 — Multicámara y cambio de cámara
| ID | Nivel | Escenario | Aserción |
|---|---|---|---|
| S5.1 | E | 2×2 con 4 cámaras | 4 sesiones, cada una con la pista **archivada** que elige §1.1 (no se asume subflujo); reloj común; huecos por celda |
| S5.2 | E | cambiar una celda de cámara | la sesión de esa celda se cierra por identidad; las otras 3 no se tocan |
| S5.3 | E | cambiar layout 2×2 → 1×1 | quedan las sesiones de la celda visible; el resto se cierran; respuestas viejas descartadas (invariante 4) |
| S5.4 | E | cambiar de NVR/página durante carga | ninguna respuesta vieja inicia ni publica un stream |

### S6 — Calidad automática y pistas archivadas
| ID | Nivel | Escenario | Aserción | Origen |
|---|---|---|---|---|
| S6.0 | U | **vivo** 1×1: plan de layout pide foco HD y vuelve a sub al salir | transiciones 3×3→1×1→2×2 sin reiniciar HD de más | [existe en la rama de #180, pospuesto; **no** en `main`] (`liveLayoutQuality.test.ts`, `live1x1HdWiring.test.ts`, unitarias) |
| S6.1 | U/E | **grabaciones** 1×1 | pide la pista principal si está archivada en el instante pedido; si sólo hay subflujo en ese instante, lo usa y lo indica | [nueva] |
| S6.2 | U/E | **grabaciones** en grilla, cámara con subflujo archivado | usa el subflujo (`canal*100+2`) sólo donde la búsqueda lo devuelve | [nueva] |
| S6.2b | U/E | grilla, cámara **sin** subflujo archivado (sólo principal) | usa la principal con aviso visible ("el NVR no grabó subflujo"); cuenta como sesión principal en la admisión; **nunca** pide una pista sin grabación | [nueva] — prototipo #188 la cubre con datos simulados |
| S6.2c | U/E | subflujo archivado sólo en parte de la ventana | al cruzar el límite cambia de pista sin saltar video y la celda muestra "cargando" | [nueva] |
| S6.3 | E | principal no lista o HEVC sin soporte | degrada a `main_h264` o a la pista archivada disponible sin error visible; vuelve al estar lista | [existe parcial] `fullscreen-fast-release` (HEVC ⇒ `main_h264`) |
| S6.4 | I | descubrimiento de pistas | la búsqueda ISAPI se hace por `trackID` principal y subflujo; el resultado guarda la cobertura **por pista**; un 0 de subflujo no es error | [nueva] (hoy sólo se busca `canal*100+1`, ver §1.1) |

### S7 — Liberación de sesiones
| ID | Nivel | Escenario | Aserción | Origen |
|---|---|---|---|---|
| S7.1 | E | salir de la vista / cerrar pestaña | `close` por identidad; `pagehide` con `keepalive` | [existe] `fullscreen-fast-release.spec.ts` |
| S7.2 | E | `close` devuelve 500 | se reintenta hasta confirmar; nada queda activo | [existe] idem |
| S7.3 | I | espectador desconectado sin `close` | la red de seguridad (TTL/reaper) termina FFmpeg y libera el lease; nunca sólo por timer si hay espectador vivo (invariante 3) | [nueva] |
| S7.4 | I | dos espectadores del mismo stream, uno sale | el stream sigue para el otro | [nueva] |

### S8 — Revocación de permisos
| ID | Nivel | Escenario | Aserción | Origen |
|---|---|---|---|---|
| S8.1 | E | 403 al registrar el sucesor | libera el anterior y muestra el error de permisos | [existe] #181 |
| S8.2 | I | revocar `canPlayback` a mitad de sesión | la siguiente petición (status/stream/sucesor) da 403; FFmpeg termina; lease liberado | [nueva] |
| S8.3 | I | logout | sesiones de medios revocadas (outbox) aunque Redis caiga y vuelva | [existe parcial] suites de revocación |
| S8.4 | U/I | `playbackURI` de otro canal | 403 antes de contactar el NVR | [existe] #186 |

### S9 — Límites de sesiones y admisión
| ID | Nivel | Escenario | Aserción |
|---|---|---|---|
| S9.1 | I | más previews que el presupuesto por NVR | los excedentes quedan en cola con posición visible; nunca se superan las sesiones RTSP configuradas |
| S9.2 | I | continuidad con prioridad | un sucesor de continuidad entra antes que una sesión normal sólo si el predecesor consumió su lease (contrato `continuityOfSessionId`) |
| S9.3 | I | `MAX_STREAMS_PER_USER` | el usuario no supera su límite; cerrar libera cupo |
| S9.4 | E | UI en cola | muestra "en cola · posición N · el NVR acepta L sesiones" y arranca sola al liberarse cupo |
| S9.5 | E | indicador por NVR | barra de controles muestra `activas/límite` y `en cola` por NVR; nunca `activas > límite` |
| S9.6 | E | hueco en una celda | la celda muestra "sin grabación hh:mm" y "ir al próximo tramo"; no consume sesión; las demás siguen |
| S9.7 | E | carga (buffering) | la celda muestra "cargando"; con sincronía estricta el reloj común espera; sin ella, la celda se resincroniza al recuperar |

**Criterio de E1:** S1–S9 en verde en CI (niveles U/E/I), sin pruebas omitidas ni deshabilitadas.

**Prototipo #188 (datos simulados):** su lógica pura (`prototype/model/playback.ts`) y sus pruebas
Playwright en PC y tablet ya ejercitan el **criterio** de S5.1, S6.1–S6.2c y S9.4–S9.7 (pista
archivada por instante, huecos con "ir al próximo tramo", carga con sincronía estricta, cola por
límite del NVR, velocidades medidas contra el tiempo real). Valida la experiencia y el contrato; **no**
reemplaza las pruebas E/I del controlador real de E1.

## 2. Mediciones con hardware y NVR reales (parte M) — **PENDIENTES**

No se ejecutan hasta tener el servidor nuevo, una ventana autorizada y el aislamiento de #187 en
staging. Se registran método, cámaras (ids, no IPs), firmware del NVR, fecha y resultado.

| ID | Métrica | Método | Condición de éxito (a fijar con el usuario) |
|---|---|---|---|
| M1 | Tiempo al primer frame del playback (1×1 y 2×2) | instrumentación existente `[recordings-ui]` + logs API, 20 repeticiones por cámara | p50/p95 antes vs después |
| M2 | Continuidad real entre bloques | reproducir 30 min continuos por cámara | 0 cortes no explicados por huecos del NVR |
| M3 | Seek real | 20 seeks fuera de bloque | p95 al primer frame tras seek |
| M4 | Sesiones RTSP por NVR | contador del NVR (ISAPI) + `ss`/MediaMTX | nunca supera el límite del modelo de NVR |
| M5 | Liberación real | cerrar vistas/pestañas y medir FFmpeg vivos y leases | 0 FFmpeg huérfanos tras TTL |
| M6 | Calidad automática | 1×1 vs grilla con cámaras H.264 y HEVC | pista elegida según §1.1 (principal en 1×1; subflujo en grilla **sólo si está archivado**); degradación correcta |
| M9 | Inventario de pistas archivadas | búsqueda ISAPI de **sólo lectura** por `canal*100+1` y `+2` en cada NVR, una ventana de 24 h | tabla por NVR/cámara: principal sí/no, subflujo sí/no, cobertura %; requiere autorización porque contacta NVR reales |
| M7 | Carga del servidor con detección | CPU/RAM/GPU/NPU con N cámaras analizadas (E7) | margen definido para crecer |
| M8 | Alineación de reloj NVR↔servidor | offset por NVR durante 7 días | desvío bajo el umbral, o aviso visible |

Estado actual de todas las filas M: **NO EJECUTADO — requiere hardware**.
