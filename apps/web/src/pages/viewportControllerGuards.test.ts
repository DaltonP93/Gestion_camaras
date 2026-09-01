// A1 (post #160) · guardas AST del REFACTOR de ciclo de vida.
//
// El objetivo del refactor: ningún arranque/cierre/timer de sesión vive suelto
// en las páginas. Todo pasa por el controlador compartido
// (`useViewportSessionLifecycle` → `createViewportSessionController`), que es el
// único dueño de `apiPost(start-stream)`, `closeStreamSession`,
// `closeViewSessions`, el registro, la cola y —en ViewPlayerPage— los timers HLS
// y el heartbeat. Un test de comportamiento no ve una regresión de DISPERSIÓN
// (alguien vuelve a llamar start/stop directo en un handler nuevo); estas guardas
// sobre el propio código sí.
import { describe, it, expect } from 'vitest'

const sources = import.meta.glob('./*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>
const libSources = import.meta.glob('../lib/*.ts', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>
const read = (rel: string): string => {
  const s = sources[rel] ?? libSources[rel]
  if (typeof s !== 'string') throw new Error(`No se pudo leer ${rel}`)
  return s
}

/** Las dos páginas que manejan sesiones de stream. */
const PAGINAS = ['./LiveViewPage.tsx', './ViewPlayerPage.tsx']

describe('las páginas no arrancan/cierran/registran sesiones por su cuenta', () => {
  it('las páginas de sesiones son exactamente las auditadas', () => {
    // Una página nueva que arranque streams debe adoptar el controlador, no
    // heredar el defecto en silencio.
    const conControlador = Object.entries(sources)
      .filter(([, s]) => s.includes('useViewportSessionLifecycle('))
      .map(([rel]) => rel)
      .sort()
    expect(conControlador).toEqual(PAGINAS)
  })

  it.each(PAGINAS)('%s instancia el controlador compartido', (rel) => {
    const s = read(rel)
    expect(s).toContain("import { useViewportSessionLifecycle } from '@/lib/useViewportSessionLifecycle'")
    expect(s).toMatch(/const ctrl = useViewportSessionLifecycle\(/)
  })

  it.each(PAGINAS)('%s no emite `apiPost(.../start-stream)` directo', (rel) => {
    const s = read(rel)
    // El arranque lo emite el controlador (o su `startRaw`). En la página no
    // queda ningún POST de start-stream. `restart-stream` es otro endpoint y no
    // crea sesión: no cuenta (por eso el `(?<!re)`).
    expect(s).not.toMatch(/apiPost(?:<[^>]*>)?\(\s*`\/cameras\/\$\{[^}]+\}\/(?<!re)start-stream`/)
  })

  it.each(PAGINAS)('%s no llama `closeStreamSession` ni `closeViewSessions` directo', (rel) => {
    const s = read(rel)
    expect(s).not.toMatch(/closeStreamSession\(/)
    // El cierre de vista pasa por `ctrl.disposeView()`, no por un `closeViewSessions` suelto.
    expect(s).not.toMatch(/closeViewSessions\(/)
  })

  it.each(PAGINAS)('%s no crea registro ni cola propios: los posee el controlador', (rel) => {
    const s = read(rel)
    expect(s).not.toMatch(/createSessionRegistry\(/)
    expect(s).not.toMatch(/createPendingCloseQueue\(/)
  })

  it.each(PAGINAS)('%s no muta el registro ni la cola «a mano»', (rel) => {
    const s = read(rel)
    // Alta/baja del registro y encolado sólo a través del controlador
    // (registerStarted/registerReconciled/close/closeStale/closeTracked).
    expect(s).not.toMatch(/activeSessions\.(add|removeType|forget)\(/)
    expect(s).not.toMatch(/\.pending\(\)\.add\(/)
    expect(s).not.toMatch(/pendingCloses\.add\(/)
  })
})

describe('los primitivos prohibidos viven en la frontera del controlador', () => {
  it('el hook es dueño de `apiPost(start-stream)`, `closeStreamSession` y `closeViewSessions`', () => {
    const hook = read('../lib/useViewportSessionLifecycle.ts')
    expect(hook).toMatch(/apiPost<[^>]*>\(`\/cameras\/\$\{cameraId\}\/start-stream`/)
    expect(hook).toContain('close: closeStreamSession')
    expect(hook).toContain('closeView: closeViewSessions')
  })
})

describe('ViewPlayerPage delega TODO timer y heartbeat en el controlador', () => {
  const s = () => read('./ViewPlayerPage.tsx')

  it('no usa ningún `setTimeout` propio: los timers HLS los agenda el controlador', () => {
    // La grilla y el fullscreen re-arrancan vía `ctrl.scheduleHlsRestart`. Un
    // `setTimeout` suelto era el defecto (un re-arranque sin cancelar ni vigencia).
    // El slideshow usa `setInterval`, que no arranca sesiones.
    expect(s()).not.toMatch(/setTimeout\(/)
    expect(s()).toContain('ctrl.scheduleHlsRestart(')
  })

  it('el heartbeat lo ata y arranca el controlador', () => {
    const src = s()
    expect(src).toContain('ctrl.bindHeartbeat({')
    expect(src).toContain('ctrl.startHeartbeat()')
    // Ya no crea su propio scheduler.
    expect(src).not.toMatch(/createHeartbeatScheduler/)
  })

  it('el cierre de vista y todos los arranques pasan por el controlador', () => {
    const src = s()
    expect(src).toContain('ctrl.disposeView()')
    expect(src).toContain('ctrl.start({')
    expect(src).toContain('ctrl.closeHd(')
  })

  it('la transición de ruta/página es FUERTE: `beginTransition` en el commit, no `publishScope`', () => {
    const src = s()
    // El defecto de C14: usar `publishScope` (publica sin cerrar A). La entrada
    // fuerte —`beginTransition`— publica scope B, detiene el heartbeat de A,
    // cancela sus timers y cierra sus identidades. Va SÍNCRONA en el commit.
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*ctrl\.beginTransition\(/)
    // Ninguna página usa la API débil `publishScope`.
    expect(src).not.toMatch(/ctrl\.publishScope\(/)
  })

  it('registra la identidad REAL que recupera el heartbeat (reconcile), nunca `hb:*`', () => {
    const src = s()
    // Si el backend aceptó un start cuya respuesta se perdió, el heartbeat trae
    // su `startAttemptId` real; se registra por el controlador para poder cerrarlo
    // exacto después. Sin id real no se anota; jamás un `hb:*`.
    // Registra CADA arrendamiento por el helper compartido (que no conoce override).
    expect(src).toContain('registerHeartbeatIdentities(result.streams, (cid, tipo, aid) => ctrl.registerReconciled(cid, tipo, aid))')
    expect(src).not.toMatch(/`hb:/)
  })
})

describe('bfcache: política COHERENTE (force-reload) en ambas páginas', () => {
  it.each(PAGINAS)('%s: pagehide ABANDONA siempre; pageshow persistido recarga si fue abandonado', (rel) => {
    const src = read(rel)
    // Cualquier pagehide abandona por completo (disposeView), sin `suspend` parcial.
    expect(src).toContain('const onPageHide = ()')
    expect(src).toMatch(/onPageHide = \(\) => \{[^}]*ctrl\.disposeView\(\)/)
    expect(src).not.toMatch(/ctrl\.suspend\(/)
    // pageshow: la decisión sale de la política pura + el flag de abandono.
    expect(src).toContain('pageShowAction(e.persisted) === \'reload\' && ctrl.isAbandoned()')
    expect(src).toContain('window.location.reload()')
  })
})

describe('el dispose de LiveViewPage lo GOBIERNA el controlador (onDispose)', () => {
  it('la página registra un hook de dispose; no detiene su heartbeat por su cuenta en pagehide', () => {
    const src = read('./LiveViewPage.tsx')
    // El controlador ejecuta el hook en `disposeView` —así el dispose del
    // heartbeat/viewportWork adoptados lo maneja el controlador, no la página—.
    expect(src).toContain('ctrl.onDispose(')
    expect(src).toMatch(/ctrl\.onDispose\(\(\) => \{[\s\S]{0,160}heartbeatRef\.current\?\.stop\(\)/)
  })
})

describe('ninguna página usa la API débil `publishScope`', () => {
  it.each(PAGINAS)('%s no llama `ctrl.publishScope` (usa la transición fuerte)', (rel) => {
    expect(read(rel)).not.toMatch(/ctrl\.publishScope\(/)
  })
})

describe('LiveViewPage no posee un segundo lifecycle: adopta su maquinaria', () => {
  const s = () => read('./LiveViewPage.tsx')

  it('viewportWork y viewportTransition los RETIENE el controlador (ctrl.adopt), no un useRef propio', () => {
    const src = s()
    // Antes: `useRef(createViewportWork(...))` / `useRef(createViewportTransition(...))`
    // —un lifecycle propio de la página—. Ahora los crea una vez y los retiene el
    // controlador; la página los usa desde ahí.
    expect(src).toContain("ctrl.adopt('viewportWork'")
    expect(src).toContain("ctrl.adopt('transition'")
    expect(src).not.toMatch(/useRef\(createViewportWork\(/)
    expect(src).not.toMatch(/useRef\(createViewportTransition\(/)
  })
})
