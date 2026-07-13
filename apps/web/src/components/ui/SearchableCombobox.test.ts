// Test del matcher del combobox: búsqueda insensible a mayúsculas y tildes,
// sobre label + sublabel + group + keywords.
import { describe, it, expect } from 'vitest'
import { optionMatchesQuery, type ComboOption } from './SearchableCombobox'

const cam: ComboOption = {
  value: 'c1',
  label: 'Cámara Recepción',
  group: 'NVR Planta Baja',
  sublabel: 'ch 24 · online',
  keywords: 'NVR Planta Baja 24',
}

describe('optionMatchesQuery', () => {
  it('coincide con consulta vacía', () => {
    expect(optionMatchesQuery(cam, '')).toBe(true)
    expect(optionMatchesQuery(cam, '   ')).toBe(true)
  })

  it('es insensible a mayúsculas/minúsculas', () => {
    expect(optionMatchesQuery(cam, 'RECEPCION')).toBe(true)
    expect(optionMatchesQuery(cam, 'cámara')).toBe(true)
  })

  it('es insensible a tildes en ambos sentidos', () => {
    expect(optionMatchesQuery(cam, 'recepcion')).toBe(true)   // sin tilde busca con tilde
    expect(optionMatchesQuery(cam, 'camara')).toBe(true)
    expect(optionMatchesQuery({ ...cam, label: 'Camara' }, 'cámara')).toBe(true)
  })

  it('busca en NVR (group/keywords) y canal', () => {
    expect(optionMatchesQuery(cam, 'planta baja')).toBe(true)
    expect(optionMatchesQuery(cam, 'ch 24')).toBe(true)
    expect(optionMatchesQuery(cam, '24')).toBe(true)
  })

  it('no coincide cuando no hay match', () => {
    expect(optionMatchesQuery(cam, 'estacionamiento')).toBe(false)
    expect(optionMatchesQuery(cam, 'ch 99')).toBe(false)
  })
})
