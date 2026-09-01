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

/**
 * Extrae el objeto literal de cada llamada `nombre({ … })`, contando llaves.
 * Una ventana de N caracteres se corta a mitad de argumento y hace pasar por
 * ausente lo que sí está.
 */
function bloquesDeLlamada(src: string, nombre: string): string[] {
  const out: string[] = []
  const re = new RegExp(`${nombre}\\(\\{`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let depth = 0
    let i = src.indexOf('{', m.index)
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) break }
    }
    out.push(src.slice(start, i + 1))
  }
  return out
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

  it.each(HEARTBEAT_PAGES)('%s programa el heartbeat por un solo dueño (scheduler o controlador)', (rel) => {
    const src = read(rel)
    // El «cuándo latir» sale de un único sitio: `createHeartbeatScheduler`
    // (LiveViewPage, cuya cadencia posee su coordinador de transición) o
    // `ctrl.bindHeartbeat` (ViewPlayerPage, cuya cadencia posee el controlador,
    // que a su vez usa el mismo scheduler por dentro).
    expect(src.includes('createHeartbeatScheduler') || src.includes('ctrl.bindHeartbeat(')).toBe(true)
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

  it('el cierre de la vista (pagehide y desmontaje) invalida vía el hook de dispose del controlador', () => {
    // La invalidación de `viewportWork` ahora la GOBIERNA el controlador: la
    // página la registra como hook de dispose (`ctrl.onDispose`), y el
    // controlador la ejecuta en `disposeView` —lo llame pagehide o el desmontaje—.
    const i = src().indexOf('ctrl.onDispose(')
    expect(i).toBeGreaterThan(-1)
    const cuerpo = src().slice(i, i + 200)
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
    expect(comparaciones.length).toBeGreaterThanOrEqual(capturas.length - 1)
    // Y no vuelve la ref mutable como identidad de varias solicitudes.
    expect(s).not.toContain('epochDeEnvio')
  })

  it('todo lo que se ejecuta tras un await recibe el token, no lo captura', () => {
    const s = src()
    // Que el token sea PARÁMETRO obligatorio es lo que impide el defecto: quien
    // programa un arranque después de esperar algo no puede "olvidarse" y
    // heredar en silencio el viewport nuevo — no compila sin declarar cuál es.
    expect(s).toMatch(/const scheduleStart = useCallback\(\(\s*cam: Camera, delayMs: number, reason: string, token: TransitionToken,/)
    expect(s).toContain('const startVisibleStreams = useCallback((cams: Camera[], token: TransitionToken)')
    expect(s).toMatch(/const handleLimitHit = useCallback\(async \(\s*camera: Camera, token: TransitionToken/)
    expect(s).toMatch(/const loadStream = useCallback\(async \(\s*camera: Camera, heredado\?: TransitionToken,/)
  })

  it('scheduleStart USA el token recibido, no vuelve a preguntar cuál es', () => {
    const s = src()
    const desde = s.indexOf('const scheduleStart = useCallback((')
    expect(desde).toBeGreaterThan(-1)
    const cuerpo = s.slice(desde, s.indexOf('\n  }, [])', desde))
    // Declararlo como parámetro y después ignorarlo dejaría el defecto intacto:
    // el arranque diferido volvería a heredar el viewport vigente al dispararse.
    expect(cuerpo).toContain('isCurrent: () => transition.isCurrent(token)')
    expect(cuerpo).not.toContain('transition.current()')
  })

  it('las operaciones de varios tramos abren una operación guardada', () => {
    const s = src()
    // Reinicio, salida de foco y límite de streams: los tres cruzan un await y
    // los tres declaran su vigencia una sola vez, al abrirse.
    const aperturas = Array.from(s.matchAll(/beginOperation\(\(\) => transition\.isCurrent\(token\)\)/g))
    expect(aperturas.length).toBe(3)
    // Y ya no queda ninguna espera suelta capaz de arrancar o remontar streams.
    expect(s).not.toMatch(/await new Promise\(\s*r? ?=> setTimeout/)
  })

  it('el cambio de calidad combina las DOS vigencias en el mismo sitio', () => {
    const s = src()
    // Viewport y selección juntos en `isCurrent`: así una selección superada
    // entra por `discard` y cierra su sesión, en vez de morir en un `return`
    // silencioso dentro de `apply` dejando el FFmpeg vivo.
    expect(s).toContain(
      'isCurrent: () => transition.isCurrent(token) && qualityCtl.current.isCurrent(cam, seq)',
    )
    // Y el cierre usa el tipo CREADO, nunca el pedido.
    const descartes = Array.from(s.matchAll(/resolveCreatedType\(info, /g))
    expect(descartes.length).toBeGreaterThanOrEqual(3)   // foco: discard y apply; calidad: discard y apply
    expect(s).not.toMatch(/closeStreamSession\(cam, quality,\s*'viewport_changed'/)
  })

  it('el reintento del límite hereda el token, no captura uno nuevo', () => {
    const s = src()
    expect(s).toContain('retry: () => loadStream(camera, token)')
    expect(s).toContain('const token = heredado ?? transition.current()')
  })

  it('la readquisición de HD distingue "superado" de "falló"', () => {
    const s = src()
    expect(s).toContain('hdReacquireFlow<StreamInfo, CameraPlaybackError>')
    // El resultado sintético que hacía pasar un descarte por un fallo real.
    expect(s).not.toContain("message: 'viewport_changed'")
    expect(s).toContain("resultado: EnterFocusResult = { status: 'superseded' }")
  })

  it('toda sesión que se abre queda registrada con su tipo real', () => {
    const s = src()
    // Si el foco o la calidad no registran la suya, el cierre posterior no
    // sabe que existe y la deja viva: la fuga vuelve por el otro extremo.
    // Un alta directa (el heartbeat) y tres por `registrarSesion`, que además
    // contrasta lo anotado con el estado EFECTIVO que devuelve el servidor.
    // Tres orígenes del cliente pasan por `registrarSesion` (foco, calidad,
    // grilla), que registra por el controlador y avisa si el servidor NO
    // registró el arrendamiento.
    const altas = bloquesDeLlamada(s, 'registrarSesion')
    expect(altas).toHaveLength(3)
    expect(altas.filter(b => /startAttemptId/.test(b))).toHaveLength(3)
    expect(s).toContain('start_attempt_not_registered')
    // El reconcile anota con la identidad que ACUÑÓ EL SERVIDOR, vía el
    // controlador —nunca un `hb:*` local (regresión del correctivo 7)— y sólo
    // cuando el backend la devolvió.
    expect(s).not.toMatch(/startAttemptId: `hb:/)
    // El reconcile registra CADA arrendamiento por el helper compartido, que no
    // conoce el override (no puede saltárselo).
    expect(s).toContain('registerHeartbeatIdentities(result.streams, (cid, tipo, aid) => ctrl.registerReconciled(cid, tipo, aid))')
  })

  it('P0-2: el registro de identidad va SEPARADO y ANTES de la mutación visual (no lo salta el fallback)', () => {
    const s = src()
    const iReg = s.indexOf('registerHeartbeatIdentities(result.streams')
    const iSet = s.indexOf('setStreams(prev => {')
    const iCont = s.indexOf('continue  // keep fallback URL intact')
    expect(iReg).toBeGreaterThan(-1); expect(iSet).toBeGreaterThan(-1); expect(iCont).toBeGreaterThan(-1)
    // El registro es ANTES del updater visual (no un efecto lateral suyo)…
    expect(iReg).toBeLessThan(iSet)
    // …y ANTES del `continue` del override: el fallback nunca salta el registro.
    expect(iReg).toBeLessThan(iCont)
  })

  it('el tipo de sesión sale del registro, nunca de una suposición', () => {
    const s = src()
    // El `Set<cameraId>` perdía el tipo real y forzaba a asumir 'sub'.
    expect(s).not.toMatch(/activeSessions = useRef<Set<string>>/)
    // El registro lo posee el controlador; la página lo lee de ahí.
    expect(s).toContain('const activeSessions = ctrl.registry()')
    // El cierre en lote pasa por el controlador…
    expect(s).toContain('ctrl.closeTracked(')
    // …y ninguna ruta vuelve a cerrar asumiendo 'sub'.
    expect(s).not.toMatch(/closeStreamSession\([^)]*, 'sub',/)
    expect(s).not.toMatch(/streamType: 'sub', reason:/)
  })

  it('la ruta de error HLS cierra los tipos registrados', () => {
    const s = src()
    const i = s.indexOf('const isGridCamera = cameraId !== focusCameraRef.current')
    expect(i).toBeGreaterThan(-1)
    const cuerpo = s.slice(i, i + 900)
    // La rama de grilla toma los tipos del registro; no una suposición.
    expect(cuerpo).toMatch(/\?\s*activeSessions\.typesOf\(cameraId\)/)
    // Y cierra por el controlador con la razón que conserva el FFmpeg.
    expect(cuerpo).toContain("cerrarSesion(cameraId, streamType, 'hls_fatal_error')")
    // La suposición anterior: `gridStreamOverride.current[cameraId] ?? 'sub'`.
    expect(cuerpo).not.toMatch(/gridStreamOverride\.current\[cameraId\] \?\? 'sub'/)
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
    // El POST lo emite el controlador (`ctrl.startRaw`); el ciclo lo guarda
    // `runViewportRequest`. Grid, foco/HD y cambio de calidad: tres y tres.
    const arranques = Array.from(s.matchAll(/ctrl\.startRaw\(/g)).length
    const guardados  = Array.from(s.matchAll(/runViewportRequest</g)).length
    expect(arranques).toBe(3)
    expect(guardados).toBe(3)
  })

  it('cada ciclo guardado cierra en `discard` por el controlador', () => {
    const s = src()
    // Los tres descartes —grilla, foco y calidad— pasan por `ctrl.closeStale`,
    // que resuelve el tipo sobre la respuesta real, usa `stale_response` y encola
    // lo no confirmado (la cola la posee el controlador).
    const bloques = bloquesDeLlamada(s, 'ctrl\\.closeStale')
    expect(bloques).toHaveLength(3)
    // …con la RESPUESTA real (sin `info` la resolución cae al tipo pedido)…
    expect(bloques.filter(b => /\binfo\b\s*[,:]/.test(b))).toHaveLength(3)
    // …y con el intento LOCAL de la solicitud, en forma abreviada.
    expect(bloques.filter(b => /[\s{]startAttemptId,/.test(b))).toHaveLength(3)
    expect(bloques.filter(b => /startAttemptId: '/.test(b))).toHaveLength(0)
    // El descarte de grilla declara lo que pidió, incluido el override activo.
    expect(s).toContain("requested: (overrideType as StreamKind | undefined) ?? 'sub'")
    // Y ninguno vuelve a ENVIAR la razón que el backend no reconocía.
    expect(s).not.toMatch(/reason: 'viewport_changed'/)
    // Las razones que sí se envían salen del contrato, no de literales sueltos.
    expect(s).toContain("import { STALE_RESPONSE, VIEWPORT_CHANGE } from '@/lib/closeReasons'")
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
