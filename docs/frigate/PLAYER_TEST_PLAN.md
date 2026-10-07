# Plan de pruebas — reproductor, timeline y sesiones (NVR simulado → NVR real)

> Estado: **PLAN**. Acompaña a `NATIVE_INTEGRATION_PROPOSAL.md` (etapas E1–E8). 2026-10-07.
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
| S5.1 | E | 2×2 con 4 cámaras | 4 sesiones substream; reloj común; huecos por celda |
| S5.2 | E | cambiar una celda de cámara | la sesión de esa celda se cierra por identidad; las otras 3 no se tocan |
| S5.3 | E | cambiar layout 2×2 → 1×1 | quedan las sesiones de la celda visible; el resto se cierran; respuestas viejas descartadas (invariante 4) |
| S5.4 | E | cambiar de NVR/página durante carga | ninguna respuesta vieja inicia ni publica un stream |

### S6 — Calidad automática
| ID | Nivel | Escenario | Aserción | Origen |
|---|---|---|---|---|
| S6.0 | U | **vivo** 1×1: plan de layout pide foco HD y vuelve a sub al salir | transiciones 3×3→1×1→2×2 sin reiniciar HD de más | [existe] #180 (`liveLayoutQuality.test.ts`, `live1x1HdWiring.test.ts`, unitarias) |
| S6.1 | E | **grabaciones** 1×1 | pide main (alta calidad) automáticamente | [nueva] (criterio de #180 llevado al reproductor de grabaciones) |
| S6.2 | E | grabaciones en grilla | substream | [nueva] |
| S6.3 | E | main no listo o HEVC sin soporte | degrada a substream o `main_h264` sin error visible; vuelve a main al estar listo | [existe parcial] `fullscreen-fast-release` (HEVC ⇒ `main_h264`) |

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
| S9.4 | E | UI en cola | muestra "en cola" y arranca sola al liberarse cupo |

**Criterio de E1:** S1–S9 en verde en CI (niveles U/E/I), sin pruebas omitidas ni deshabilitadas.

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
| M6 | Calidad automática | 1×1 vs grilla con cámaras H.264 y HEVC | main en 1×1, sub en grilla, degradación correcta |
| M7 | Carga del servidor con detección | CPU/RAM/GPU/NPU con N cámaras analizadas (E7) | margen definido para crecer |
| M8 | Alineación de reloj NVR↔servidor | offset por NVR durante 7 días | desvío bajo el umbral, o aviso visible |

Estado actual de todas las filas M: **NO EJECUTADO — requiere hardware**.
