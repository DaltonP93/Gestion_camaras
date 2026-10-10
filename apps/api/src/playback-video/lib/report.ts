// apps/api/src/playback-video/lib/report.ts
//
// Reporte por corrida: un JSON por escenario y un RESUMEN.md al final. Contiene
// sólo números, estados y eventos saneados (sin tokens, cookies ni credenciales;
// las IP son las ficticias de la suite). Nunca video ni imágenes.

import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'

export interface Check {
  id: string
  title: string
  /** Objetivo (texto) que se exige. */
  target: string
  measured: unknown
  ok: boolean
  kind: 'invariante' | 'defecto'
}

/** ¿Se ejecutan los defectos conocidos como pruebas (fallan hoy)? */
export const RUN_KNOWN_DEFECTS = process.env.RUN_KNOWN_DEFECTS === '1'

const TOKEN_RE = /([?&](?:token|t)=)[^&\s"']+/g
export function sanitize(s: string): string {
  return s.replace(TOKEN_RE, '$1…').replace(/rtsp:\/\/[^@/\s]+@/g, 'rtsp://[CREDENCIALES-OCULTAS]@')
}

export class ScenarioReport {
  readonly checks: Check[] = []
  readonly metrics: Record<string, unknown> = {}
  readonly notes: string[] = []
  readonly startedAt = new Date().toISOString()

  constructor(readonly file: string, readonly scenario: string, readonly reportDir: string, readonly context: Record<string, unknown>) {}

  /**
   * Invariante que DEBE cumplirse hoy: se registra y se afirma con expect.soft
   * (el escenario sigue midiendo aunque falle; la prueba queda en rojo).
   */
  invariant(id: string, title: string, target: string, measured: unknown, ok: boolean): void {
    this.checks.push({ id, title, target, measured, ok, kind: 'invariante' })
    expect.soft(ok, `${id} — ${title}. Objetivo: ${target}. Medido: ${JSON.stringify(measured)}`).toBe(true)
  }

  /**
   * Trinquete: invariante que fija el valor MEDIDO HOY (más un margen) de algo cuyo
   * objetivo ideal es un defecto conocido. Falla si empeora; el defecto opt-in sigue
   * exigiendo el objetivo. Se cuenta como invariante.
   */
  ratchet(id: string, defectId: string, title: string, target: string, measured: unknown, ok: boolean): void {
    this.invariant(id, `${title} (trinquete de ${defectId})`, target, measured, ok)
  }

  /** Registra una invariante SIN afirmarla (para hooks, donde expect.soft no aplica; quien llama afirma). */
  record(id: string, title: string, target: string, measured: unknown, ok: boolean): void {
    this.checks.push({ id, title, target, measured, ok, kind: 'invariante' })
  }

  /** Defecto conocido: se mide y se registra; lo afirma `defectTest` sólo con RUN_KNOWN_DEFECTS=1. */
  defect(id: string, title: string, target: string, measured: unknown, ok: boolean): void {
    this.checks.push({ id, title, target, measured, ok, kind: 'defecto' })
  }

  metric(key: string, value: unknown): void { this.metrics[key] = value }
  note(s: string): void { this.notes.push(s) }

  get(id: string): Check | undefined { return this.checks.find((c) => c.id === id) }

  write(extra: Record<string, unknown> = {}): string {
    fs.mkdirSync(this.reportDir, { recursive: true })
    const file = path.join(this.reportDir, `${this.file}--${this.scenario}.json`)
    const body = JSON.stringify({
      file: this.file, scenario: this.scenario, startedAt: this.startedAt, finishedAt: new Date().toISOString(),
      context: this.context, checks: this.checks, metrics: this.metrics, notes: this.notes, ...extra,
    }, null, 1)
    fs.writeFileSync(file, sanitize(body))
    return file
  }
}

/** Mensaje de fallo de un defecto: objetivo y valor medido. */
export function defectMessage(c: Check | undefined, id: string): string {
  if (!c) return `${id}: el escenario no llegó a medirlo (ver la prueba del escenario)`
  return `DEFECTO ${c.id} — ${c.title}. Objetivo: ${c.target}. Medido hoy: ${JSON.stringify(c.measured)}`
}

/** Compone RESUMEN.md a partir de los JSON del directorio. */
export function writeSummary(reportDir: string, header: Record<string, unknown>): string | null {
  if (!fs.existsSync(reportDir)) return null
  const files = fs.readdirSync(reportDir).filter((f) => f.endsWith('.json') && f !== 'resumen.json').sort()
  const reports = files.map((f) => JSON.parse(fs.readFileSync(path.join(reportDir, f), 'utf8')) as {
    file: string; scenario: string; checks: Check[]; metrics: Record<string, unknown>; notes: string[]; context: Record<string, unknown>
  })
  const fmt = (v: unknown) => sanitize(JSON.stringify(v)).replace(/\|/g, '\\|').slice(0, 220)
  const lines: string[] = [
    '# Reproducción con video real — resumen de corrida', '',
    ...Object.entries(header).map(([k, v]) => `- **${k}:** ${typeof v === 'string' ? v : JSON.stringify(v)}`), '',
    'Mediciones en el entorno aislado (NVR simulado). No son afirmaciones de rendimiento con NVR reales.', '',
  ]
  for (const r of reports) {
    lines.push(`## ${r.file} · ${r.scenario}`, '')
    lines.push('| | Id | Qué | Objetivo | Medido |', '|---|---|---|---|---|')
    for (const c of r.checks) {
      const mark = c.ok ? 'OK' : (c.kind === 'defecto' ? 'DEFECTO' : 'FALLA')
      lines.push(`| ${mark} | ${c.id} | ${c.title} | ${c.target} | ${fmt(c.measured)} |`)
    }
    if (r.notes.length) lines.push('', ...r.notes.map((n) => `- ${n}`))
    lines.push('')
  }
  const all = reports.flatMap((r) => r.checks)
  const summary = {
    ...header,
    invariantes: { total: all.filter((c) => c.kind === 'invariante').length, fallidas: all.filter((c) => c.kind === 'invariante' && !c.ok).map((c) => c.id) },
    defectos: { total: all.filter((c) => c.kind === 'defecto').length, presentes: all.filter((c) => c.kind === 'defecto' && !c.ok).map((c) => c.id) },
  }
  fs.writeFileSync(path.join(reportDir, 'resumen.json'), JSON.stringify(summary, null, 1))
  const out = path.join(reportDir, 'RESUMEN.md')
  fs.writeFileSync(out, lines.join('\n'))
  return out
}
