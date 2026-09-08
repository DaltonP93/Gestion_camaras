// Vite config DEDICADO al harness de E2E (Playwright). No participa del build de
// producción (`vite build` usa vite.config.ts). Sirve una página mínima que monta
// el COMPONENTE REAL `ViewPlayerPage` bajo un MemoryRouter, para ejercer en un
// navegador real su ciclo de vida de sesiones (arranque/cierre por identidad,
// pantalla completa, visibilidad y bfcache) sin stack ni NVR.
//
// `VideoPlayer` se ALIASEA a un stub liviano: el objetivo es el ciclo de vida de
// la página (no el decodificador HLS, cubierto aparte y NO validable sin stream
// real). Todos los controles que el test acciona (maximizar/minimizar) son
// botones de la PÁGINA, no del reproductor, así que el stub no cambia el flujo.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const root = __dirname

export default defineConfig({
  root: path.resolve(root, 'e2e/harness'),
  plugins: [react()],
  resolve: {
    alias: [
      // El alias específico DEBE preceder al genérico `@`.
      { find: /^@\/components\/cameras\/VideoPlayer$/, replacement: path.resolve(root, 'e2e/harness/VideoPlayerStub.tsx') },
      { find: /^@\//, replacement: path.resolve(root, 'src') + '/' },
    ],
  },
  server: {
    port: 5199,
    strictPort: true,
    // El root del harness está en e2e/harness; hay que permitir leer src/ (fuera del root).
    fs: { allow: [root] },
  },
})
