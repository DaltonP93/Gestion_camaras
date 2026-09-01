// Contrato frontend ↔ backend de las razones de cierre.
//
// POR QUÉ ESTA PRUEBA
//
// El frontend cerraba las respuestas tardías con `viewport_changed`. El
// conjunto del backend que autoriza terminar FFmpeg contiene `viewport_change`.
// Una letra: la sesión `main_h264` se borraba y su proceso quedaba corriendo sin
// espectador hasta la poda por inactividad. Ninguna prueba de ninguno de los dos
// lados podía verlo, porque cada lado era coherente consigo mismo.
//
// Acá se leen las razones que el frontend declara emitir y se comprueba, una por
// una, contra el conjunto real del backend. Si cualquiera de los dos lados
// cambia una cadena, esto falla.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRANSCODE_KILL_REASONS } from './stream-manager'
import { readStartAttemptId, START_ATTEMPT_ID_PATTERN } from './start-attempt'

const aquí = dirname(fileURLToPath(import.meta.url))
const RUTA_WEB = resolve(aquí, '../../../web/src/lib/closeReasons.ts')
const RUTA_WEB_ATTEMPT = resolve(aquí, '../../../web/src/lib/startAttempt.ts')

/** Extrae los literales de un array `export const NOMBRE = [...] as const`. */
function leerLista(fuente: string, nombre: string): string[] {
  const m = fuente.match(new RegExp(`export const ${nombre} = \\[([\\s\\S]*?)\\] as const`))
  if (!m) throw new Error(`No se encontró la lista ${nombre} en closeReasons.ts`)
  const literales = Array.from(m[1].matchAll(/'([^']+)'/g)).map(x => x[1])
  // Las constantes referenciadas por nombre (STALE_RESPONSE, VIEWPORT_CHANGE)
  // se resuelven leyendo su propia definición.
  const porNombre = Array.from(m[1].matchAll(/^\s*([A-Z_]+),/gm)).map(x => x[1])
  const resueltas = porNombre.map(id => {
    const d = fuente.match(new RegExp(`export const ${id} = '([^']+)'`))
    if (!d) throw new Error(`No se pudo resolver la constante ${id}`)
    return d[1]
  })
  return [...resueltas, ...literales]
}

const fuente = readFileSync(RUTA_WEB, 'utf8')
const MATAN     = leerLista(fuente, 'MATAN_FFMPEG')
const CONSERVAN = leerLista(fuente, 'CONSERVAN_FFMPEG')

describe('las razones que el frontend emite existen del lado del backend', () => {
  it('el archivo del frontend se pudo leer y declara ambas listas', () => {
    expect(MATAN.length).toBeGreaterThan(0)
    expect(CONSERVAN.length).toBeGreaterThan(0)
  })

  it.each(MATAN)('«%s» está en TRANSCODE_KILL_REASONS', (razon) => {
    expect(TRANSCODE_KILL_REASONS.has(razon)).toBe(true)
  })

  it.each(CONSERVAN)('«%s» NO está: un fallo transitorio conserva el proceso', (razon) => {
    expect(TRANSCODE_KILL_REASONS.has(razon)).toBe(false)
  })

  it('la razón de las respuestas tardías es exactamente `stale_response`', () => {
    expect(fuente).toContain("export const STALE_RESPONSE = 'stale_response'")
    expect(TRANSCODE_KILL_REASONS.has('stale_response')).toBe(true)
    // Y la que había, que nunca estuvo en el conjunto, no vuelve.
    expect(TRANSCODE_KILL_REASONS.has('viewport_changed')).toBe(false)
    expect(MATAN).not.toContain('viewport_changed')
  })

  it('`viewport_change` sigue sirviendo para el cierre de transición real', () => {
    expect(MATAN).toContain('viewport_change')
    expect(TRANSCODE_KILL_REASONS.has('viewport_change')).toBe(true)
  })
})

// ─── Contrato del identificador de intento ───────────────────────────────────

describe('la regla del `startAttemptId` es la MISMA en los dos lados', () => {
  const fuenteAttempt = readFileSync(RUTA_WEB_ATTEMPT, 'utf8')

  it('el patrón del frontend es literalmente el del backend', () => {
    const m = fuenteAttempt.match(/export const START_ATTEMPT_ID_PATTERN = (\/.+\/)\n/)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(String(START_ATTEMPT_ID_PATTERN))
  })

  it('el backend acepta lo que el frontend genera', () => {
    // Se reproduce el formato del generador del frontend, incluido el camino de
    // reserva sin `crypto.randomUUID`.
    const conUuid = 'sa-3f2504e0-4f89-11d3-9a0c-0305e82c3301-7'
    const sinUuid = 'sa-l9d8f7g-abc123xyz-2'
    expect(readStartAttemptId(conUuid)).toBe(conUuid)
    expect(readStartAttemptId(sinUuid)).toBe(sinUuid)
  })

  it('rechaza lo que no puede viajar en una query o crecería sin límite', () => {
    expect(readStartAttemptId('con espacio')).toBeUndefined()
    expect(readStartAttemptId('con/barra')).toBeUndefined()
    expect(readStartAttemptId('con&query=1')).toBeUndefined()
    expect(readStartAttemptId('')).toBeUndefined()
    expect(readStartAttemptId('x'.repeat(129))).toBeUndefined()
    expect(readStartAttemptId(42)).toBeUndefined()
    expect(readStartAttemptId(null)).toBeUndefined()
    expect(readStartAttemptId(undefined)).toBeUndefined()
  })

  it('acepta justo en el límite de longitud', () => {
    expect(readStartAttemptId('x'.repeat(128))).toHaveLength(128)
  })
})

// ─── El identificador viaja de verdad, en los dos sentidos ───────────────────

describe('las rutas leen y propagan el intento con los nombres del contrato', () => {
  const RUTA = resolve(aquí, '../routes/cameras.ts')
  const rutas = readFileSync(RUTA, 'utf8')
  const web = readFileSync(resolve(aquí, '../../../web/src/lib/sessionClose.ts'), 'utf8')
  // El arranque del frontend se centralizó: el POST vive en el hook y el
  // `startAttemptId` lo agrega el CONTROLADOR al cuerpo (antes iba en cada página).
  const webHook = readFileSync(resolve(aquí, '../../../web/src/lib/useViewportSessionLifecycle.ts'), 'utf8')
  const webCtrl = readFileSync(resolve(aquí, '../../../web/src/lib/viewportSessionController.ts'), 'utf8')

  it('el arranque lo lee del cuerpo, validado, y lo pasa a startStream', () => {
    // Leerlo y no propagarlo dejaría todas las sesiones sin dueño, y ningún
    // cierre por respuesta tardía podría cerrarlas nunca.
    expect(rutas).toContain('const startAttemptId = readStartAttemptId(body?.startAttemptId)')
    expect(rutas).toMatch(/startStream\([^)]*ticket, startAttemptId\)/)
    // Y el frontend lo envía con ese mismo nombre: el hook hace el POST a
    // start-stream y el controlador agrega `startAttemptId` al cuerpo.
    expect(webHook).toMatch(/start-stream`,\s*body/)
    expect(webCtrl).toMatch(/viewId: deps\.viewId, startAttemptId \}/)
  })

  it('el cierre lo lee de la query del DELETE y lo pasa a stopStream', () => {
    expect(rutas).toContain('readStartAttemptId(q?.expectedStartAttemptId)')
    expect(rutas).toMatch(/expectedStartAttemptId,\s*\n\s*\)/)
    // Y el frontend lo pone en la query con ese nombre exacto.
    expect(web).toContain("qs.set('expectedStartAttemptId', expectedStartAttemptId)")
  })

  it('el POST de stop-stream también lo acepta', () => {
    expect(rutas).toContain('readStartAttemptId(body?.expectedStartAttemptId)')
  })
})

// ─── El desenlace del cierre viaja al cliente ────────────────────────────────

describe('las rutas devuelven el desenlace, no un `ok` a secas', () => {
  const RUTA = resolve(aquí, '../routes/cameras.ts')
  const rutas = readFileSync(RUTA, 'utf8')
  const web = readFileSync(resolve(aquí, '../../../web/src/lib/sessionClose.ts'), 'utf8')

  it('los dos cierres HTTP propagan el resultado de stopStream', () => {
    // Un 200 no es un cierre: el cliente necesita el desenlace para saber si
    // puede olvidar su anotación.
    expect(Array.from(rutas.matchAll(/reply\.send\(\{ ok: true, \.\.\.resultado \}\)/g)))
      .toHaveLength(2)
    expect(Array.from(rutas.matchAll(/const resultado = await stopStream\(/g)))
      .toHaveLength(2)
  })

  it('el cliente sólo acepta los tres desenlaces del contrato', () => {
    for (const desenlace of ['ignored', 'attempt_released', 'session_closed']) {
      expect(web).toContain(`'${desenlace}'`)
    }
    // Y descarta cualquier otro valor en vez de creerle al cuerpo.
    expect(web).toMatch(/\? body\.outcome : undefined/)
  })

  it('un error HTTP no puede traer desenlace', () => {
    expect(web).toContain('if (!res.ok) return { emitted: true, status: res.status }')
  })

  it('`start-stream` devuelve el estado EFECTIVO, no el eco del cuerpo', () => {
    expect(rutas).toContain('startAttempt: describeStartAttempt({')
    // El eco crudo no vuelve.
    expect(rutas).not.toMatch(/^\s*startAttemptId,$/m)
  })
})
