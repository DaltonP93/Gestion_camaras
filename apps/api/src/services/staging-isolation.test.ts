import { describe, it, expect } from 'vitest'
import {
  resolveIsolationConfig,
  isolationWarnings,
  describeIsolation,
  outboundNotificationsAllowed,
} from './staging-isolation'

describe('resolveIsolationConfig', () => {
  it('sin variables ⇒ comportamiento actual (todo ON)', () => {
    expect(resolveIsolationConfig({})).toEqual({
      stagingIsolation: false, nvrPolling: true, nvrSync: true, streamAutoRegister: true, outboundNotifications: true,
    })
  })

  it('STAGING_ISOLATION=true apaga los cuatro', () => {
    expect(resolveIsolationConfig({ STAGING_ISOLATION: 'true' })).toEqual({
      stagingIsolation: true, nvrPolling: false, nvrSync: false, streamAutoRegister: false, outboundNotifications: false,
    })
  })

  it('las flags individuales no pueden re-habilitar nada bajo STAGING_ISOLATION (fail-closed)', () => {
    const env = {
      STAGING_ISOLATION: 'TRUE', NVR_POLLING_ENABLED: 'true', NVR_SYNC_ENABLED: 'true',
      STREAM_AUTO_REGISTER_ENABLED: 'true', OUTBOUND_NOTIFICATIONS_ENABLED: 'true',
    }
    const cfg = resolveIsolationConfig(env)
    expect([cfg.nvrPolling, cfg.nvrSync, cfg.streamAutoRegister, cfg.outboundNotifications]).toEqual([false, false, false, false])
    expect(isolationWarnings(env)[0]).toContain('NVR_POLLING_ENABLED')
  })

  it('cada flag individual apaga sólo lo suyo', () => {
    expect(resolveIsolationConfig({ NVR_POLLING_ENABLED: 'false' })).toMatchObject({ nvrPolling: false, nvrSync: true, streamAutoRegister: true, outboundNotifications: true })
    expect(resolveIsolationConfig({ NVR_SYNC_ENABLED: 'false' })).toMatchObject({ nvrPolling: true, nvrSync: false })
    expect(resolveIsolationConfig({ STREAM_AUTO_REGISTER_ENABLED: 'false' })).toMatchObject({ streamAutoRegister: false, nvrPolling: true })
    expect(resolveIsolationConfig({ OUTBOUND_NOTIFICATIONS_ENABLED: 'false' })).toMatchObject({ outboundNotifications: false, nvrPolling: true })
  })

  it('valores inválidos abortan el arranque (no se interpretan a ciegas)', () => {
    for (const bad of ['1', 'yes', 'on', 'falsee']) {
      expect(() => resolveIsolationConfig({ STAGING_ISOLATION: bad })).toThrow(/STAGING_ISOLATION/)
      expect(() => resolveIsolationConfig({ OUTBOUND_NOTIFICATIONS_ENABLED: bad })).toThrow(/OUTBOUND_NOTIFICATIONS_ENABLED/)
    }
  })

  it('variable ausente ⇒ default de esa flag (comportamiento actual), aunque otras estén definidas', () => {
    expect(resolveIsolationConfig({ NVR_POLLING_ENABLED: 'false' }).stagingIsolation).toBe(false)
    expect(resolveIsolationConfig({ STAGING_ISOLATION: 'false' })).toEqual(resolveIsolationConfig({}))
  })

  it('variable presente pero vacía, sólo espacios o con espacios alrededor ⇒ aborta (no se asume el default)', () => {
    const flags = ['STAGING_ISOLATION', 'NVR_POLLING_ENABLED', 'NVR_SYNC_ENABLED', 'STREAM_AUTO_REGISTER_ENABLED', 'OUTBOUND_NOTIFICATIONS_ENABLED']
    for (const name of flags) {
      for (const bad of ['', ' ', '   ', '\t', '\n', ' true', 'true ', ' false ', '\ttrue']) {
        expect(() => resolveIsolationConfig({ [name]: bad }), `${name}=${JSON.stringify(bad)}`).toThrow(new RegExp(`${name} presente pero inválida`))
      }
    }
  })

  it('el mensaje distingue la variable vacía y no ecoa valores largos', () => {
    expect(() => resolveIsolationConfig({ STAGING_ISOLATION: '  ' })).toThrow(/vacía \(" {2}"\)/)
    let msg = ''
    try { resolveIsolationConfig({ STAGING_ISOLATION: 'x'.repeat(200) }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('x'.repeat(32))
    expect(msg).not.toContain('x'.repeat(33))
  })

  it('outboundNotificationsAllowed y isolationWarnings aplican la misma regla estricta', () => {
    expect(() => outboundNotificationsAllowed({ OUTBOUND_NOTIFICATIONS_ENABLED: '' })).toThrow()
    expect(() => isolationWarnings({ STAGING_ISOLATION: ' ' })).toThrow()
  })

  it('describeIsolation resume el estado efectivo sin secretos', () => {
    const line = describeIsolation(resolveIsolationConfig({ STAGING_ISOLATION: 'true' }))
    expect(line).toBe('[startup] isolation staging=true nvr_polling=OFF nvr_sync=OFF stream_auto_register=OFF outbound_notifications=OFF')
  })

  it('outboundNotificationsAllowed sigue la config', () => {
    expect(outboundNotificationsAllowed({})).toBe(true)
    expect(outboundNotificationsAllowed({ STAGING_ISOLATION: 'true' })).toBe(false)
    expect(outboundNotificationsAllowed({ OUTBOUND_NOTIFICATIONS_ENABLED: 'false' })).toBe(false)
  })
})
