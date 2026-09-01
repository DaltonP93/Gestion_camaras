// A1 (post #160) · política de bfcache (force-reload).
import { describe, it, expect } from 'vitest'
import { pageShowAction } from './bfcachePolicy'

describe('política pageshow frente al bfcache', () => {
  it('pageshow PERSISTIDO (vuelve del bfcache) → recarga limpia', () => {
    expect(pageShowAction(true)).toBe('reload')
  })
  it('pageshow NO persistido (carga normal) → ignore', () => {
    expect(pageShowAction(false)).toBe('ignore')
  })
})
