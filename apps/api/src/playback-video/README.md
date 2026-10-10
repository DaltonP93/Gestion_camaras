# Suite de reproducción con video real (entorno aislado)

Prueba el reproductor de **Grabaciones** de punta a punta con video real generado al
correr: la web REAL (bundle de producción de `apps/web`) en un navegador real, contra
el `server.ts` REAL (PostgreSQL y Redis efímeros del harness conjunto), con el FFmpeg
REAL que lanza la API, detrás de un **NVR simulado**. Mide continuidad entre bloques,
seek, velocidades, cámaras bloqueadas en grilla, liberación de sesiones, exportación
MP4/Range y revocación, y fija como pruebas las invariantes que hoy se cumplen y,
con **trinquetes**, el valor actual de cada defecto conocido (para que no empeore).

Las mediciones son del entorno simulado: **no** son afirmaciones de rendimiento con
NVR reales (eso es la parte M de `docs/frigate/PLAYER_TEST_PLAN.md`).

## Cómo correrla

Requisitos: `ffmpeg`/`ffprobe` en el PATH (en CI: `apt-get install ffmpeg`),
`npm ci` en `apps/api` y en `apps/web` (la suite usa `vite`, `@vitejs/plugin-react`,
`tailwindcss` y `playwright-core` desde `apps/web/node_modules`, sin agregarlos a la
API), `prisma generate`, un Chromium de Playwright o Google Chrome, y PostgreSQL y
Redis **desechables** en loopback:

```bash
cd apps/api
REDIS_TEST_URL=redis://127.0.0.1:6379 \
DATABASE_URL_TEST=postgresql://ci:ci@127.0.0.1:5432/ci \
REQUIRE_REAL_REDIS=1 REQUIRE_REAL_PG=1 REDIS_TEST_DISPOSABLE=1 PG_TEST_DISPOSABLE=1 \
npm run test:video                     # todo (~8 min con 4 vCPU)
npm run test:video -- grilla           # un archivo
RUN_KNOWN_DEFECTS=1 npm run test:video # además, los defectos conocidos como pruebas (fallan hoy)
npm run typecheck:video                # tipos de la suite (no entra en `npm run build`; CI lo corre en el job api)
```

`npm test` NO la levanta (configuración propia `vitest.video.config.ts`, archivos
`*.video.ts`). Las métricas puras, el checksum de la franja y el análisis del netlog
(`lib/metrics.test.ts`) sí corren en `npm test`.

| Variable | Efecto |
|---|---|
| `VIDEO_BROWSER=chrome` | Google Chrome (canal `chrome`): decodifica H.264 → el comando REAL de la API llega al navegador sin desvío. Por defecto, Chromium de Playwright (`/opt/pw-browsers/chromium`, `PW_CHROMIUM_PATH` o el canal `chromium`). |
| `VIDEO_REQUIRE_H264=1` | Falla si el navegador no decodifica H.264 (en vez de aplicar el desvío VP9). |
| `VIDEO_REPORT_DIR=<dir>` | Dónde escribir los reportes (por defecto `apps/api/.video-reports/`, ignorado por git). |
| `VIDEO_WEB_MODE=dev` | Web con `vite` en modo dev en vez del bundle de producción (StrictMode duplica efectos: no usar para medir). |
| `VIDEO_FIRST_BYTE_TIMEOUT_MS` | Watchdog de primer byte de la API en la suite (por defecto 8000; producción 25000). |
| `VIDEO_HEADED=1` | Navegador con ventana (bajo `xvfb-run`) sólo para mirar; no cambia lo que se mide. |
| `RUN_KNOWN_DEFECTS=1` | Ejecuta los defectos conocidos como pruebas (ver abajo). |

CI: job `playback-video` de `.github/workflows/ci.yml` (matriz `chromium` bloqueante
y `chrome` no bloqueante hasta confirmar estabilidad), sube sólo los reportes. El
chequeo de tipos de la suite (`npm run typecheck:video`) va en el job `api`.

## Qué es real y qué se simula

```
navegador (Chromium/Chrome, Playwright) ── web REAL (vite preview del bundle)
     │  /api, /ws (proxy de vite, mismo origen; cookies y CSRF reales)
     ▼
server.ts REAL (harness conjunto: PG/Redis efímeros, jobs y MediaMTX en vivo dobles)
     │  hikvision.ts REAL ──HTTP──► ISAPI simulado (loopback; IP del NVR 10.255.0.10 redirigida)
     │  spawn('ffmpeg') ──PATH──► shim nvr-sim/bin/ffmpeg ──exec──► ffmpeg REAL
     ▼                                         ▲ entrada: socket UNIX con MPEG-TS a 1×
   fMP4 al navegador                     productor (nvr-sim/producer.mjs, ffmpeg -readrate 1)
```

- **Real:** web (bundle de producción con su CSS), `server.ts`, rutas, admisión y
  leases por NVR, cliente ISAPI `services/hikvision.ts` (Digest, paginado, guarda
  SSRF), `rtsp-probe`, `child_process`, el comando FFmpeg exacto que arma la API (su
  PID, señales y código de salida), PostgreSQL/Redis, cookies/CSRF/JWT.
- **Simulado (sin tocar código de producción):**
  - `nvr-sim/bin/ffmpeg` y `ffprobe`: van primero en el PATH sólo del proceso de la
    suite. Sin `rtsp://` hacen `exec` del binario real con los mismos argumentos.
    Con `rtsp://` traducen la pista y `starttime/endtime` a la grabación sintética
    (`plan.mjs`): el ffmpeg real recibe **los mismos argumentos** salvo la entrada
    (`-f mpegts -i unix:<socket privado>`) y las opciones exclusivas del demuxer RTSP
    (`-rtsp_transport`, `-timeout`, `-reorder_queue_size`; ffmpeg 6.1 sale con código 8
    si las recibe con mpegts). Falla cerrado: host distinto del NVR simulado →
    `Connection refused`; pista sin grabación → 404. Nunca abre puertos.
  - `nvr-sim/producer.mjs`: entrega la ventana pedida a ritmo real (`-readrate 1`,
    ráfaga inicial 0,5 s, `-c copy` ⇒ arranca en el keyframe ≤ `starttime`), con fallas
    por pista: `noData`, `cutAfterSec`, `closeAfterSec`, `startDelayMs`, `rtspError`
    (401/404/453 con el texto que reconoce `classifyRtspError`), `gapPolicy`, `readrate`.
    **Emula el `-timeout` de 60 s de RTSP** (lo quita el shim): si el NVR queda mudo
    más que eso, cierra la conexión. Muere si muere su FFmpeg (no deja huérfanos aunque
    la API use SIGKILL).
  - `nvr-sim/isapi-sim.ts`: `ContentMgmt/search` paginado (`MORE`/`OK`/`NO MATCHES`,
    2 resultados por página), `dailyDistribution` y `System/time`, con Digest y a
    partir del **mismo manifiesto** que el shim.
  - `nvr-sim/net-redirect.ts`: redirige SÓLO `10.255.0.10:80` al ISAPI simulado (la
    guarda SSRF rechaza loopback y TEST-NET, por eso la IP ficticia es RFC1918) y
    bloquea cualquier otro destino o puerto loopback no listado (el centinela del
    harness dejaría pasar todo loopback, incluido un proxy de salida del entorno).
    Ambos interceptan `net.Socket` del proceso de la suite: **no ven al navegador**.
- **Aislamiento del navegador** (`lib/video-env.ts`, `lib/netlog.ts`): la web real
  pide Google Fonts (`index.html`) y Chromium/Chrome, además, consulta DNS/DoH y
  servicios de fondo (hora de red). Se lanza con
  `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`: ningún nombre ni IP
  literal fuera de 127.0.0.1 resuelve (ERR_NAME_NOT_RESOLVED, sin consultar DNS ni
  DoH). Los pedidos de las páginas que intentan salir se registran sin interceptar
  (`context.route` pasaría por Node cada pedido del stream y de la API y sumaría
  latencia a lo medido) y el **netlog** del navegador (`--log-net-log`, en el
  directorio temporal) prueba al cerrar que no hubo ningún socket fuera de loopback,
  incluido el servicio de red. La tipografía Inter cae a la de reemplazo: no cambia
  ninguna medición (los clics en la línea de tiempo usan la caja real).
- **Harness:** `src/security-joint/{harness,infra-doubles}.ts` copiados byte a byte
  de la suite conjunta (no se modifican). Lo específico va en `lib/mocks.setup.ts`:
  sólo se reemplazan jobs, re-registro y `services/stream` (MediaMTX en vivo),
  **conservando `getRtspTimeoutOption` real** (el doble devuelve `'timeout'` sin guion
  y FFmpeg fallaba con ese argumento suelto → 504 en la primera corrida).
- **Proxy de la web:** `vite preview` con un hook que destruye el pedido al backend si
  el cliente cierra antes de la respuesta (vite no lo propaga: el backend veía el
  `close` recién al responder, 4,18 s después; nginx sí lo propaga por defecto).

Por qué vitest + `playwright-core` y no `@playwright/test`: el `server.ts` real tiene
que correr en el MISMO proceso que la suite para reemplazar sólo jobs/MediaMTX con
`vi.mock` (como la suite conjunta) y leer su estado interno (leases, sesiones) sin
hooks en producción. La suite sigue siendo Playwright (navegador, selectores,
eventos de red), con configuración propia.

## Video que dice qué instante se muestra

`media/generate.ts` genera por canal segmentos `testsrc2` 640×360 a 25 fps, H.264
sin cuadros B (`-bf 0`), GOP fijo de 2 s, como un NVR. Cada cuadro lleva en sus 24
filas superiores una **franja** (`media/timecode.ts`): 40 bloques de 16 px con
referencias blanca/negra, 24 bits de número de cuadro desde 2026-10-01T00:00Z, 4 bits
de canal y 8 de checksum (más un texto `CH1 2026-10-01 10:00:07 f8` para mirarlo a
ojo). El checksum es `(101 + Σ bitₖ·Wₖ) mod 256` con un peso impar distinto por bit
de datos: detecta todo error de lectura de 1 o 2 bloques (prueba en `metrics.test.ts`
que invierte cada bit y cada par). El anterior, `(F·7 + canal·31 + 101) mod 256`, no
protegía los bits 8–23 del cuadro (7·2⁸ ≡ 0 mod 256): un error ahí movía el instante
leído en múltiplos de 10,24 s y pasaba como cuadro válido (salto o retroceso falso en
vez de "ilegible"). Al generar, se decodifica un segmento entero para comprobar que
generador (`geq`) y decodificador coinciden. El decodificador es UN texto JavaScript
que se inyecta en el navegador y se evalúa en Node: en el navegador se lee cada
cuadro presentado
(`requestVideoFrameCallback` + `drawImage` + `getImageData`), con lo que se sabe qué
instante y qué cámara muestra cada celda en cada momento.

Grabaciones por defecto (hora de pared del NVR en componentes UTC, la convención de
`utils.ts`): canal 1 A 10:00:00–:20, B :20–:40 (contiguo), hueco real de 6 s, C
:46–10:01:06; canales 2 y 4, un bloque 10:00:00–10:01:00; canal 3, 10:00:00–10:02:00
(más largo que corte + timeout RTSP, ver S5). Se generan en un directorio
temporal (`vcv-*`) al empezar y **se borran al terminar** (invariante 6: nada de video
ni imágenes se versiona ni queda en el reporte). Si una corrida muere sin teardown
(SIGKILL, timeout externo, reinicio), la siguiente barre al empezar los `vcv-*` con
más de 30 min sin escrituras y sin procesos que los usen (`preparacion.txt` los lista).

## Escenarios

`scenarios/*.video.ts`; cada archivo levanta su propio entorno (API, web, navegador).

| Archivo | Escenario | Qué hace |
|---|---|---|
| `reproduccion` | S1 continuidad | deep link `/recordings?cameraId=&t=10:00:02` en 1×1; reproduce A→B (contiguo) y B→C (hueco real de 6 s) sin clic |
| | S0 comando H.264 | re-ejecuta SIN desvío VP9 el comando exacto que armó la API en S1 y lee la franja de cada cuadro de la salida (ffprobe + decodificador) |
| | S2 seek | clic en la línea de tiempo con el bloque en curso; 5 seeks encadenados en ~1 s; botones −10/+10 s |
| | S4 velocidades | 1× → 2× → 4× → 1/2× (la fuente entrega a 1×); salir de Grabaciones |
| `grilla-liberacion` | S5/S9 grilla | 2×2: canal 1 sano, 2 bloqueado (acepta y no entrega), 3 cortado a los 8 s sin cerrar, 4 con 404 RTSP; espera el `-timeout` RTSP de la celda cortada |
| | S7 liberación | seek, cambio de cámara, navegación SPA, navegación completa en backpressure (1/2×), cierre de pestaña; tiempo hasta la salida REAL de cada FFmpeg; mecanismo SIGTERM/SIGKILL aislado |
| `exportacion-revocacion` | X1 exportación | "Generar MP4…" con relevo en curso y en pausa; franja y pts del MP4 descargado; Range `0-`, `100-199`, `-1000`, fin > tamaño |
| | S8 revocación | AUDITOR con `canPlayback` sólo en la cámara 4: quitar el permiso y hacer logout a mitad de la reproducción; qué sigue sirviendo (stream, archivo, descarga) y si FFmpeg sigue vivo |

Además, cada archivo afirma el **aislamiento** (`afterAll`, reporte
`<archivo>--aislamiento.json`): Node sin conexiones bloqueadas por la suite ni por el
centinela (I-NET-1/2), netlog del navegador legible y con tráfico loopback (no es una
prueba vacía, I-NET-3), **cero tráfico del navegador fuera de loopback** (I-NET-4:
conexiones TCP y sockets UDP que envían datos) y **cero consultas DNS-over-HTTPS**
(I-NET-5). Un `connect()` UDP sin envío no emite paquetes (fija el destino y consulta la
tabla de rutas): Chromium lo usa para sondear si hay IPv6 global
(`[2001:4860:4860::8888]:443`, visto en el runner de CI). No cuenta como tráfico y se
informa en `udpConnectSinEnvio`.
Los intentos bloqueados por el resolvedor (Google Fonts, hora de red) se informan.

DoH y QUIC van apagados en el navegador (`--disable-features=…,DnsOverHttpsUpgrade`
sumado a la lista de Playwright, y `--disable-quic`). Con un resolvedor del sistema
"conocido" (como el de los runners de GitHub), Chromium/Chrome suben solos a DoH y se
conectan al servidor por **IP literal**, que `--host-resolver-rules` no cubre: la
primera corrida de CI de este PR lo detectó (I-NET-4: `2001:4860:4860::8888:443` por
TCP y UDP). En este contenedor el intento no llegaba a abrir un socket (sin ruta), por
eso I-NET-5 cuenta las consultas DoH del netlog y no depende de la red disponible.

### Invariantes (pruebas normales: deben cumplirse hoy)

Se registran con `expect.soft` (el escenario sigue midiendo aunque una falle).

- Cada celda muestra sólo **su** cámara y sólo instantes **grabados** (nada fabricado);
  el instante mostrado nunca retrocede; 0 cuadros ilegibles (I-S1-1/2/3/5, I-S2-8,
  I-S4-1/2, I-S5-1, I-X1-2).
- Continúa sola por bloques contiguos y con hueco; una sola sesión por bloque; ≤ 2
  FFmpeg/leases en el relevo (I-S1-4/6/7).
- **Ningún lease se libera antes de que su FFmpeg termine** (muestreo cada 250 ms;
  I-S1-9, I-S5-7, I-S7-7) y al terminar el rango se libera todo sin acción (I-S1-8).
- Seek fuera de lo cargado: primer cuadro en [−100 ms, GOP + 500 ms] del pedido, ≤ 15 s,
  el FFmpeg anterior termina ≤ 5 s, queda 1 sesión; seeks encadenados: ninguna sesión
  vieja publica video y queda 1 sesión en el último punto (I-S2-1…7). La medición
  del −10 s es válida: se hace con `currentTime` ≥ 12,5 s, lejos del inicio de la
  sesión (I-S2-11), y tras cada botón ±10 s la celda vuelve a reproducir sola
  (I-S2-12). Las antiguas I-S2-9 ("Retroceder 10 s funciona") e I-S2-10 ("los
  botones ±10 s no abren sesiones nuevas contra el NVR") eran **falsas**: se cumplían
  sólo porque el −10 s se hacía con `ct` ≈ 11 s y el destino caía a 1,2 s del inicio
  de la sesión (ir al inicio pasaba por "−10 s" y el principio del stream seguía en
  la caché del navegador). Ahora son los defectos D-S2-b y D-S2-d.
- El `<video>` toma la velocidad elegida; a 1× y 1/2× la tasa efectiva es la nominal
  (I-S4-3/4).
- Grilla: la cámara sana sigue pese a las otras tres; la cortada mostró su video; nunca
  se supera el límite del NVR; las celdas sin video muestran un problema; con el NVR
  mudo, el `-timeout` RTSP termina FFmpeg y libera el lease sin acción (I-S5-2…8).
- Liberación ≤ 5 s y sin huérfanos en seek, cambio de cámara, navegación SPA y
  completa, cierre de pestaña y al cerrar la grilla (I-S7-1…5, I-S5-6, I-S4-5); y al
  final de cada corrida, 0 procesos del simulador vivos (global-setup). Control del
  mecanismo: FFmpeg con stdout drenado sale con SIGTERM en < 1 s (I-S7-8).
- El comando H.264 real: Constrained Baseline, cada cuadro conserva instante y canal,
  termina en el fin pedido (I-S0-1/2/3).
- MP4 exportado: sólo canal 1 y lo grabado, cubre la ventana sin saltos; Range básico
  correcto; descarga = archivo (I-X1-1…5).
- RBAC: sin `canPlayback` → 403; tras quitar el permiso o hacer logout no se abren
  sesiones nuevas (I-S8-1/2/3).
- Aislamiento de red de Node y del navegador (I-NET-1…4, arriba).

### Trinquetes (invariantes: el valor de hoy más un margen)

Cada defecto conocido exige el objetivo IDEAL, que hoy falla, así que por sí solo no
avisa si el reproductor **empeora**: con mutaciones temporales del reproductor (timer
de continuidad 6 s antes, reloj de la UI +1 h, inicio de sesión +10 s) la suite
anterior quedaba en verde. Los trinquetes fijan el valor actual con margen; si mejora,
se ajusta el número (y el defecto, cuando se cumpla el objetivo, pasa a invariante).

| Id | Fija | Umbral | Hoy |
|---|---|---|---|
| R-S1-a / R-S0-a | primer cuadro − inicio pedido (S1 por sesión; comando H.264 sin navegador) | ≤ 2,5 s | +2,0 s |
| R-S1-b | imagen congelada en el borde contiguo | ≤ 8 s | 4,9–5,1 s |
| R-S1-c | video perdido por borde (además del hueco real) | ≤ 5 s | 3,8–4,2 s |
| R-S1-d | corte anticipado del bloque por el relevo | ≤ 3 s | 1,8–2,2 s |
| R-S1-e / R-S4-b | p95 \|reloj − cuadro\| a 1× (S1 y S4) | ≤ 5 s | 3,3–3,7 s |
| R-S2-d | botones ±10 s: sesiones NVR / GET del stream / imagen congelada por clic | ≤ 1 / ≤ 2 / ≤ 12 s | −10 s: 1 / 2 (409 y 200) / 7,7–7,8 s; +10 s: 0 / 0 / 0,07 s |
| R-S2-e | FFmpeg lanzados por 5 seeks encadenados | ≤ 5 | 4–5 |
| R-S4-a | video salteado: 2× en 10 s / 4× en 12 s | ≤ 1 s / ≤ 20 s | 0 / 16,4–17,5 s |
| R-S7-b | salida de cada FFmpeg anterior (seek, cambio de cámara, SPA, completa, cierre) | ≤ 3 s | 2,0–2,2 s (SIGKILL de la gracia de 2 s) |
| I-S5-8 (ya existía) | liberación de la celda cortada por el `-timeout` RTSP | ≤ 65 s | 60,0 s |

### Defectos conocidos (opt-in: `RUN_KNOWN_DEFECTS=1`)

Donde el reproductor actual no cumple un objetivo razonable, la prueba **espera el
comportamiento correcto** con el umbral sin debilitar y queda en el reporte como
`DEFECTO` con el valor medido. Sólo con `RUN_KNOWN_DEFECTS=1` se ejecutan como pruebas
(y fallan hoy, con el valor medido en el mensaje). Rangos de 10 corridas completas (6 de
la versión anterior y 4 de esta; el ±10 s, de las 5 con la medición nueva).

| Id | Objetivo | Hoy (simulado) |
|---|---|---|
| D-S1-a / D-S0-a | cada sesión empieza en el instante pedido (≤ 500 ms) | +2,0 s: se pierde el primer GOP (`-fflags +nobuffer` + `discardcorrupt` con entrada que arranca en keyframe; sin `nobuffer` el primer cuadro es el keyframe anterior) |
| D-S1-b | pausa entre grabaciones consecutivas ≤ 1 s | 4,9–5,1 s de imagen congelada en el borde contiguo (= espera inicial de la sesión siguiente; no hay precarga) |
| D-S1-c | no saltear video en los bordes (≤ 500 ms) | 3,8–4,1 s perdidos por borde (~2 s de D-S1-d + 2 s de D-S1-a), también además del hueco real de 6 s |
| D-S1-d | el relevo no corta el bloque antes de su fin | 1,8–2,1 s antes. Por lectura del código: el timer de continuidad se arma al pedir el preview (antes del primer cuadro) con el largo del bloque + 1 s y no se reprograma al empezar a avanzar, así que corta ≈ espera inicial (~5 s) − 1 s − 2 s (GOP perdido) antes del fin |
| D-S1-e | reloj de la UI = cuadro (p95 ≤ 1,5 s) | p50 2,9–3,2 s, p95 3,4–3,7 s (el reloj va adelantado) |
| D-S2-a | "Avanzar 10 s" llega a +10 s sin retroceder | nunca llega: desde `ct` 2,0–2,2 s (la sesión que dejó el −10 s), `currentTime` cae en 0 y el cuadro **retrocede** 2,0–2,2 s al inicio de la sesión (10:00:48), sin pedidos nuevos. Causa medida: el `<video>` del stream fMP4 progresivo tiene `seekable` = [0, 0] (`buffered` 0–3,6 s), así que todo cambio de `currentTime` cae en 0 |
| D-S2-b | "Retroceder 10 s" dentro de lo descargado muestra −10 s (S2.1: sólo `currentTime`; ±0,5 s, `ct` = antes − 10 s ± 0,5 s, nada por debajo del destino − 0,5 s) | nunca llega: desde `ct` 13,1–13,2 s (`buffered` 0–14,9 s, `seekable` [0, 0]) va al **inicio del bloque** (10:00:48, 3,1 s antes del destino) y por otra sesión: el navegador vuelve a pedir el stream (`bytes=0-`), la API corta el FFmpeg y responde 409, la UI abre un preview nuevo; 7,7–7,8 s de imagen congelada |
| D-S2-c | el reloj acompaña los botones ±10 s | +10 s: p50 5,5–5,6 s, p95 5,9–6,0 s; −10 s: casi sin cuadros en los 6 s siguientes (congelado), p50 3,3 s |
| D-S2-d | los botones ±10 s no vuelven a pedir el stream ni abren otra sesión NVR (S2.1) | −10 s: 2 GET del stream (409 y 200) y 1 FFmpeg/sesión NVR nueva en cada corrida; +10 s: 0 (el principio del stream seguía en caché). Antes era la invariante I-S2-10 |
| D-S2-e | seeks encadenados no abren una sesión NVR por clic | 4–5 FFmpeg para 5 clics en ~1 s |
| D-S4-a | a 2×/4× no se saltea video grabado | 2×: 0; 4×: 16,4–17,5 s salteados en 12 s (el timer de continuidad se arma por `restante/velocidad` sobre una fuente que entrega a 1×) |
| D-S4-b | reloj = cuadro a toda velocidad | p95: 1× 3,3–3,7 s; 2× 9,9–10,6 s; 4× 18,5–21,7 s; 1/2× ~21 s (arrastra lo acumulado) |
| D-S5-a | el error de una celda no queda tapado | "Error" (bloqueada a los 27,0–27,3 s; 404 a los 3,2–3,5 s) pasa a "Sin avance" a los 30,2–30,4 s: el timer de 30 s previo a metadata no se cancela con el error (`RecordingsPage.tsx`, `armStallTimer`) |
| D-S5-b | sesión NVR de una celda sin datos liberada ≤ 30 s del corte | 60,0 s (sólo por el `-timeout` RTSP emulado; la API no tiene watchdog de progreso tras el primer byte) |
| D-S5-c | sólo pistas que la búsqueda devolvió (§1.1) | pide `202`/`402` (subflujo derivado a ciegas) |
| D-S5-d | celda congelada no muestra "● Play" (≤ 10 s) | 58,6–58,8 s congelada en "● Play" (no hay detección de estancamiento a mitad de reproducción) |
| D-S5-e | fin prematuro del stream ≠ "Sin grabación" | último cuadro 10:00:08.4 de un bloque hasta 10:02:00 → "Sin grabación", 0 reintentos |
| D-S7-a | sin entradas de preview retenidas tras liberar | 2–3 entradas sin proceso ni lease, hasta el TTL de 30 min |
| D-S7-b | FFmpeg sale con SIGTERM (≤ 1 s) | 2,03–2,16 s en TODOS los cierres: la API hace `stdout.unpipe(res)` y SIGTERM; FFmpeg queda bloqueado escribiendo, ignora SIGTERM y lo mata el SIGKILL de la gracia (control aislado: drenando sale en ~50 ms). Retiene el lease 2 s y corta RTSP sin TEARDOWN |
| D-X1-0 | "Generar MP4…" sobrevive al relevo de bloque | el enlace no aparece; la sesión VOD sigue en el servidor |
| D-X1-a | la línea de tiempo del MP4 exportado es la de grabación | `-use_wallclock_as_timestamps 1`: 13 cuadros en los primeros 50 ms (ráfaga inicial), desvío pts−grabación de 0,49–0,50 s |
| D-X1-b | `Range: bytes=-N` = últimos N bytes | devuelve `bytes 0-N` (el principio) |
| D-X1-c | Range con fin > tamaño se recorta | 416 `bytes */tamaño` |
| D-S8-a/c | quitar `canPlayback` / logout corta la reproducción en curso | FFmpeg sigue vivo y el navegador sigue recibiendo cuadros |
| D-S8-b/d | tras revocar/logout las URL con token dejan de servir | stream (abre otra sesión RTSP), archivo y descarga responden 2xx (tokens de 30 min/30 min/24 h no revalidan sesión ni permiso) |

## Resultados de referencia (este entorno)

Contenedor de 4 vCPU, ffmpeg 6.1.1 (Ubuntu 24.04), Chromium 141 de Playwright (desvío
VP9), bundle de producción. Cada corrida: 3 archivos, 8 pruebas de escenario,
471–475 s (generación de medios 25,9–29,0 s, build de la web 8,7–11,8 s). Con el
código final: **3 corridas completas seguidas con 74/74 invariantes en verde** (11
trinquetes y 12 de aislamiento incluidos) **y 0 procesos del simulador vivos al
terminar**, los mismos 28 defectos presentes con valores estables; la tercera, con
`RUN_KNOWN_DEFECTS=1`: 28 pruebas de defecto en rojo con el valor medido y las 8
pruebas de escenario en verde. Rangos de esas corridas y de una cuarta previa al
ajuste del −10 s (idéntica en todo lo demás):

| Medición | Valores |
|---|---|
| Tiempo al primer cuadro por sesión (deep link / relevo) | 4,98–5,10 s |
| Primer cuadro − inicio pedido | +2,00 s en todas las sesiones (y en el comando H.264 sin navegador: 450/450 cuadros) |
| Borde contiguo A→B: congelado / perdido | 4,94–4,97 s / 3,88–3,92 s |
| Borde con hueco real de 6 s: congelado / perdido además del hueco | 4,95–4,99 s / 3,84 s |
| Relevo: corte antes del fin del bloque | 1,84–1,92 s |
| Cuadros leídos en el navegador (S1) / ilegibles | 1256–1257 / 0 |
| Reloj de la UI − cuadro a 1× (S1) | p50 2,94–2,98 s, p95 3,42 s |
| Seek por línea de tiempo: error / tiempo al primer cuadro / salida del FFmpeg anterior | +219 ms (keyframe siguiente) / 5,00–5,06 s / 1,73–1,75 s |
| 5 seeks encadenados: error del último / FFmpeg lanzados / cuadros viejos | +1,58 s (keyframe siguiente) / 5 / 0 |
| "Retroceder 10 s" desde `ct` 13,1–13,2 s | va al inicio del bloque (10:00:48) por OTRA sesión (GET → 409, preview nuevo); 7,77–7,80 s congelado |
| "Avanzar 10 s" desde `ct` 2,0–2,2 s | `currentTime` → 0: retrocede 2,0–2,2 s, sin pedidos; `seekable` = [0, 0] |
| Tasa efectiva 1× / 2× / 4× / 1/2× | 1,00 / 1,03–1,06 / 2,69–2,87 / 0,50 (4×: 16,4–16,7 s salteados en 12 s) |
| Grilla: cámara sana con 3 fallas | 37,96 s de grabación mostrada, canal correcto; máx. 4 leases y 3 FFmpeg |
| Grilla: intentos por pista | 101: 2, 201: 3, 202: 1 (a ciegas), 301: 1, 401: 3, 402: 1 (a ciegas) |
| Grilla: sesión cortada liberada por el `-timeout` RTSP | 60,00–60,02 s después del corte, lease liberado; 58,6–58,7 s en "● Play" congelada |
| Liberación (seek, cambio de cámara, SPA, completa en backpressure, cierre) | 1,92–2,10 s; salida de FFmpeg 2,02–2,08 s, siempre por SIGKILL (D-S7-b) |
| Liberación al terminar el rango / al cerrar la grilla | 9–13 ms / 9–11 ms |
| MP4 exportado (20 s) | 500/500 cuadros, canal 1, sin saltos; desvío pts − grabación 0,49–0,50 s |
| Revocación (permiso o logout) | FFmpeg vivo y 249–251 cuadros más en el navegador a los 10 s |
| Aislamiento | 0 sockets fuera de loopback (netlog del navegador en los 3 archivos y monitor externo de `/proc/net`); bloqueados por el resolvedor: Google Fonts (página) y 8 orígenes de fondo del navegador (DoH `dns.google`, `clients2.google.com`, `accounts.google.com`, …) |

Control de los trinquetes con mutaciones TEMPORALES (restauradas desde `HEAD` al
terminar cada corrida; el código de producción quedó intacto): timer de continuidad
6 s antes (`RecordingsPage.tsx`) → fallan R-S1-c (9,9 s perdidos por borde) y R-S1-d
(7,9 s); reloj de la UI +1 h → falla R-S1-e (p95 3 603 s); inicio del preview +10 s
(`routes/recordings.ts`) → fallan R-S1-a (+12 s), R-S1-c y R-S1-e; gracia de SIGKILL
de 4 s (sólo configuración, `RECORDINGS_PREVIEW_KILL_GRACE_MS=4000`) → falla R-S7-b
(4,02–4,07 s) mientras I-S7-1…5 (≤ 5 s) siguen en verde. Antes de los trinquetes,
las tres primeras dejaban la suite en verde.

## Reportes

Por corrida, en `VIDEO_REPORT_DIR/<fecha>/` (por defecto `apps/api/.video-reports/`):
`preparacion.txt` (versión de ffmpeg, tiempos de generación y build), un JSON por
escenario (contexto, checks con objetivo y medido, métricas, notas, rótulos de cada
celda, arranques de preview, eventos de red y del simulador, muestras de la API),
`resumen.json` y `RESUMEN.md`. Todo saneado: tokens de URL reemplazados, sin
credenciales (las del NVR son ficticias y no se escriben), sin video ni imágenes.

Métricas principales: tiempo detenido y salto por borde (`bordes`), pérdida al
principio/final y tiempo al primer cuadro por sesión (`sesiones`), error de seek y
TTFF (`lineaDeTiempo`, `seeksEncadenados`), tasa efectiva/salteado/reloj por
velocidad (`velocidades`), estado por celda y rótulos (`celdas`, `celdaCortada`),
tiempos de liberación y de salida de FFmpeg (`liberacion`), contenido/pts/Range del
MP4 (`mp4`, `range`) y supervivencia a la revocación (`revocarPermiso`, `logout`).

## Selectores (no hay `data-testid`)

| Elemento | Selector |
|---|---|
| Video por celda | `video` (orden del DOM = celda) |
| Reloj | `span.font-mono` con `/^\d\d\/\d\d \d\d:\d\d:\d\d$/` (resolución 1 s) |
| Rótulo de celda | barra `div.grid > div.relative div.absolute.top-0`: "● Play", "Buffering…", "Sin avance", "Error", "Sin grabación", "Esperando…" |
| Controles | `button[title="Reproducir"]`/`"Pausar"`, `"Avanzar 10 s"`, `"Retroceder 10 s"`, `"Velocidad 2×"` |
| Layout / cámaras | `button[title="Cuatro cámaras"]`; `span[title="Incluir en la búsqueda"]` dentro del botón `Cam N` |
| Búsqueda | `input[type="datetime-local"]` y el botón "Buscar" |
| Línea de tiempo | regla `div.flex.flex-shrink-0.border-b.h-6 > div` (2.º hijo) |
| Entrada directa | deep link `/recordings?cameraId=&t=` (busca −2/+10 min y reproduce) |

Si cambia la UI y se rompe un selector, la prueba falla por timeout con el nombre de
lo que esperaba. Unos `data-testid` inertes los harían menos frágiles.

## Límites y desvíos (medidos)

1. **Códec en Chromium de Playwright:** no decodifica H.264 ni AAC (`canPlayType`
   vacío; VP9 "probably"). Sólo en ese caso el shim pasa la **salida** de FFmpeg a
   VP9/Opus (`libvpx-vp9 realtime`); el resto del comando es el de la API. S0 valida
   aparte el comando H.264 real cuadro por cuadro. Con `VIDEO_BROWSER=chrome` (job
   `chrome` de CI) no hay desvío.
2. **El NVR es una hipótesis parametrizada:** arranque en keyframe ≤ `starttime`,
   ráfaga inicial, ritmo 1×, GOP 2 s, huecos como ausencia de segmentos, 404 sin
   grabación, timeout RTSP como EOF (con RTSP real es ETIMEDOUT; un NVR que sigue
   respondiendo keepalive sin entregar video podría no dispararlo nunca:
   `ioTimeout: false`). La pérdida del primer GOP y los saltos a >1× dependen de que
   el NVR entregue a 1× desde un keyframe: **confirmar en M** (ritmo de entrega,
   ráfaga, GOP real, keepalive).
3. **Pestaña oculta: no reproducible con Playwright acá.** `visibilityState` sigue
   `visible` con `bringToFront` de otra pestaña, `window.open` + `Target.activateTarget`,
   ventana minimizada por CDP, en headless y con ventana bajo Xvfb, con y sin los flags
   de backgrounding; `Page.setWebLifecycleState('frozen')` no congela una página
   visible (sus timers siguen). Grabaciones no escucha `visibilitychange` ni
   `pagehide`, así que el efecto depende de las políticas del navegador (throttling de
   timers del relevo, pausa de video en segundo plano): medición local/manual con un
   Chrome real.
4. **Proxy:** la liberación por cierre depende de que el proxy propague el aborto
   (vite con el hook; nginx por defecto). Medir también detrás de nginx (local).
5. **Tiempos:** las aserciones son sobre invariantes con tolerancias, no latencias
   absolutas. El límite de 600 pedidos/min por IP no apareció (todo por 127.0.0.1).
6. **Sólo local:** 30 min continuos, matriz completa de velocidades, grillas 3×3/4×4
   (CPU), nginx al frente, zonas horarias, perfiles de CPU.

## Archivos

- `media/`: generador (`generate.ts`), franja y decodificador (`timecode.ts`),
  lectura de archivos (`decode.ts`).
- `nvr-sim/`: shim `bin/ffmpeg` y `bin/ffprobe`, `plan.mjs`, `producer.mjs`,
  `isapi-sim.ts`, `net-redirect.ts`.
- `lib/`: `global-setup.ts` (medios, build de la web, resumen, huérfanos, borrado),
  `mocks.setup.ts`, `video-env.ts` (entorno por archivo), `browser-page.ts`
  (muestreador y captura de red), `metrics.ts` (+ `metrics.test.ts`),
  `scenario-utils.ts`, `report.ts`, `netlog.ts` (sockets del navegador),
  `http-probe.ts`, `procs.ts`, `web.ts`, `run-config.ts`.
- `scenarios/*.video.ts`; configuración `apps/api/vitest.video.config.ts` y
  `apps/api/tsconfig.video.json`.
