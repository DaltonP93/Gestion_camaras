// Las marcas "Existe en backend (<endpoint>)" no pueden inventar endpoints ni campos.
// Se verifican contra el código REAL de apps/api y prisma/ (se lee el código fuente;
// no contacta ningún servidor):
//   - cada endpoint declarado en el prototipo (secciones, controles, acciones, Vivo,
//     Grabaciones, Eventos) corresponde a una ruta registrada (server.ts + routes/*.ts);
//   - cada "Modelo.campo" citado en una marca existe en prisma/schema.prisma;
//   - cada CONTROL de Configuración marcado 'existente' tiene su campo en el backend:
//     la ruta de escritura citada valida el cuerpo con un esquema zod que tiene esa
//     clave y escribe un modelo Prisma que tiene esa columna;
//   - una tabla escrita a mano (no derivada de sections.ts) fija los controles
//     simulados críticos, con la evidencia del código de que no existen.
import { describe, it, expect } from 'vitest'
import { ALL_SECTIONS, SECTION_ACTIONS, fieldBackend } from '../settings/sections'
import { EVENTS_BACKEND, LIVE_BACKEND, PLAYBACK_BACKEND, type BackendStatus } from './backend'

const SERVER = import.meta.glob('../../../api/src/server.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const ROUTES = import.meta.glob('../../../api/src/routes/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const SCHEMA = import.meta.glob('../../../../prisma/schema.prisma', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const HEALTH_WORKER = import.meta.glob('../../../api/src/jobs/healthWorker.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const only = (files: Record<string, string>, what: string): string => {
  const values = Object.values(files)
  expect(values, what).toHaveLength(1)
  return values[0]
}

type Route = { method: string; path: string; file: string; handler: string }
const norm = (p: string) => (p.replace(/:[A-Za-z]+/g, ':p').replace(/\/+$/, '') || '/')

function routeSource(file: string): string | undefined {
  return Object.entries(ROUTES).find(([k]) => k.endsWith(`/routes/${file}.ts`))?.[1]
}

/**
 * Rutas registradas: prefijo de server.ts + ruta de cada archivo de routes/, con el
 * archivo y el código de su handler (desde su registro hasta el registro siguiente).
 */
function apiRoutes(): Route[] {
  const server = only(SERVER, 'server.ts')
  const fileOf = new Map<string, string>() // identificador importado → archivo
  for (const m of server.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+'\.\/routes\/(\w+)'/g)) {
    const names = m[1] ? m[1].split(',').map(n => n.trim()) : [m[2]]
    for (const n of names) fileOf.set(n, m[3])
  }
  const out: Route[] = []
  for (const m of server.matchAll(/(?:server|app)\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']*)'/g)) {
    out.push({ method: m[1].toUpperCase(), path: norm(m[2]), file: 'server', handler: '' })
  }
  for (const m of server.matchAll(/register\((\w+),\s*\{\s*prefix:\s*'([^']+)'/g)) {
    const file = fileOf.get(m[1])
    const src = file && routeSource(file)
    if (!file || !src) continue
    const regs = Array.from(src.matchAll(/^\s*\w+\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]*)['"`]/gm))
    regs.forEach((r, k) => {
      out.push({
        method: r[1].toUpperCase(),
        path: norm(m[2] + (r[2] === '/' ? '' : r[2])),
        file,
        handler: src.slice(r.index, k + 1 < regs.length ? regs[k + 1].index : src.length),
      })
    })
  }
  return out
}

/** "GET/PUT /api/x · Modelo.campo · /api/y/* (nota)" → [{ métodos, ruta }] (se omiten campos de modelo). */
function declared(endpoint: string): Array<{ methods: string[]; path: string; prefix: boolean }> {
  return endpoint.split(' · ').flatMap(part => {
    const m = part.trim().replace(/\s*\(.*\)$/, '').match(/^(?:([A-Z/]+)\s+)?(\/api\/\S+)$/)
    if (!m) return []
    const prefix = m[2].endsWith('/*')
    return [{ methods: m[1] ? m[1].split('/') : [], path: norm(prefix ? m[2].slice(0, -2) : m[2]), prefix }]
  })
}

/** Todas las marcas de backend del prototipo, con su lugar (para los mensajes). */
function allStatuses(): Array<{ where: string; status: BackendStatus }> {
  const out: Array<{ where: string; status: BackendStatus }> = []
  for (const s of ALL_SECTIONS) {
    out.push({ where: `sección ${s.id}`, status: s.backend })
    for (const f of s.fields ?? []) if (f.backend) out.push({ where: `${s.id}.${f.key}`, status: f.backend })
  }
  for (const [k, a] of Object.entries(SECTION_ACTIONS)) out.push({ where: k, status: { kind: 'existente', endpoint: a.endpoint } })
  for (const [group, entries] of Object.entries({ LIVE_BACKEND, PLAYBACK_BACKEND, EVENTS_BACKEND })) {
    for (const [k, s] of Object.entries(entries as Record<string, BackendStatus>)) out.push({ where: `${group}.${k}`, status: s })
  }
  return out
}

function allDeclared(): Array<{ where: string; endpoint: string }> {
  return allStatuses().flatMap(({ where, status }) => (status.kind === 'existente' ? [{ where, endpoint: status.endpoint }] : []))
}

// ─── prisma/schema.prisma ─────────────────────────────────────────────────────

interface Column { type: string; jsonDefaultKeys?: string[] }

/** Modelos → columnas (con las claves del @default de las columnas Json). */
function prismaModels(): Map<string, Map<string, Column>> {
  const schema = only(SCHEMA, 'prisma/schema.prisma')
  const models = new Map<string, Map<string, Column>>()
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const cols = new Map<string, Column>()
    for (const line of m[2].split('\n')) {
      const c = line.match(/^\s*([A-Za-z]\w*)\s+([A-Za-z]\w*)(\[\])?\??(.*)$/)
      if (!c) continue
      const col: Column = { type: c[2] }
      const def = c[4].match(/@default\("((?:[^"\\]|\\.)*)"\)/)
      if (c[2] === 'Json' && def) col.jsonDefaultKeys = Object.keys(JSON.parse(JSON.parse(`"${def[1]}"`)) as object)
      cols.set(c[1], col)
    }
    models.set(m[1], cols)
  }
  return models
}

/** Accesor del cliente Prisma (`prisma.alertSettings`) → modelo (`AlertSettings`). */
const modelOfAccessor = (models: Map<string, unknown>, accessor: string) =>
  Array.from(models.keys()).find(name => name[0].toLowerCase() + name.slice(1) === accessor)

// ─── Esquemas zod y handlers de apps/api/src/routes ───────────────────────────

/**
 * Claves de primer nivel de `const <name> = z.object({ … })`: se descartan los
 * comentarios, el contenido de los textos y todo lo anidado (objetos internos).
 */
function zodKeys(src: string, name: string): string[] | null {
  const start = src.search(new RegExp(`const\\s+${name}\\s*=\\s*z\\.object\\(\\{`))
  if (start < 0) return null
  let i = src.indexOf('{', start) + 1
  let depth = 0
  let flat = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1
      if (depth === 0) flat += '""'
      i = j + 1
      continue
    }
    if ('({['.includes(ch)) depth++
    else if (')}]'.includes(ch)) {
      if (depth === 0) break // cierre del z.object({ … })
      depth--
      i++
      continue
    }
    if (depth === 0) flat += ch
    i++
  }
  return Array.from(flat.matchAll(/(?:^|[,\n])\s*(\w+)\s*:/g), m => m[1])
}

/** Esquemas zod con los que el handler valida el cuerpo (`schema.parse(request.body)`). */
const bodySchemas = (handler: string) =>
  Array.from(handler.matchAll(/(\w+)\.(?:safeParse|parse|parseAsync)\(\s*request\.body/g), m => m[1])
/** Accesores de los modelos que el handler escribe (`prisma.<modelo>.upsert/update/create…`). */
const writtenAccessors = (handler: string) =>
  Array.from(handler.matchAll(/prisma\.(\w+)\.(?:upsert|update|updateMany|create|createMany)\(/g), m => m[1])

const WRITE_METHODS = new Set(['PUT', 'POST', 'PATCH'])

/**
 * Problemas del campo real de un control 'existente': alguna ruta de escritura
 * citada debe validar el cuerpo con un esquema zod que tenga `columna` y escribir un
 * modelo que tenga esa columna (y, para 'columna.CLAVE', CLAVE entre las claves del
 * @default de esa columna Json). Sin problemas ⇒ [].
 */
function fieldProblems(where: string, endpoint: string, apiField: string, routes: Route[], models: Map<string, Map<string, Column>>): string[] {
  const [column, jsonKey] = apiField.split('.')
  const writes = declared(endpoint).flatMap(p => p.methods.filter(m => WRITE_METHODS.has(m)).map(method => ({ method, path: p.path })))
  if (!writes.length) return [`${where}: "${endpoint}" no cita una ruta de escritura (PUT/POST/PATCH) para guardar ${apiField}`]
  const hits = writes.flatMap(w => routes.filter(r => r.method === w.method && r.path === w.path))
  if (!hits.length) return [`${where}: ninguna ruta de escritura de "${endpoint}" existe`]
  const reasons: string[] = []
  for (const r of hits) {
    const src = routeSource(r.file) ?? ''
    const schemas = bodySchemas(r.handler)
    const keys = schemas.flatMap(n => zodKeys(src, n) ?? [])
    const written = writtenAccessors(r.handler).map(a => modelOfAccessor(models, a)).filter((m): m is string => !!m)
    const cols = written.flatMap(m => { const c = models.get(m)!.get(column); return c ? [{ model: m, col: c }] : [] })
    const route = `${r.method} ${r.path} (routes/${r.file}.ts)`
    if (!keys.includes(column)) { reasons.push(`${route}: el esquema del cuerpo (${schemas.join(', ') || 'ninguno'}) no tiene "${column}"`); continue }
    if (!cols.length) { reasons.push(`${route}: los modelos que escribe (${written.join(', ') || 'ninguno'}) no tienen la columna "${column}"`); continue }
    if (jsonKey && !cols.some(c => c.col.jsonDefaultKeys?.includes(jsonKey))) { reasons.push(`${route}: ${cols[0].model}.${column} no tiene la clave "${jsonKey}"`); continue }
    return []
  }
  return [`${where} (${apiField}): ${reasons.join(' | ')}`]
}

/** Controles de Configuración con su estado efectivo y su campo real declarado. */
function settingsFields() {
  return ALL_SECTIONS.flatMap(s => (s.fields ?? []).map(f => ({ id: `${s.id}.${f.key}`, status: fieldBackend(s, f), apiField: f.apiField ?? f.key })))
}

describe('endpoints declarados en las marcas de backend', () => {
  const routes = apiRoutes()
  it('se leyeron las rutas de apps/api', () => {
    expect(routes.length).toBeGreaterThan(100)
    const pairs = routes.map(r => ({ method: r.method, path: r.path }))
    expect(pairs).toContainEqual({ method: 'PUT', path: '/api/security/settings' })
    expect(pairs).toContainEqual({ method: 'POST', path: '/api/cameras/:p/ptz' })
  })
  it('cada endpoint "existente" corresponde a una ruta real (método y ruta)', () => {
    const missing: string[] = []
    let checked = 0
    for (const { where, endpoint } of allDeclared()) {
      const parts = declared(endpoint)
      expect(parts.length, `${where}: "${endpoint}" no nombra ninguna ruta /api`).toBeGreaterThan(0)
      for (const p of parts) {
        const candidates = routes.filter(r => (p.prefix ? r.path.startsWith(`${p.path}/`) : p.methods.length ? r.path === p.path : r.path === p.path || r.path.startsWith(`${p.path}/`)))
        const methods = p.methods.length ? p.methods : ['*']
        for (const method of methods) {
          checked++
          if (!candidates.some(r => method === '*' || r.method === method)) missing.push(`${where}: ${method} ${p.path}`)
        }
      }
    }
    expect(missing).toEqual([])
    expect(checked).toBeGreaterThan(30)
  })
})

describe('campos reales detrás de las marcas (prisma/schema.prisma y esquemas zod de apps/api)', () => {
  const routes = apiRoutes()
  const models = prismaModels()

  it('se leyeron los modelos de schema.prisma y los esquemas zod de las rutas', () => {
    expect(models.size).toBeGreaterThan(20)
    expect(models.get('AppearanceSettings')?.has('siteName')).toBe(true)
    expect(models.get('AlertSettings')?.get('alertTypes')?.jsonDefaultKeys).toContain('CAMERA_OFFLINE')
    const security = routes.find(r => r.method === 'PUT' && r.path === '/api/security/settings')!
    expect(bodySchemas(security.handler)).toEqual(['settingsSchema'])
    expect(writtenAccessors(security.handler)).toContain('securitySettings')
    expect(zodKeys(routeSource(security.file)!, 'settingsSchema')).toContain('maxSessions')
    // Lo anidado no cuenta como clave del cuerpo: "points" es de cada zona, no de la configuración.
    const analyticsKeys = zodKeys(routeSource('analytics')!, 'configSchema')!
    expect(analyticsKeys).toEqual(expect.arrayContaining(['enabled', 'classes', 'minConfidence', 'zones']))
    expect(analyticsKeys).not.toContain('points')
  })

  it('cada "Modelo.campo" citado en una marca existe en schema.prisma', () => {
    const missing: string[] = []
    let checked = 0
    for (const { where, status } of allStatuses()) {
      const text = `${status.kind === 'existente' ? status.endpoint : ''} ${status.note ?? ''}`
      for (const m of text.matchAll(/\b([A-Z][A-Za-z]+)\.([a-z]\w*)/g)) {
        checked++
        if (!models.get(m[1])?.has(m[2])) missing.push(`${where}: ${m[1]}.${m[2]}`)
      }
    }
    expect(missing).toEqual([])
    expect(checked).toBeGreaterThanOrEqual(2)
  })

  it('cada control de Configuración marcado "existente" tiene su campo en la ruta de escritura citada y en el modelo que escribe', () => {
    const problems: string[] = []
    let checked = 0
    for (const f of settingsFields()) {
      if (f.status.kind !== 'existente') continue
      checked++
      problems.push(...fieldProblems(f.id, f.status.endpoint, f.apiField, routes, models))
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(20)
  })

  // Escrita a mano leyendo el backend (NO derivada de sections.ts): si alguien cambia
  // la marca de uno de estos controles, esta tabla falla.
  const EXPECTED: Record<string, BackendStatus['kind']> = {
    'general.siteName': 'existente', // AppearanceSettings.siteName · PUT /api/appearance
    'general.timezone': 'simulado', // ningún modelo ni esquema tiene zona horaria del sistema
    'general.language': 'simulado', // ídem idioma
    'alertas.detection': 'simulado', // alertTypes no trae tipos de detección de análisis
    'deteccion.motionSensitivity': 'simulado', // CameraAnalyticsConfig no tiene sensibilidad de movimiento
    'eventos-almacenamiento.retainDays': 'simulado', // sólo variable de entorno, sin API
  }

  it('tabla esperada: estado de los controles críticos', () => {
    const actual = Object.fromEntries(settingsFields().filter(f => f.id in EXPECTED).map(f => [f.id, f.status.kind]))
    expect(actual).toEqual(EXPECTED)
  })

  it('evidencia de la tabla: los controles simulados críticos no existen en el backend', () => {
    const columns = new Set(Array.from(models.values()).flatMap(cols => Array.from(cols.keys())))
    // Zona horaria e idioma: ninguna columna de ningún modelo; tampoco en PUT /api/appearance.
    const appearance = routes.find(r => r.method === 'PUT' && r.path === '/api/appearance')!
    const appearanceKeys = zodKeys(routeSource(appearance.file)!, bodySchemas(appearance.handler)[0])!
    expect(appearanceKeys).toContain('siteName')
    for (const name of ['timezone', 'timeZone', 'language', 'locale']) {
      expect(columns.has(name), `columna ${name}`).toBe(false)
      expect(appearanceKeys, `PUT /api/appearance: ${name}`).not.toContain(name)
    }
    // Detección: AlertSettings.alertTypes no trae ningún tipo de detección de análisis;
    // el aviso por detección se configura por cámara (CameraAnalyticsConfig.alertConfig).
    const detectionTypes = ['PERSON_DETECTED', 'VEHICLE_DETECTED', 'ZONE_INTRUSION', 'LINE_CROSSING', 'LOITERING', 'OCCUPANCY_LIMIT']
    const alertTypes = models.get('AlertSettings')!.get('alertTypes')!.jsonDefaultKeys!
    for (const t of detectionTypes) expect(alertTypes, t).not.toContain(t)
    expect(fieldProblems('alertas.detection', 'GET/PUT /api/alerts/settings', 'detection', routes, models)).not.toEqual([])
    expect(models.get('CameraAnalyticsConfig')!.has('alertConfig')).toBe(true)
    // Sensibilidad de movimiento: ni clave de PUT /api/analytics/config/:cameraId ni columna.
    expect(fieldProblems('deteccion.motionSensitivity', 'PUT /api/analytics/config/:cameraId', 'motionSensitivity', routes, models)).not.toEqual([])
    // Retención de eventos: ninguna columna; hoy es la variable de entorno de la purga diaria.
    expect(Array.from(columns).filter(c => /retain|retention/i.test(c))).toEqual([])
    expect(only(HEALTH_WORKER, 'jobs/healthWorker.ts')).toMatch(/process\.env\.ANALYTICS_RETENTION_DAYS/)
  })
})
