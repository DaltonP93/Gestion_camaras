import { describe, expect, it } from 'vitest'

const pages = import.meta.glob('./*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

describe('Vista en vivo 1×1 · cableado HD automático', () => {
  const source = pages['./LiveViewPage.tsx']

  it('usa el plan puro y conserva la transacción de viewport', () => {
    expect(source).toContain("import { planLiveLayoutChange as planLayout } from '@/lib/liveLayoutQuality'")
    const start = source.indexOf('const handleLayoutChange')
    const end = source.indexOf('const currentGrid', start)
    const handler = source.slice(start, end)

    expect(handler).toContain('planLayout({')
    expect(handler).toContain("transition.run('layout_change'")
    expect(handler).toContain('setPage(plan.targetPage)')
    expect(handler).not.toContain('setPage(0)')
  })

  it('1×1 entra por el foco real y los layouts múltiples salen de él', () => {
    const start = source.indexOf('const handleLayoutChange')
    const end = source.indexOf('const currentGrid', start)
    const handler = source.slice(start, end)

    expect(handler).toContain("plan.focusAction === 'enter_focus'")
    expect(handler).toContain('handleEnterFocus(targetCamera)')
    expect(handler).toContain("plan.focusAction === 'exit_focus'")
    expect(handler).toContain('handleExitFocus()')
  })

  it('el foco sigue solicitando main y conserva el fallback main_h264', () => {
    expect(source).toContain("ctrl.startRaw(camera.id, { streamType: 'main' })")
    expect(source).toContain("resolveCreatedType(info, 'main')")
  })
})
