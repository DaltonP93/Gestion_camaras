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

/**
 * Extrae las llamadas a `start-stream` con el argumento de cuerpo que las
 * acompaña. El `(?<!re)` evita capturar `restart-stream`, que es otro endpoint
 * (reinicio administrativo del path en MediaMTX) y no crea ninguna sesión.
 *
 * El cuerpo puede ser un literal `{ … }` o una variable ya construida; se
 * devuelve tal cual y el llamador decide cómo verificarlo.
 */
function startStreamCalls(source: string): string[] {
  const re = /(?<!re)start-stream`\s*,\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) out.push(m[1])
  return out
}

describe('(1) ViewPlayerPage declara su viewId en todos los arranques', () => {
  const source = read('./ViewPlayerPage.tsx')

  it('encuentra los cuatro caminos de arranque de esta página', () => {
    // Fullscreen HD, reintento tras HLS_SESSION_EXPIRED (grilla), reintento HD y
    // carga de página (que cubre también el slideshow, porque avanza `currentPage`).
    // Si el número baja, es que alguno dejó de matchear y el test estaría
    // validando menos de lo que cree.
    expect(startStreamCalls(source)).toHaveLength(4)
  })

  it('TODAS las llamadas a start-stream envían viewId', () => {
    const sinViewId = startStreamCalls(source).filter(body => !body.includes('viewId'))
    expect(sinViewId).toEqual([])
  })

  it('el viewId es el mismo ref estable de la instancia, no uno improvisado', () => {
    for (const body of startStreamCalls(source)) {
      expect(body).toContain('viewIdRef.current')
    }
  })

  it('el heartbeat usa ese mismo ref', () => {
    expect(source).toMatch(/viewId:\s*viewIdRef\.current/)
  })

  it('el viewId se declara una sola vez en el componente', () => {
    const declaraciones = source.match(/const viewIdRef = useRef/g) ?? []
    expect(declaraciones).toHaveLength(1)
  })

  it('el cierre de la vista también identifica la pestaña', () => {
    expect(source).toContain('closeViewSessions(viewIdRef.current)')
    expect(source).toMatch(/closeStreamSession\([^)]*viewIdRef\.current\)/)
  })
})

describe('(1b) LiveViewPage tampoco arranca sin declarar su pestaña', () => {
  const source = read('./LiveViewPage.tsx')

  it('los cuerpos literales de start-stream envían viewId', () => {
    const literales = startStreamCalls(source).filter(b => b.startsWith('{'))
    expect(literales.length).toBeGreaterThan(0)
    expect(literales.filter(b => !b.includes('viewId'))).toEqual([])
  })

  it('el cuerpo construido en variable de la grilla también lo incluye', () => {
    // loadStream arma `body` según haya override de tipo; ambas ramas deben
    // llevar viewId.
    const m = source.match(/const body = overrideType[^\n]*\n?[^\n]*/)
    expect(m).not.toBeNull()
    const asignacion = m![0]
    expect(asignacion).toContain('viewId')
    // Las DOS ramas del ternario, no sólo una.
    expect(asignacion.match(/viewId/g) ?? []).toHaveLength(2)
  })

  it('restart-stream NO se cuenta: es otro endpoint y no crea sesión', () => {
    expect(source).toContain('restart-stream')
    expect(startStreamCalls(source).some(b => b === '{}')).toBe(false)
  })
})
