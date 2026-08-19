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

  it('stopAllSessions NO invalida por su cuenta: la transacción es la dueña', () => {
    // Invalidar desde dentro del cierre avanzaría la generación a mitad de la
    // transacción y anularía el token que ella misma acaba de emitir, con lo
    // que su propio commit se descartaría por "superseded".
    const desde = src().indexOf('const stopAllSessions = useCallback')
    expect(desde).toBeGreaterThan(-1)
    const fin = src().indexOf('stopAllSessionsRef.current = stopAllSessions', desde)
    expect(fin).toBeGreaterThan(desde)
    const cuerpo = src().slice(desde, fin)
    expect(cuerpo).not.toMatch(/viewportWork\.invalidate\(/)
  })

  it.each([
    ['handleNVRChange', 'nvr_change'],
    ['handlePageChange', 'page_change'],
    ['handleLayoutChange', 'layout_change'],
  ])('%s pasa por la transacción con razón %s', (handler, razon) => {
    const i = src().indexOf(`const ${handler}`)
    expect(i).toBeGreaterThan(-1)
    const cuerpo = src().slice(i, i + 400)
    // Nunca el cierre suelto: sin la transacción el intervalo sigue armado y un
    // tick puede latir con los IDs del viewport anterior mientras se cierra.
    expect(cuerpo).toContain(`transition.run('${razon}'`)
    expect(cuerpo).not.toMatch(/stopAllSessions\(/)
  })

  it('la transición por camera_query también pasa por la transacción', () => {
    expect(src()).toContain("transition.run('camera_query'")
  })

  it('los cambios de viewport son los únicos que llaman a la transacción', () => {
    const razones = Array.from(src().matchAll(/transition\.run\('([a-z_]+)'/g)).map(m => m[1])
    expect(razones.sort()).toEqual(
      ['camera_query', 'layout_change', 'nvr_change', 'page_change'],
    )
  })

  it('el cierre de sesiones sólo lo invoca el coordinador', () => {
    // Nadie la LLAMA directamente: sólo se define y se publica en la ref que
    // lee `closeSessions`. Una llamada suelta sería un cierre fuera de la
    // transacción, con la cadencia todavía armada.
    const llamadas = Array.from(src().matchAll(/(?<!Ref\.current = )\bstopAllSessions\(/g))
    expect(llamadas).toEqual([])
    expect(src()).toContain('closeSessions: (reason) => stopAllSessionsRef.current(reason)')
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

  it('la identidad de cada solicitud es un token LOCAL, no una ref compartida', () => {
    const s = src()
    // Cada camino que puede resolver tarde captura su propio token en una
    // variable local antes de salir. Ése era el defecto de #159: la generación
    // vivía en una ref que la transición nueva ya había pisado, así que el
    // resultado viejo pasaba la comprobación.
    const capturas = Array.from(s.matchAll(/const token = transition\.current\(\)/g))
    // heartbeat, scheduleStart, loadStream, foco/HD y cambio de calidad.
    expect(capturas.length).toBeGreaterThanOrEqual(5)
    // Todas menos la del heartbeat comparan el token local directamente; la del
    // heartbeat pasa por `tokenDelVuelo` y la cubre el test siguiente.
    const comparaciones = Array.from(s.matchAll(/transition\.isCurrent\(token\)/g))
    expect(comparaciones.length).toBe(capturas.length - 1)
    // Y no vuelve la ref mutable como identidad de varias solicitudes.
    expect(s).not.toContain('epochDeEnvio')
  })

  it('el único token en ref es el del heartbeat, y el propio envío lo escribe', () => {
    const s = src()
    // El programador garantiza una sola solicitud en vuelo, así que un único
    // casillero alcanza — pero tiene que escribirse en `send`, no antes.
    const i = s.indexOf('send: (signal) =>')
    expect(i).toBeGreaterThan(-1)
    const cuerpo = s.slice(i, i + 600)
    expect(cuerpo).toContain('const token = transition.current()')
    expect(cuerpo).toContain('tokenDelVuelo.current = token')
    expect(s).toContain('if (!transition.isCurrent(tokenDelVuelo.current))')
  })

  it('el programador se comporta como oculto mientras hay una transición', () => {
    expect(src()).toContain('isHidden: () => tabIsHidden() || transition.isTransitioning()')
  })

  it('ningún arranque diferido usa un setTimeout suelto', () => {
    const s = src()
    // Todos pasan por `scheduleStart`, que captura token, registra el timer
    // para que la invalidación pueda cancelarlo y comprueba antes de arrancar.
    const ventanas: string[] = []
    const re = /setTimeout\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) ventanas.push(s.slice(m.index, m.index + 200))
    const sospechosas = ventanas.filter(v => /loadStream/i.test(v))
    expect(sospechosas).toEqual([])
    // El registro del temporizador —lo que permite cancelarlo al invalidar— lo
    // hace el módulo compartido, no cada sitio por su cuenta.
    expect(s).toContain('scheduleDeferredStart({')
    expect(s).toContain('track: (id) => viewportWork.trackTimer(id)')
  })

  it('todo start-stream pasa por el ciclo de vida guardado', () => {
    const s = src()
    const arranques = Array.from(s.matchAll(/\/start-stream`/g)).length
    const guardados  = Array.from(s.matchAll(/runViewportRequest</g)).length
    // Grid, foco/HD y cambio de calidad: tres arranques, tres ciclos guardados.
    // Un cuarto arranque sin ciclo sería una respuesta vieja capaz de dejar un
    // FFmpeg sin espectador hasta el TTL.
    expect(arranques).toBe(3)
    expect(guardados).toBe(3)
  })

  it('cada ciclo guardado cierra en `discard` lo que el backend creó', () => {
    const s = src()
    const cierres = Array.from(s.matchAll(/'viewport_changed', viewId\)/g)).length
    expect(cierres).toBe(3)
  })

  it('el trabajo por generación sigue vigente para las expiraciones HLS', () => {
    expect(src()).toContain('viewportWork.isCurrent(epoch)')
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
