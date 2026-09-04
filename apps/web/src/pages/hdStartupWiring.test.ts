// C21 · la espera visible de fullscreen es preparación HLS, no liberación de
// cupo. Estas guardas fijan el cableado real de ambas páginas al mensaje común.
import { describe, expect, it } from 'vitest'

const pages = import.meta.glob('./*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>
const components = import.meta.glob('../components/cameras/*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

describe('C21 · estado de preparación HD', () => {
  it.each(['./LiveViewPage.tsx', './ViewPlayerPage.tsx'])(
    '%s conserva el stream visible y explica la preparación',
    (path) => {
      const source = pages[path]
      expect(source).toContain("import { hdStartupMessage } from '@/lib/hdStartupMessage'")
      expect(source).toMatch(/preparingMessage=\{preparingHd\}/)
    },
  )

  it('VideoPlayer expone el estado accesible sin convertirlo en error', () => {
    const source = components['../components/cameras/VideoPlayer.tsx']
    expect(source).toContain('preparingMessage?: string | null')
    expect(source).toContain('role="status"')
    expect(source).toContain('aria-live="polite"')
    expect(source).toMatch(/preparingMessage && !activeError/)
  })
})
