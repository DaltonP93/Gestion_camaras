// A1 · guardas estructurales del heartbeat.
//
// El defecto de la validación A1 no fue de lógica sino de DISPERSIÓN: la regla
// "con la pestaña oculta no se late" estaba escrita dentro del callback de un
// `setInterval` en `LiveViewPage`, no existía en el `setInterval` de
// `ViewPlayerPage`, y una tercera ruta —el vaciado de sesiones HLS expiradas—
// llamaba al endpoint por su cuenta. Se corrigieron dos de tres.
//
// Un test de comportamiento no ve una omisión así: la defensa barata y
// determinista es afirmar sobre el propio código que la cadencia del heartbeat
// sale de un único sitio y que toda ruta de envío consulta la visibilidad.
// Si mañana alguien agrega un camino nuevo, esto lo señala.
import { describe, it, expect } from 'vitest'

const sources = import.meta.glob('./*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

const read = (rel: string): string => {
  const src = sources[rel]
  if (typeof src !== 'string') throw new Error(`No se pudo leer ${rel}`)
  return src
}

/** Páginas que envían heartbeats de vista en vivo. */
const HEARTBEAT_PAGES = Object.entries(sources)
  .filter(([, src]) => src.includes("'/live-view/heartbeat'"))
  .map(([rel]) => rel)

describe('la cadencia del heartbeat tiene un solo dueño', () => {
  it('las páginas que laten son exactamente las esperadas', () => {
    // Si aparece una tercera, este test obliga a revisarla conscientemente en
    // lugar de que herede el defecto en silencio.
    expect(HEARTBEAT_PAGES.sort()).toEqual(['./LiveViewPage.tsx', './ViewPlayerPage.tsx'])
  })

  it.each(HEARTBEAT_PAGES)('%s usa createHeartbeatScheduler', (rel) => {
    expect(read(rel)).toContain('createHeartbeatScheduler')
  })

  it.each(HEARTBEAT_PAGES)('%s no programa el heartbeat con un setInterval propio', (rel) => {
    const src = read(rel)
    // Ventana de 320 caracteres tras cada `setInterval(`: alcanza para ver el
    // cuerpo del callback o el nombre de la función que se agenda.
    const ventanas: string[] = []
    const re = /setInterval\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) ventanas.push(src.slice(m.index, m.index + 320))

    const sospechosas = ventanas.filter(v => /heartbeat|sendBeat/i.test(v))
    expect(sospechosas).toEqual([])
  })

  it.each(HEARTBEAT_PAGES)('%s consulta la visibilidad antes de enviar', (rel) => {
    const src = read(rel)
    expect(src).toContain('tabIsHidden')
    // Y la lee como función, no como comparación en línea: una comparación
    // dentro de la misma función queda estrechada por TypeScript y la segunda
    // —la que corre después de un `await`, cuando el valor pudo cambiar— se
    // marcaría como imposible.
    expect(src).toContain("const tabIsHidden = (): boolean => document.visibilityState === 'hidden'")
  })
})

describe('(D) toda llamada al endpoint es cancelable', () => {
  /** Extrae cada `apiPost(...)` cuyo primer argumento es el heartbeat. */
  function heartbeatCalls(src: string): string[] {
    const out: string[] = []
    const re = /apiPost(?:<[^>]*>)?\(\s*'\/live-view\/heartbeat'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      // Se recorta hasta el cierre del paréntesis de la llamada, contando
      // anidamientos, para no confundirse con el objeto del cuerpo.
      let depth = 0
      let i = src.indexOf('(', m.index)
      const start = i
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++
        else if (src[i] === ')') { depth--; if (depth === 0) break }
      }
      out.push(src.slice(start, i + 1))
    }
    return out
  }

  it.each(HEARTBEAT_PAGES)('%s hace exactamente una llamada al endpoint', (rel) => {
    // Una sola boca de salida por página. Dos era justamente el defecto: la
    // segunda —el vaciado de sesiones HLS expiradas— no pasaba por el
    // programador y no se podía cancelar.
    expect(heartbeatCalls(read(rel))).toHaveLength(1)
  })

  it.each(HEARTBEAT_PAGES)('%s pasa una señal de cancelación en esa llamada', (rel) => {
    const llamadas = heartbeatCalls(read(rel))
    expect(llamadas.length).toBeGreaterThan(0)
    for (const llamada of llamadas) {
      expect(llamada).toMatch(/\bsignal\b/)
    }
  })

  it('LiveViewPage no reconcilia sesiones HLS expiradas por su cuenta', () => {
    const src = read('./LiveViewPage.tsx')
    // Debe delegar en el módulo puro, que a su vez usa la operación cancelable
    // del programador.
    expect(src).toContain('reconcileHlsExpiry')
    expect(src).toContain('runNow()')
  })
})

describe('(G) la invalidación del viewport se EJECUTA en cada cambio', () => {
  const src = () => read('./LiveViewPage.tsx')

  // La versión anterior de estas guardas comprobaba que el archivo CONTUVIERA
  // `pendingExpiry.current.clear()`. Eso pasaba aunque la línea no se ejecutara
  // nunca en un cambio de NVR: la limpieza vivía en el cleanup de un efecto que
  // sólo corre al desmontar, y cambiar de NVR no desmonta la vista. Los efectos
  // de la invalidación se prueban ejecutándola en `viewportWork.test.ts`; acá
  // sólo se verifica que los cuatro caminos pasen por ella.

  it('stopAllSessions invalida ANTES de detener nada', () => {
    const cuerpo = src().slice(src().indexOf('const stopAllSessions'))
    const hastaElAwait = cuerpo.slice(0, cuerpo.indexOf('await stopSessions'))
    expect(hastaElAwait).toContain("viewportWork.invalidate(")
  })

  it.each([
    ['handleNVRChange', 'nvr_change'],
    ['handlePageChange', 'page_change'],
    ['handleLayoutChange', 'layout_change'],
  ])('%s pasa por stopAllSessions con razón %s', (handler, razon) => {
    const i = src().indexOf(`const ${handler}`)
    expect(i).toBeGreaterThan(-1)
    const cuerpo = src().slice(i, i + 400)
    expect(cuerpo).toContain(`stopAllSessions('${razon}')`)
  })

  it('la transición por camera_query también pasa por stopAllSessions', () => {
    expect(src()).toContain("stopAllSessions('camera_query')")
  })

  it('el cierre de la vista (pagehide y desmontaje) invalida', () => {
    const i = src().indexOf('const closeThisView')
    const cuerpo = src().slice(i, i + 300)
    expect(cuerpo).toContain("viewportWork.invalidate('close_view')")
  })

  it('el trabajo transitorio ya no vive en refs sueltas de la página', () => {
    // Si vuelven a aparecer, vuelve el defecto: limpiarlas exige acordarse en
    // cada camino, y ése es justamente el olvido que hubo.
    const s = src()
    expect(s).not.toContain('pendingExpiry.current')
    expect(s).not.toContain('hlsExpiryQueue.current')
    expect(s).not.toContain('hlsExpiryTimerRef.current')
  })

  it('todo trabajo diferido comprueba la generación antes de aplicar', () => {
    const s = src()
    expect(s).toContain('viewportWork.isCurrent(epoch)')
    expect(s).toContain('viewportWork.isCurrent(epochDeEnvio.current)')
  })
})

describe('regresión: el viewId nunca puede ser "default"', () => {
  it.each(HEARTBEAT_PAGES)('%s envía un viewId propio en cada heartbeat', (rel) => {
    const src = read(rel)
    const re = /'\/live-view\/heartbeat',\s*\{([\s\S]{0,200}?)\}/g
    const cuerpos: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) cuerpos.push(m[1])

    expect(cuerpos.length).toBeGreaterThan(0)
    for (const cuerpo of cuerpos) {
      // Acepta tanto `viewId: x` como la forma abreviada `viewId,`.
      expect(cuerpo).toMatch(/\bviewId\b\s*[:,}]/)
      expect(cuerpo).not.toMatch(/viewId\s*:\s*'default'/)
    }
  })

  it.each(HEARTBEAT_PAGES)('%s genera un viewId único por pestaña, no uno fijo', (rel) => {
    const src = read(rel)
    // Uno u otro mecanismo, pero nunca una constante literal.
    expect(src).toMatch(/crypto\.randomUUID\(\)|Math\.random\(\)/)
  })
})
