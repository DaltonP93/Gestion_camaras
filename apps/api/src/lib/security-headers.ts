// Directivas CSP endurecidas (auditoría CSP — DEV 13).
//
// Objetivo: reducir `'unsafe-inline'` de forma verificablemente segura, sin
// romper la app. Se extrae aquí para poder verificarlo en test (server.ts no es
// importable: ejecuta main() al importarse).
//
// scriptSrc — SE ENDURECE:
//   Se retira `'unsafe-inline'`. El build de `apps/web` (Vite) NO emite scripts
//   inline: `dist/index.html` sólo referencia el bundle externo mismo-origen
//   (`<script type="module" src="/assets/...js">`). React usa eventos sintéticos
//   vía addEventListener, no atributos `on*=`. Por eso `scriptSrcAttr: 'none'`
//   bloquea manejadores inline sin afectar a la aplicación.
//
// styleSrc / styleSrcElem / styleSrcAttr — SE SEPARAN EN GRANULARES:
//   - styleSrc (fallback): `'self'` sin `'unsafe-inline'`.
//   - styleSrcAttr mantiene `'unsafe-inline'`: React aplica estilos mediante el
//     atributo `style=` en runtime, no cubrible por hash/nonce.
//   - styleSrcElem mantiene `'unsafe-inline'`: el motor de apariencia inyecta un
//     elemento <style> con CSS personalizado dinámico en runtime
//     (apps/web/src/lib/appearanceTokens.ts). Acotarlo a `'self'` rompería el
//     theming; se preserva el valor previo (documentado, no verificable sin
//     navegador).
//
// Resto de directivas (imgSrc, mediaSrc, connectSrc ws/wss, frameAncestors):
//   idénticas al histórico; el build no demuestra necesidad de ajuste.
export const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'"],
  styleSrcElem: ["'self'", "'unsafe-inline'"],
  styleSrcAttr: ["'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  mediaSrc: ["'self'", 'blob:'],
  connectSrc: ["'self'", 'ws:', 'wss:'],
  frameAncestors: ["'self'"],
}
