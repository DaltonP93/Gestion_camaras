// Guarda de versiones del editor de zonas. Prueba de compatibilidad (#185 §2.4):
// react-konva 18 sobre React 19 se instala sin aviso (su peer es `react >=18`) y
// falla en ejecución ('ReactCurrentOwner'); react-konva 19 exige React 19. React y
// react-konva deben compartir versión mayor y subir JUNTOS.
import { describe, it, expect } from 'vitest'
import pkg from '../../package.json'

const major = (v: string) => Number(v.replace(/^[^\d]*/, '').split('.')[0])

describe('versiones del editor de zonas', () => {
  const deps = pkg.dependencies as Record<string, string>
  it('react y react-konva comparten versión mayor', () => {
    expect(major(deps['react-konva'])).toBe(major(deps.react))
    expect(major(deps['react-dom'])).toBe(major(deps.react))
  })
  it('react-konva y konva fijados exactos (sin ^ ni ~)', () => {
    expect(deps['react-konva']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(deps.konva).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
