# E2E de navegador — ciclo de vida de pantalla completa (ViewPlayerPage)

E2E en **Chromium real** (Playwright) del contrato de **liberación rápida** de
sesiones de la vista `ViewPlayerPage` (Hito 5, ciclo C23).

## Qué prueba (en navegador real, sin stack ni NVR)

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
5. **bfcache.** `pagehide` abandona la vista (cierra TODA la vista con
   `fetch keepalive`); `pageshow` persistido fuerza una recarga limpia.

La red `/api/**` está interceptada por Playwright (ver `fixtures/api-mock.ts`), que
además lleva la cuenta de sesiones «activas» por `startAttemptId` para detectar
fugas. `@/components/cameras/VideoPlayer` se aliasea a un stub liviano
(`harness/VideoPlayerStub.tsx`): el objetivo es el **ciclo de vida**, no el
decodificador. Todos los controles accionados (maximizar/minimizar) son botones de
la **página**, no del reproductor.

## NOT_VALIDATED (fuera de alcance de este harness)

Requieren el stack completo + NVR/stream reales y **no** se ejercen acá:

- Frames HLS reales y corrección del reproductor HTML5.
- Latencia real clic→primer-frame.
- Conteo real de procesos FFmpeg y cupo real de MediaMTX (liberación de cupo del
  lado servidor). El TTL del servidor sigue siendo la garantía final; acá se prueba
  que el cliente **libera antes**, no la contabilidad del servidor.

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
