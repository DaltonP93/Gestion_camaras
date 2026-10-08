// Ajustes pedidos sobre las capturas del prototipo (#188): timeline con horas, zoom
// y huecos; sincronía por celda con reloj común; grilla 16:9; marca de backend.
import { describe, it, expect } from 'vitest'
import { WINDOW, cameraById } from '../sim/mock'
import {
  ZOOM_LEVELS, DEFAULT_ZOOM, SYNC_TOLERANCE_S, centeredRange, cellOffset, followPlayhead, fmtTime, gapLabel, gapsInRange,
  MIN_FIT_CELL_PX, gridFit, gridShape, initialSync, isCellLoading, isOutOfSync, syncReducer, timelineTicks, zoomIn, zoomOut,
  type SyncAction, type SyncState,
} from './playback'
import { backendText, notAppliedGroups, notAppliedText, notExecutedText, EVENTS_BACKEND, LIVE_BACKEND, PLAYBACK_BACKEND } from './backend'
import { ALL_SECTIONS, SECTION_ACTIONS, fieldBackend } from '../settings/sections'

const H = 3600
const cam = (id: string) => cameraById(id)!
const level = (id: string) => ZOOM_LEVELS.find(z => z.id === id)!
const labels = (from: number, to: number, step: number) => {
  const out: string[] = []
  for (let t = from; t <= to; t += step) out.push(fmtTime(t))
  return out
}

describe('timeline: zoom y marcas horarias', () => {
  it('niveles 24 h / 6 h / 1 h / 15 min; + acerca y − aleja sin salirse de los extremos', () => {
    expect(ZOOM_LEVELS.map(z => [z.id, z.span])).toEqual([['24h', 24 * H], ['6h', 6 * H], ['1h', H], ['15m', 15 * 60]])
    expect(ZOOM_LEVELS[DEFAULT_ZOOM].id).toBe('6h')
    expect(zoomIn(DEFAULT_ZOOM)).toBe(2)
    expect(zoomIn(ZOOM_LEVELS.length - 1)).toBe(ZOOM_LEVELS.length - 1)
    expect(zoomOut(DEFAULT_ZOOM)).toBe(0)
    expect(zoomOut(0)).toBe(0)
  })
  it('el rango se centra en el cabezal y nunca sale del día', () => {
    expect(centeredRange(8 * H, 6 * H)).toEqual({ start: 5 * H, end: 11 * H })
    expect(centeredRange(1 * H, 6 * H)).toEqual({ start: 0, end: 6 * H })
    expect(centeredRange(23.5 * H, 6 * H)).toEqual({ start: 18 * H, end: 24 * H })
    expect(centeredRange(8 * H, 24 * H)).toEqual({ start: WINDOW.start, end: WINDOW.end })
  })
  it('marcas HH:MM correctas para cada nivel (cabezal a las 08:00)', () => {
    const at8 = (id: string) => timelineTicks(centeredRange(8 * H, level(id).span), level(id))
    const majors = (id: string) => at8(id).filter(t => t.major).map(t => t.label)
    expect(majors('24h')).toEqual(labels(0, 24 * H, 2 * H)) // 00:00, 02:00 … 24:00
    expect(majors('24h')).toHaveLength(13)
    expect(majors('24h')[12]).toBe('24:00')
    expect(majors('6h')).toEqual(labels(5 * H, 11 * H, 30 * 60)) // 05:00, 05:30 … 11:00
    expect(majors('1h')).toEqual(labels(7.5 * H, 8.5 * H, 5 * 60)) // 07:30, 07:35 … 08:30
    expect(majors('15m')).toEqual(labels(7 * H + 53 * 60, 8 * H + 7 * 60, 60)) // 07:53 … 08:07
    // Marcas menores sin texto entre las mayores.
    for (const id of ['24h', '6h', '1h', '15m']) {
      const z = level(id)
      const ticks = at8(id)
      expect(ticks.filter(t => !t.major).every(t => t.label === undefined && t.t % z.minor === 0)).toBe(true)
      expect(ticks.filter(t => t.major).every(t => t.t % z.major === 0)).toBe(true)
    }
  })
  it('el cabezal siempre queda visible: el rango se mantiene mientras está dentro y se recentra al salir', () => {
    const span = 1 * H
    const r = followPlayhead(7.5 * H, span, 8 * H)
    expect(r).toEqual({ start: 7.5 * H, end: 8.5 * H })
    expect(followPlayhead(7.5 * H, span, 8.4 * H)).toEqual(r)
    expect(followPlayhead(7.5 * H, span, 9 * H)).toEqual({ start: 8.5 * H, end: 9.5 * H })
  })
  it('fmtTime: HH:MM en minutos exactos, segundos si hace falta, 24:00 al final del día', () => {
    expect(fmtTime(0)).toBe('00:00')
    expect(fmtTime(24 * H)).toBe('24:00')
    expect(fmtTime(8 * H + 30)).toBe('08:00:30')
  })
})

describe('timeline: huecos por cámara', () => {
  it('huecos visibles en el rango con su inicio y fin reales', () => {
    const range = centeredRange(8 * H, 6 * H) // 05:00–11:00
    expect(gapsInRange(cam('cam-a5'), range)).toEqual([
      { start: 0, end: 8 * H, visibleStart: 5 * H, visibleEnd: 8 * H },
      { start: 8.25 * H, end: 9 * H, visibleStart: 8.25 * H, visibleEnd: 9 * H },
      { start: 9.5 * H, end: 11 * H, visibleStart: 9.5 * H, visibleEnd: 11 * H },
    ])
    expect(gapsInRange(cam('cam-a1'), range)).toEqual([])
    expect(gapLabel({ start: 8.25 * H, end: 9 * H })).toBe('Sin grabación de 08:15 a 09:00')
    expect(gapLabel({ start: 2 * H + 600, end: 2 * H + 2400 })).toBe('Sin grabación de 02:10 a 02:40')
  })
})

// ─── Sincronía por celda ──────────────────────────────────────────────────────

/** Arranca 4 celdas activas cargando y las deja listas (alineadas a las 08:00). */
function started(strict = false): { s: SyncState; now: number } {
  let s = initialSync(8 * H)
  if (strict) s = syncReducer(s, { type: 'strict', value: true })
  for (const i of [0, 1, 2, 3]) s = syncReducer(s, { type: 'open', index: i, nowMs: 0, loadMs: 500 + 100 * i })
  return { s: syncReducer(s, { type: 'tick', dtMs: 1000, nowMs: 1000, active: [0, 1, 2, 3] }), now: 1000 }
}
function run(s: SyncState, fromMs: number, ms: number, active = [0, 1, 2, 3], step = 200): SyncState {
  for (let t = fromMs + step; t <= fromMs + ms; t += step) s = syncReducer(s, { type: 'tick', dtMs: step, nowMs: t, active } as SyncAction)
  return s
}

describe('sincronía por celda (reloj común)', () => {
  it('al terminar de cargar, cada celda se alinea al reloj común', () => {
    let s = initialSync(8 * H)
    s = syncReducer(s, { type: 'open', index: 0, nowMs: 0, loadMs: 900 })
    expect(isCellLoading(s.cells[0])).toBe(true)
    s = syncReducer(s, { type: 'tick', dtMs: 200, nowMs: 200, active: [0] })
    expect(isCellLoading(s.cells[0])).toBe(true)
    s = syncReducer(s, { type: 'tick', dtMs: 800, nowMs: 1000, active: [0] })
    expect(s.cells[0]).toEqual({ pos: 8 * H, loadingUntil: 0, stalled: false })
  })
  it('por defecto una celda bloqueada NO detiene a las demás: el reloj sigue y las otras avanzan', () => {
    const start = started()
    const now = start.now
    let s = start.s
    expect(s.clock.strictSync).toBe(false)
    s = syncReducer(s, { type: 'play' })
    s = syncReducer(s, { type: 'stall', index: 1, value: true })
    s = run(s, now, 3000)
    expect(s.clock.t).toBeCloseTo(8 * H + 3, 6)
    for (const i of [0, 2, 3]) expect(s.cells[i].pos).toBeCloseTo(s.clock.t, 6)
    expect(s.cells[1].pos).toBe(8 * H) // congelada
    expect(cellOffset(s.cells[1], s.clock.t)).toBeCloseTo(3, 6)
    expect(isOutOfSync(s.cells[1], s.clock.t)).toBe(true)
    expect(isOutOfSync(s.cells[0], s.clock.t)).toBe(false)
  })
  it('al liberarse sigue atrasada (desfase constante) hasta que se resincroniza SÓLO esa celda', () => {
    let { s, now } = started()
    s = syncReducer(syncReducer(s, { type: 'play' }), { type: 'stall', index: 1, value: true })
    s = run(s, now, 2000); now += 2000
    s = syncReducer(s, { type: 'stall', index: 1, value: false })
    s = run(s, now, 2000); now += 2000
    expect(cellOffset(s.cells[1], s.clock.t)).toBeCloseTo(2, 6)
    const others = [0, 2, 3].map(i => s.cells[i])
    s = syncReducer(s, { type: 'resync', index: 1, nowMs: now, loadMs: 600 })
    expect(isCellLoading(s.cells[1])).toBe(true)
    expect([0, 2, 3].map(i => s.cells[i])).toEqual(others) // las demás no se tocan
    s = run(s, now, 1000); now += 1000
    expect(isCellLoading(s.cells[1])).toBe(false)
    expect(Math.abs(cellOffset(s.cells[1], s.clock.t))).toBeLessThan(SYNC_TOLERANCE_S)
    expect(s.cells[1].pos).toBeCloseTo(s.clock.t, 6)
  })
  it('una celda que carga tampoco detiene el reloj por defecto', () => {
    const start = started()
    const now = start.now
    let s = start.s
    s = syncReducer(syncReducer(s, { type: 'play' }), { type: 'resync', index: 2, nowMs: now, loadMs: 5000 })
    s = run(s, now, 2000)
    expect(s.clock.t).toBeCloseTo(8 * H + 2, 6)
    expect(isCellLoading(s.cells[2])).toBe(true)
  })
  it('"Esperar a todas" (estricto): con una celda bloqueada nadie avanza y nadie se desfasa', () => {
    let { s, now } = started(true)
    s = syncReducer(syncReducer(s, { type: 'play' }), { type: 'stall', index: 1, value: true })
    s = run(s, now, 2000); now += 2000
    expect(s.clock.t).toBe(8 * H)
    for (const i of [0, 1, 2, 3]) expect(s.cells[i].pos).toBe(8 * H)
    s = syncReducer(s, { type: 'stall', index: 1, value: false })
    s = run(s, now, 1000)
    expect(s.clock.t).toBeCloseTo(8 * H + 1, 6)
    for (const i of [0, 1, 2, 3]) expect(cellOffset(s.cells[i], s.clock.t)).toBeCloseTo(0, 6)
  })
  it('seek del reloj común: todas recargan desde el nuevo instante; el bloqueo simulado se conserva', () => {
    let { s } = started()
    s = syncReducer(s, { type: 'stall', index: 3, value: true })
    s = syncReducer(s, { type: 'seekAll', t: 9 * H, nowMs: 5000, loads: { 0: 500, 1: 900, 3: 500 } })
    expect(s.clock.t).toBe(9 * H)
    expect(Object.keys(s.cells).map(Number)).toEqual([0, 1, 3])
    expect(s.cells[3]).toMatchObject({ pos: 9 * H, stalled: true })
    s = syncReducer(s, { type: 'close', index: 3 })
    expect(s.cells[3]).toBeUndefined()
  })
  it('reabrir la misma cámara (cambio de pista) conserva el bloqueo simulado; otra cámara en esa celda no lo hereda', () => {
    let { s } = started()
    s = syncReducer(s, { type: 'stall', index: 2, value: true })
    s = syncReducer(s, { type: 'open', index: 2, nowMs: 2000, loadMs: 500, sameCamera: true })
    expect(s.cells[2].stalled).toBe(true)
    s = syncReducer(s, { type: 'open', index: 2, nowMs: 3000, loadMs: 500 })
    expect(s.cells[2].stalled).toBe(false)
  })
})

describe('grilla 16:9', () => {
  it('forma de la grilla y ancho para que las filas 16:9 llenen el alto del contenedor (sin estirar)', () => {
    expect([1, 4, 9, 16].map(gridShape)).toEqual([{ cols: 1, rows: 1 }, { cols: 2, rows: 2 }, { cols: 3, rows: 3 }, { cols: 4, rows: 4 }])
    expect(gridFit(4)).toEqual({
      width: 'min(100cqw, max(448px, calc((100cqh - 8px) / 2 * 1.777778 * 2 + 8px)))',
      minHeight: '256px', // 2 filas de 220×123,75 + 8 px
    })
    expect(gridFit(9).width).toBe('min(100cqw, max(676px, calc((100cqh - 16px) / 3 * 1.777778 * 3 + 16px)))')
    expect(gridFit(1).minHeight).toBe('124px')
    expect(gridFit(4, 8, 240).minHeight).toBe('278px')
  })
  it('con el alto mínimo, el ancho ajustado da celdas del ancho mínimo: la grilla no desborda su contenedor', () => {
    for (const cells of [1, 4, 9]) {
      const { cols, rows } = gridShape(cells)
      const h = Number(gridFit(cells).minHeight.replace('px', ''))
      const fitWidth = ((h - (rows - 1) * 8) / rows) * (16 / 9) * cols + (cols - 1) * 8
      expect(fitWidth).toBeGreaterThanOrEqual(cols * MIN_FIT_CELL_PX + (cols - 1) * 8)
      expect(fitWidth - (cols * MIN_FIT_CELL_PX + (cols - 1) * 8)).toBeLessThan(cols * 2)
    }
  })
})

describe('marca de backend (simulado / existente)', () => {
  it('todas las secciones de configuración declaran su estado de backend', () => {
    for (const s of ALL_SECTIONS) {
      expect(['simulado', 'existente'], s.id).toContain(s.backend.kind)
      if (s.backend.kind === 'existente') expect(s.backend.endpoint.trim().length, s.id).toBeGreaterThan(0)
      for (const f of s.fields ?? []) {
        const st = fieldBackend(s, f)
        expect(backendText(st)).toMatch(/^(Simulado — no se aplica en el backend|Existe en backend \(.+\) — no conectado en el prototipo)/)
      }
    }
    // Las secciones nuevas (sin modelo en la API) quedan marcadas como simuladas.
    const kind = (id: string) => ALL_SECTIONS.find(s => s.id === id)!.backend.kind
    expect(kind('general')).toBe('simulado')
    expect(kind('eventos-almacenamiento')).toBe('simulado')
    expect(kind('seguridad')).toBe('existente')
  })
  it('un control puede diferir de su sección (campos que el modelo real no tiene)', () => {
    const det = ALL_SECTIONS.find(s => s.id === 'deteccion')!
    expect(fieldBackend(det, det.fields!.find(f => f.key === 'motionSensitivity')!).kind).toBe('simulado')
    expect(fieldBackend(det, det.fields!.find(f => f.key === 'minScore')!).kind).toBe('existente')
    const gen = ALL_SECTIONS.find(s => s.id === 'general')!
    expect(fieldBackend(gen, gen.fields!.find(f => f.key === 'siteName')!).kind).toBe('existente')
  })
  it('guardar o ejecutar dice explícitamente que no se aplicó', () => {
    expect(notAppliedText({ kind: 'simulado' })).toBe('No se aplicó: es una configuración simulada, sin backend.')
    expect(notAppliedText({ kind: 'existente', endpoint: 'PUT /api/x' })).toBe('No se aplicó en el backend: el prototipo no llama a PUT /api/x.')
    expect(notExecutedText({ kind: 'simulado' })).toBe('No se ejecutó: es una acción simulada, sin backend.')
    expect(notExecutedText({ kind: 'existente', endpoint: 'POST /api/x' })).toBe('No se ejecutó en el backend: el prototipo no llama a POST /api/x.')
    for (const a of Object.values(SECTION_ACTIONS)) expect(a.endpoint).toMatch(/^POST \/api\//)
  })
  it('el aviso de guardar sale de los controles cambiados: agrupa simulados y existentes (por endpoint)', () => {
    const sim = { kind: 'simulado' } as const
    expect(notAppliedGroups([{ label: 'Zona horaria', status: sim }, { label: 'Idioma', status: { kind: 'simulado', note: 'otra nota' } }])).toEqual([
      { kind: 'simulado', labels: ['Zona horaria', 'Idioma'], text: 'No se aplicó: es una configuración simulada, sin backend.' },
    ])
    expect(notAppliedGroups([
      { label: 'Zona horaria', status: sim },
      { label: 'Nombre del sitio', status: { kind: 'existente', endpoint: 'PUT /api/a' } },
      { label: 'Tema', status: { kind: 'existente', endpoint: 'PUT /api/b' } },
      { label: 'Color', status: { kind: 'existente', endpoint: 'PUT /api/a' } },
    ])).toEqual([
      { kind: 'simulado', labels: ['Zona horaria'], text: 'No se aplicó: es una configuración simulada, sin backend.' },
      { kind: 'existente', labels: ['Nombre del sitio', 'Color'], text: 'No se aplicó en el backend: el prototipo no llama a PUT /api/a.' },
      { kind: 'existente', labels: ['Tema'], text: 'No se aplicó en el backend: el prototipo no llama a PUT /api/b.' },
    ])
  })
  it('Vivo, Grabaciones y Eventos: cada control sin backend conectado tiene su marca', () => {
    const all = { ...LIVE_BACKEND, ...PLAYBACK_BACKEND, ...EVENTS_BACKEND }
    for (const st of Object.values(all)) expect(backendText(st)).toMatch(/^(Simulado — no se aplica en el backend|Existe en backend \(.+\) — no conectado en el prototipo)/)
    // Lo que sólo existe en el prototipo (reloj común/desfase sin video, bloqueo simulado) queda como simulado.
    expect(PLAYBACK_BACKEND.sync.kind).toBe('simulado')
    expect(PLAYBACK_BACKEND.stallSim.kind).toBe('simulado')
    expect(LIVE_BACKEND.video.kind).toBe('existente')
  })
})
