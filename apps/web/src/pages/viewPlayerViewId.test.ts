// Test (1) de la revisión de #146 — guarda de regresión estructural.
//
// El defecto original no fue de lógica sino de OMISIÓN: `ViewPlayerPage` creaba
// su `viewId` y lo usaba en el heartbeat, pero ninguno de sus `start-stream` lo
// enviaba. El backend registraba entonces la sesión bajo `viewId='default'`,
// el heartbeat llegaba como 'vp_…', no coincidían, y la sesión de una cámara
// que el usuario estaba mirando expiraba por `view_heartbeat_missing`.
//
// Una omisión así no la detecta ningún test de comportamiento del componente:
// la única defensa barata y determinista es afirmar sobre el propio código que
// TODA llamada de arranque declara su pestaña. Si mañana alguien agrega un
// camino nuevo sin `viewId`, este test lo señala.
import { describe, it, expect } from 'vitest'

// Se lee el fuente con `import.meta.glob(..., { query: '?raw' })`, el mecanismo
// de Vite: no hace falta `node:fs` ni añadir los tipos de Node al tsconfig del
// frontend sólo para este test.
const sources = import.meta.glob('./*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

const read = (rel: string): string => {
  const src = sources[rel]
  if (typeof src !== 'string') throw new Error(`No se pudo leer ${rel}`)
  return src
}

describe('(1) ViewPlayerPage identifica su pestaña vía el controlador', () => {
  const source = read('./ViewPlayerPage.tsx')

  it('crea el controlador con el viewId ESTABLE de la instancia', () => {
    expect(source).toContain('const viewIdRef = useRef')
    expect(source).toContain('useViewportSessionLifecycle(viewIdRef.current)')
  })

  it('el heartbeat usa ese mismo viewId', () => {
    expect(source).toMatch(/viewId:\s*viewIdRef\.current/)
  })

  it('el viewId se declara una sola vez en el componente', () => {
    const declaraciones = source.match(/const viewIdRef = useRef/g) ?? []
    expect(declaraciones).toHaveLength(1)
  })

  it('el cierre de la vista pasa por el controlador, no un `closeViewSessions` suelto', () => {
    expect(source).toContain('ctrl.disposeView()')
    expect(source).not.toMatch(/closeViewSessions\(/)
  })
})

describe('(1c) la carga de vista tiene ALCANCE propio', () => {
  const source = read('./ViewPlayerPage.tsx')

  it('la carga pasa por `runScopedViewLoad`, no por un `.then` suelto', () => {
    // El defecto: `apiGet(`/views/${id}`).then(v => { setView(v); … setSlots })`
    // sin comprobar vigencia. Una respuesta A tardía pisaba la vista B.
    expect(source).toContain("import { runScopedViewLoad } from '@/lib/scopedViewLoad'")
    expect(source).toContain('void runScopedViewLoad<CameraView, Camera, StreamInfo>({')
    // Ya no hay un `.then` directo del GET de la vista que aplique estado.
    expect(source).not.toMatch(/apiGet<CameraView>\(`\/views\/\$\{id\}`\)\s*\n\s*\.then/)
  })

  it('el scope de vista se PUBLICA en el commit (useLayoutEffect), no en cleanup pasivo', () => {
    // El defecto del correctivo 12: la invalidación vivía sólo en el cleanup de
    // un `useEffect` (fase pasiva). Entre el commit de B y ese cleanup corría la
    // continuación de A y aún pasaba `isCurrent()`. Ahora el scope se publica
    // síncronamente en el commit, invalidando el anterior en el acto.
    expect(source).toContain("import { createScopeGuard } from '@/lib/scopeGuard'")
    expect(source).toContain('const viewScope = useRef(createScopeGuard()).current')
    // La publicación es un layout effect atado a [id], no un useEffect pasivo.
    expect(source).toMatch(/useLayoutEffect\(\(\) => \{\s*const scope = viewScope\.publish\(\)\s*return \(\) => viewScope\.invalidate\(scope\)\s*\}, \[id\]\)/)
  })

  it('la corrida captura el scope vigente y NO confía en el `id` del closure', () => {
    const i = source.indexOf('// ─── Load view + cameras + streams')
    expect(i).toBeGreaterThan(-1)
    const fin = source.indexOf('}, [id])', i)
    expect(fin).toBeGreaterThan(i)
    const cuerpo = source.slice(i, fin)
    // Se captura el scope que publicó el layout effect; la vigencia compara su
    // identidad EXACTA contra la vigente, no el `id` capturado.
    expect(cuerpo).toContain('const scope = viewScope.current()')
    expect(cuerpo).toContain('const vigente = () => viewScope.isCurrent(scope)')
    // `setView`/`setSlots` sólo entran como callbacks del camino con alcance.
    expect(cuerpo).toMatch(/isCurrent: vigente/)
    // SNAPSHOT ATÓMICO: `view` NO se aplica en `onView` (dejaba view=B, slots=A);
    // se aplican view+slots+loadedId JUNTOS en `onSlots`.
    expect(cuerpo).toMatch(/onView: \(\) => \{\}/)
    expect(cuerpo).toContain('setLoadedId(rutaId)')
    // Y la carga ya NO se invalida en un cleanup pasivo propio: eso era el gap.
    expect(cuerpo).not.toContain('viewLoadTokenRef')
  })

  it('el page-loader y el heartbeat sólo trabajan con el snapshot aplicado (loadedId === id)', () => {
    // El gate atómico va en AMBOS efectos —page-loader y heartbeat—: mientras B
    // carga o falla, no sale trabajo de A por ninguno.
    const gates = source.match(/if \(!view \|\| loadedId !== id/g) ?? []
    expect(gates.length).toBe(2)
    // El reset de página es SÍNCRONO en el commit del cambio de id, no pasivo.
    expect(source).toMatch(/useLayoutEffect\(\(\) => \{\s*setCurrentPage\(0\)\s*\}, \[id\]\)/)
  })
})

describe('(1b) LiveViewPage también identifica su pestaña vía el controlador', () => {
  const source = read('./LiveViewPage.tsx')

  it('crea el controlador con su viewId estable', () => {
    expect(source).toContain('const [viewId] = useState<string>(makeViewId)')
    expect(source).toContain('useViewportSessionLifecycle(viewId)')
  })

  it('el arranque NO lleva viewId ni startAttemptId «a mano»: los agrega el controlador', () => {
    // Los cuerpos de `startRaw` ya no cargan viewId/startAttemptId; el hook +
    // controlador los agregan. Ni la grilla ni el foco/calidad los declaran.
    expect(source).not.toMatch(/streamType: overrideType, viewId/)
    expect(source).not.toMatch(/streamType: 'main', viewId/)
    expect(source).not.toMatch(/streamType: quality, viewId/)
  })

  it('el arranque pasa por `ctrl.startRaw`, no por un `apiPost(start-stream)` directo', () => {
    expect(source).toMatch(/ctrl\.startRaw\(/)
    expect(source).not.toMatch(/apiPost(?:<[^>]*>)?\(\s*`\/cameras\/\$\{[^}]+\}\/(?<!re)start-stream`/)
    // `restart-stream` es otro endpoint (reinicio administrativo) y sí puede quedar.
    expect(source).toContain('restart-stream')
  })
})
