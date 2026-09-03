// apps/api/src/services/onvif/soap.test.ts
//
// Builders SOAP: estructura correcta por operación, inyección del header WSSE,
// y validación de argumentos.

import { describe, it, expect } from 'vitest'
import {
  buildGetDeviceInformation,
  buildGetProfiles,
  buildGetStreamUri,
  buildPtzGetConfigurations,
  buildContinuousMove,
  buildPtzStop,
  buildAbsoluteMove,
  buildGetImagingSettings,
  buildSetImagingSettings,
  ACTIONS,
} from './soap'

const SEC = '<wsse:Security>TOKEN</wsse:Security>'

describe('soap builders — envelope', () => {
  it('GetDeviceInformation: envelope SOAP 1.2 con la operación tds', () => {
    const env = buildGetDeviceInformation()
    expect(env).toContain('<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">')
    expect(env).toContain('GetDeviceInformation')
    expect(env).not.toContain('<s:Header>') // sin header cuando no hay security
  })

  it('inyecta el header WS-Security dentro de <s:Header>', () => {
    const env = buildGetProfiles({ securityHeader: SEC })
    expect(env).toContain(`<s:Header>${SEC}</s:Header>`)
    expect(env).toContain('GetProfiles')
  })
})

describe('GetStreamUri', () => {
  it('incluye StreamSetup RTP-Unicast/RTSP y el ProfileToken', () => {
    const env = buildGetStreamUri('Profile_1')
    expect(env).toContain('<tt:Stream>RTP-Unicast</tt:Stream>')
    expect(env).toContain('<tt:Protocol>RTSP</tt:Protocol>')
    expect(env).toContain('<trt:ProfileToken>Profile_1</trt:ProfileToken>')
  })
  it('respeta stream/protocol y escapa el token', () => {
    const env = buildGetStreamUri('a&b', { stream: 'RTP-Multicast', protocol: 'UDP' })
    expect(env).toContain('<tt:Stream>RTP-Multicast</tt:Stream>')
    expect(env).toContain('<tt:Protocol>UDP</tt:Protocol>')
    expect(env).toContain('a&amp;b')
  })
  it('rechaza profileToken vacío', () => {
    expect(() => buildGetStreamUri('')).toThrow()
  })
})

describe('PTZ builders', () => {
  it('GetConfigurations', () => {
    expect(buildPtzGetConfigurations()).toContain('GetConfigurations')
  })
  it('ContinuousMove: velocidad PanTilt+Zoom y timeout opcional', () => {
    const env = buildContinuousMove('P1', { x: 0.5, y: -0.25, zoom: 0.1 }, { timeout: 'PT1S' })
    expect(env).toContain('<tptz:ProfileToken>P1</tptz:ProfileToken>')
    expect(env).toContain('<tt:PanTilt x="0.5" y="-0.25"/>')
    expect(env).toContain('<tt:Zoom x="0.1"/>')
    expect(env).toContain('<tptz:Timeout>PT1S</tptz:Timeout>')
  })
  it('ContinuousMove: sólo zoom (sin PanTilt)', () => {
    const env = buildContinuousMove('P1', { zoom: 0.3 })
    expect(env).toContain('<tt:Zoom x="0.3"/>')
    expect(env).not.toContain('PanTilt')
  })
  it('ContinuousMove: rechaza valores no finitos', () => {
    expect(() => buildContinuousMove('P1', { x: Number.NaN })).toThrow()
  })
  it('Stop: PanTilt y Zoom por defecto true', () => {
    const env = buildPtzStop('P1')
    expect(env).toContain('<tptz:PanTilt>true</tptz:PanTilt>')
    expect(env).toContain('<tptz:Zoom>true</tptz:Zoom>')
  })
  it('AbsoluteMove: posición y speed opcional', () => {
    const env = buildAbsoluteMove('P1', { x: 0.1, y: 0.2 }, { speed: { x: 0.5 } })
    expect(env).toContain('<tptz:Position>')
    expect(env).toContain('<tt:PanTilt x="0.1" y="0.2"/>')
    expect(env).toContain('<tptz:Speed>')
  })
})

describe('Imaging builders', () => {
  it('GetImagingSettings: incluye VideoSourceToken', () => {
    const env = buildGetImagingSettings('VS_1')
    expect(env).toContain('<timg:VideoSourceToken>VS_1</timg:VideoSourceToken>')
  })
  it('SetImagingSettings: IrCutFilter y Focus (AUTO)', () => {
    const env = buildSetImagingSettings('VS_1', {
      brightness: 50,
      irCutFilter: 'AUTO',
      focus: { autoFocusMode: 'AUTO', defaultSpeed: 1 },
    })
    expect(env).toContain('<tt:Brightness>50</tt:Brightness>')
    expect(env).toContain('<tt:IrCutFilter>AUTO</tt:IrCutFilter>')
    expect(env).toContain('<tt:AutoFocusMode>AUTO</tt:AutoFocusMode>')
    expect(env).toContain('<tt:DefaultSpeed>1</tt:DefaultSpeed>')
    expect(env).toContain('<timg:ForcePersistence>true</timg:ForcePersistence>')
  })
  it('SetImagingSettings: rechaza IrCutFilter inválido', () => {
    expect(() => buildSetImagingSettings('VS_1', { irCutFilter: 'BOGUS' as unknown as 'ON' })).toThrow()
  })
})

describe('ACTIONS map', () => {
  it('expone URIs de acción por operación', () => {
    expect(ACTIONS.GetStreamUri).toContain('/media/wsdl/GetStreamUri')
    expect(ACTIONS.ContinuousMove).toContain('/ptz/wsdl/ContinuousMove')
    expect(ACTIONS.SetImagingSettings).toContain('/imaging/wsdl/SetImagingSettings')
  })
})
