// Integridad del código portado de Frigate v0.18.0 (MIT): debajo del encabezado
// de atribución, cada archivo "idéntico" debe seguir siendo byte a byte el
// original (hash en vendor/frigate/UPSTREAM.json, calculado sobre el commit
// 77a66e7). Si alguien lo edita, esta prueba falla: las adaptaciones van en
// sustitutos (prototype/zones/shims) o en archivos propios, no en el portado.
import { describe, it, expect } from 'vitest'
import manifest from './frigate/UPSTREAM.json'
import license from './frigate/LICENSE?raw'

// Contenido crudo vía Vite (sin APIs de Node): mismo texto que hay en disco.
const sources = import.meta.glob('./frigate/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const HEADER_END = '/* ---- fin del encabezado de portado ---- */\n'

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

describe('código portado de Frigate', () => {
  it('fija el commit de v0.18.0', () => {
    expect(manifest.commit).toBe('77a66e75c61862b048a07c1295877f4b31343504')
  })

  for (const [file, { original, sha256: expected }] of Object.entries(manifest.identical)) {
    it(`${file} es idéntico a ${original} bajo el encabezado MIT`, async () => {
      const text = sources[`./frigate/${file}`]
      expect(text, 'archivo portado ausente').toBeDefined()
      expect(text).toContain('The MIT License')
      expect(text).toContain(`Archivo original: ${original}`)
      const [, body] = text.split(HEADER_END)
      expect(body, 'falta el marcador de fin de encabezado').toBeDefined()
      expect(await sha256(body)).toBe(expected)
    })
  }

  it('todo archivo portado figura en el manifiesto (idéntico o reducido)', () => {
    const listed = new Set([...Object.keys(manifest.identical), ...Object.keys(manifest.reduced)])
    for (const key of Object.keys(sources)) expect(listed, key).toContain(key.replace('./frigate/', ''))
  })

  it('incluye el aviso de licencia MIT completo', () => {
    expect(license).toContain('Permission is hereby granted, free of charge')
    expect(license).toContain('Frigate, Inc.')
  })
})
