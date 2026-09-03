// Lógica de la página de Integraciones (panel ONVIF). Sin red ni DOM.
import { describe, it, expect } from 'vitest'
import { deriveOnvifPanelState, integrationErrorMessage } from './integrations'
import type { IntegrationsStatus } from '@/types'

const status = (onvif: boolean, hik = false): IntegrationsStatus => ({
  onvif: { enabled: onvif },
  hikConnect: { enabled: hik },
})

describe('deriveOnvifPanelState', () => {
  it('flag OFF ⇒ acciones deshabilitadas + aviso "definí ONVIF_ENABLED=true"', () => {
    const s = deriveOnvifPanelState(status(false))
    expect(s.enabled).toBe(false)
    expect(s.actionsDisabled).toBe(true)
    expect(s.notice).toMatch(/ONVIF_ENABLED=true/)
  })

  it('flag ON ⇒ acciones habilitadas, sin aviso (se renderizan los controles)', () => {
    const s = deriveOnvifPanelState(status(true))
    expect(s.enabled).toBe(true)
    expect(s.actionsDisabled).toBe(false)
    expect(s.notice).toBeNull()
  })

  it('status aún no cargado (null) ⇒ fail-safe: deshabilitado, sin I/O', () => {
    const s = deriveOnvifPanelState(null)
    expect(s.enabled).toBe(false)
    expect(s.actionsDisabled).toBe(true)
    expect(s.notice).not.toBeNull()
  })
})

describe('integrationErrorMessage', () => {
  it('prefiere response.data.message', () => {
    expect(integrationErrorMessage({ response: { data: { message: 'Tiempo agotado' } } })).toBe('Tiempo agotado')
  })
  it('cae a response.data.code cuando no hay message', () => {
    expect(integrationErrorMessage({ response: { data: { code: 'SSRF_BLOCKED' } } })).toBe('SSRF_BLOCKED')
  })
  it('usa fallback cuando no hay info', () => {
    expect(integrationErrorMessage({}, 'fallback x')).toBe('fallback x')
  })
})
