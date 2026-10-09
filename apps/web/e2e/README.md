# Pruebas de integración en navegador

## Grabaciones: reproductor real y API simulada

`recordings-continuity.spec.ts` monta **RecordingsPage de producción**. A diferencia
del harness de pantalla completa descrito abajo, usa su `<video>` real, sin stub,
y decodifica `fixtures/recording-synthetic.mp4` en Chromium. La API está interceptada
por `fixtures/recordings-mock.ts`: rutas inesperadas fallan. No se conecta a cámaras,
NVR ni servidores de producción.

Prueba registro del sucesor antes de cerrar el predecesor, tres bloques completos,
espera inicial de datos de 6 s (mayor que el bloque de 4 s), pausa, velocidad 2×,
cierre con respuesta tardía, rechazo 403 y salto automático de un hueco de 6 s.
La simulación de admisión sólo prueba el **orden HTTP**; no sustituye las pruebas
del servidor que exigen salida real de FFmpeg antes de liberar un lease.

El caso de tres bloques observa `requestVideoFrameCallback`, comprueba frames
presentados hasta el final de cada bloque y adjunta `synthetic-frame-timings.json`
al informe de Playwright. Los tiempos incluyen deliberadamente la espera inyectada
en el relevo; **no son un benchmark del NVR ni una promesa de latencia**. Un 200,
`loadedmetadata` o un `play()` resuelto no se cuentan como primer fotograma.

```bash
cd apps/web
npm run test:e2e -- e2e/recordings-continuity.spec.ts
```

### Procedencia del video de prueba

Patrón generado localmente, sin imágenes reales: VP9, fMP4, 160×90, 10 fps, 4 s,
sin audio, 35 384 bytes. SHA-256:
`83882c443945fc9b26ec7b130de9303222c74e3f0b31a2d32d32454aded0ed93`.
VP9 permite ejecutar el mismo test en Chromium de CI sin códecs propietarios.
**H.264/H.265 de los NVR, audio, GPU, Safari y dispositivos reales no quedan
validados por este fixture.** El servidor sigue usando sus códecs actuales.

Comando de generación (FFmpeg 6.1.1; no hace falta FFmpeg para correr los tests):

```bash
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=10' -t 4 -an \
  -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 80k -g 10 \
  -movflags frag_keyframe+empty_moov+default_base_moof recording-synthetic.mp4
```

## Pantalla completa (ViewPlayerPage)

Test de **integración en navegador** (Playwright + **Chromium real**) del contrato
de **liberación rápida** de sesiones de la vista `ViewPlayerPage` (Hito 5, C23).

**No es un E2E de stack completo:** la API está interceptada por un **mock estricto**
(rutas no previstas ⇒ 500 + fallo del test, nunca 200 vacío) y `VideoPlayer` está
reemplazado por un **stub**. Valida el CICLO DE VIDA del componente real en un
navegador real, no el reproductor ni el backend.

## Qué prueba (en navegador real, con API mock + VideoPlayer stub)

Monta el **componente de producción** `src/pages/ViewPlayerPage.tsx` (no una copia)
bajo un `MemoryRouter`, y ejerce por la UI y por eventos reales del DOM:

1. **Cierre deliberado ⇒ liberación inmediata por identidad.** Salir de pantalla
   completa emite el `DELETE` de la sesión HD con su `expectedStartAttemptId`
   exacto y razón `exit_fullscreen`, y la sesión deja de estar activa — sin
   esperar al TTL del servidor.
2. **Respuesta HD tardía ⇒ descarte por identidad.** Si el usuario sale antes de
   que resuelva el arranque HD, la respuesta tardía se cierra por su identidad y
   no se muestra ni queda como fuga (ninguna sesión vieja renueva/mata a otra).
3. **Cámara HEVC ⇒ HD `main_h264`.** El HD pedido para una cámara HEVC es el
   transcodificado, y su cierre viaja por esa identidad exacta.
4. **500 en el cierre ⇒ reintento sólo-cierre.** Un `DELETE` que responde 500 se
   reintenta (cola del controlador) hasta confirmar; nada queda activo.
5. **Handlers de bfcache.** Eventos `pagehide`/`pageshow` **sintéticos** ejercen la
   LÓGICA de los handlers: `pagehide` abandona la vista (cierra TODA la vista con
   `fetch keepalive`); `pageshow` persistido dispara la recarga (verificada por un
   GET `/views` adicional real). La expulsión/restauración REAL del bfcache del
   navegador es NOT_VALIDATED (sin control fiable en headless).

La red `/api/**` está interceptada por Playwright con un **mock estricto** (ver
`fixtures/api-mock.ts`): una ruta NO prevista responde 500 y hace **fallar** el
test (`unexpected` debe quedar vacío) — nunca un 200 vacío que enmascare llamadas.
El mock lleva la cuenta de sesiones «activas» por `startAttemptId` para detectar
fugas. `@/components/cameras/VideoPlayer` se aliasea a un stub liviano
(`harness/VideoPlayerStub.tsx`): el objetivo es el **ciclo de vida**, no el
decodificador. Todos los controles accionados (maximizar/minimizar) son botones de
la **página**, no del reproductor.

## NOT_VALIDATED (fuera de alcance de este harness)

Requieren el stack completo + NVR/stream reales y **no** se ejercen acá:

- API real (acá es un mock) y contrato HTTP real del backend.
- Frames HLS reales y corrección del reproductor HTML5.
- MediaMTX y procesos FFmpeg reales; conteo real de FFmpeg y **cupos** reales de
  transcode (liberación de cupo del lado servidor).
- NVR real y streams reales.
- **Latencia** real clic→primer-frame.
- Expulsión/restauración REAL del bfcache del navegador.

El TTL del servidor sigue siendo la garantía final; acá se prueba que el cliente
**libera antes** por identidad, no la contabilidad del servidor.

Los archivos bajo `e2e/` los transpila Playwright/Vite (esbuild): no pasan por el
`tsc` de la app (`tsconfig.json` incluye sólo `src`). La validación fuerte es la
ejecución en navegador real.

## Correr localmente

```bash
cd apps/web
# Usa el Chromium preinstalado del entorno (no ejecutar `playwright install`):
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
# En un entorno sin ese binario:  npx playwright install chromium && npm run test:e2e
```

El servidor del harness (`vite.config.e2e.ts`, puerto 5199) lo arranca y detiene
Playwright automáticamente. En CI corre el job `web-e2e` (instala Chromium con
`playwright install --with-deps chromium`).
