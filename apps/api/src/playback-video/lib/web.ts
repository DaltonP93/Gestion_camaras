// apps/api/src/playback-video/lib/web.ts
//
// Acceso a las dependencias de apps/web (vite, @vitejs/plugin-react, tailwind,
// playwright-core) SIN agregarlas a apps/api: se importan desde
// apps/web/node_modules por su entrada ESM. Requiere `npm ci` en ambas apps.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WEB_ROOT } from './run-config'

type ExportEntry = string | { import?: ExportEntry; default?: ExportEntry; [k: string]: unknown } | undefined

function pickImport(e: ExportEntry): string | undefined {
  if (!e) return undefined
  if (typeof e === 'string') return e
  return pickImport(e.import as ExportEntry) ?? pickImport(e.default as ExportEntry)
}

export async function importFromWeb(name: string): Promise<any> {
  const dir = path.join(WEB_ROOT, 'node_modules', name)
  const pkgFile = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgFile)) throw new Error(`suite de video: falta ${name} en apps/web/node_modules (correr npm ci en apps/web)`)
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const exp = pkg.exports && typeof pkg.exports === 'object' && '.' in pkg.exports ? pkg.exports['.'] : pkg.exports
  const entry = pickImport(exp as ExportEntry) ?? pkg.module ?? pkg.main ?? 'index.js'
  return import(pathToFileURL(path.join(dir, entry)).href)
}

/**
 * PostCSS de la web con el tailwind.config.js REAL pero `content` absoluto: tailwind
 * resuelve esos globs contra el cwd, y la suite corre con cwd = apps/api (sin esto
 * el CSS sale vacío y el layout no es el de producción).
 */
export async function webPostcss(): Promise<{ plugins: unknown[] }> {
  const tw = await importFromWeb('tailwindcss')
  const ap = await importFromWeb('autoprefixer')
  const cfg = (await import(pathToFileURL(path.join(WEB_ROOT, 'tailwind.config.js')).href)).default
  const content = (cfg.content as string[]).map((c) => path.join(WEB_ROOT, c))
  return { plugins: [(tw.default ?? tw)({ ...cfg, content }), (ap.default ?? ap)()] }
}
