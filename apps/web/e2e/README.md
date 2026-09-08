# Test de integración en navegador — ciclo de vida de pantalla completa (ViewPlayerPage)

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
