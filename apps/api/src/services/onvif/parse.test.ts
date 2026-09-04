// apps/api/src/services/onvif/parse.test.ts
//
// Parsers SOAP/ProbeMatch con XML de ejemplo. Incluye prueba XXE: un DOCTYPE con
// entidad externa NO se expande (extracción por regex, sin parser XML).

import { describe, it, expect } from 'vitest'
import {
  parseStreamUri,
  parseProfiles,
  parsePtzConfigurations,
  parseImagingSettings,
  parseProbeMatches,
  parseSoapFault,
  stripDoctype,
  tagText,
} from './parse'

describe('parseStreamUri', () => {
  it('extrae la URI RTSP dentro de MediaUri', () => {
    const xml = `<env:Envelope><env:Body><trt:GetStreamUriResponse><trt:MediaUri>
      <tt:Uri>rtsp://192.168.1.50:554/Streaming/Channels/101</tt:Uri>
      <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
    </trt:MediaUri></trt:GetStreamUriResponse></env:Body></env:Envelope>`
    expect(parseStreamUri(xml)).toBe('rtsp://192.168.1.50:554/Streaming/Channels/101')
  })
  it('devuelve null si no hay Uri', () => {
    expect(parseStreamUri('<a><b/></a>')).toBeNull()
  })
})

describe('parseProfiles', () => {
  it('extrae token, name, videoSource y resolución', () => {
    const xml = `<trt:GetProfilesResponse>
      <trt:Profiles token="Profile_1" fixed="true">
        <tt:Name>mainStream</tt:Name>
        <tt:VideoSourceConfiguration token="VSC0"><tt:SourceToken>VideoSource_1</tt:SourceToken></tt:VideoSourceConfiguration>
        <tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
      </trt:Profiles>
      <trt:Profiles token="Profile_2"><tt:Name>subStream</tt:Name></trt:Profiles>
    </trt:GetProfilesResponse>`
    const profiles = parseProfiles(xml)
    expect(profiles).toHaveLength(2)
    expect(profiles[0]).toMatchObject({
      token: 'Profile_1',
      name: 'mainStream',
      videoSourceToken: 'VideoSource_1',
      encoding: 'H264',
      width: 1920,
      height: 1080,
    })
    expect(profiles[1].token).toBe('Profile_2')
    expect(profiles[1].videoSourceToken).toBeNull()
  })
})

describe('parsePtzConfigurations', () => {
  it('extrae token, name y nodeToken', () => {
    const xml = `<tptz:GetConfigurationsResponse>
      <tptz:PTZConfiguration token="PTZCfg0"><tt:Name>cfg0</tt:Name><tt:NodeToken>Node0</tt:NodeToken></tptz:PTZConfiguration>
    </tptz:GetConfigurationsResponse>`
    const cfgs = parsePtzConfigurations(xml)
    expect(cfgs).toEqual([{ token: 'PTZCfg0', name: 'cfg0', nodeToken: 'Node0' }])
  })
})

describe('parseImagingSettings', () => {
  it('extrae brillo, IrCutFilter y focus', () => {
    const xml = `<timg:GetImagingSettingsResponse><timg:ImagingSettings>
      <tt:Brightness>60</tt:Brightness>
      <tt:Contrast>50</tt:Contrast>
      <tt:IrCutFilter>AUTO</tt:IrCutFilter>
      <tt:Focus><tt:AutoFocusMode>MANUAL</tt:AutoFocusMode><tt:DefaultSpeed>2</tt:DefaultSpeed></tt:Focus>
    </timg:ImagingSettings></timg:GetImagingSettingsResponse>`
    const s = parseImagingSettings(xml)
    expect(s.brightness).toBe(60)
    expect(s.contrast).toBe(50)
    expect(s.irCutFilter).toBe('AUTO')
    expect(s.focus).toEqual({ autoFocusMode: 'MANUAL', defaultSpeed: 2 })
  })
  it('focus null cuando no hay bloque Focus', () => {
    const s = parseImagingSettings('<tt:ImagingSettings><tt:Brightness>10</tt:Brightness></tt:ImagingSettings>')
    expect(s.focus).toBeNull()
    expect(s.irCutFilter).toBeNull()
  })
})

describe('parseProbeMatches', () => {
  it('extrae endpoint, XAddrs y scopes de un ProbeMatch', () => {
    const xml = `<s:Envelope><s:Body><d:ProbeMatches>
      <d:ProbeMatch>
        <a:EndpointReference><a:Address>urn:uuid:1111-2222</a:Address></a:EndpointReference>
        <d:Types>dn:NetworkVideoTransmitter</d:Types>
        <d:Scopes>onvif://www.onvif.org/name/Cam1 onvif://www.onvif.org/hardware/DS</d:Scopes>
        <d:XAddrs>http://192.168.1.50/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs>
      </d:ProbeMatch>
    </d:ProbeMatches></s:Body></s:Envelope>`
    const matches = parseProbeMatches(xml)
    expect(matches).toHaveLength(1)
    expect(matches[0].endpoint).toBe('urn:uuid:1111-2222')
    expect(matches[0].xaddrs).toEqual([
      'http://192.168.1.50/onvif/device_service',
      'http://[fe80::1]/onvif/device_service',
    ])
    expect(matches[0].scopes).toContain('onvif://www.onvif.org/name/Cam1')
  })
  it('lista vacía si no hay ProbeMatch', () => {
    expect(parseProbeMatches('<s:Envelope/>')).toEqual([])
  })
})

describe('parseSoapFault', () => {
  it('detecta un Fault SOAP 1.2 (Code/Value, Reason/Text, Subcode)', () => {
    const xml = `<s:Envelope><s:Body><s:Fault>
      <s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code>
      <s:Reason><s:Text xml:lang="en">Sender not authorized</s:Text></s:Reason>
    </s:Fault></s:Body></s:Envelope>`
    const fault = parseSoapFault(xml)
    expect(fault).not.toBeNull()
    expect(fault!.code).toBe('s:Sender')
    expect(fault!.subcode).toBe('ter:NotAuthorized')
    expect(fault!.reason).toBe('Sender not authorized')
  })
  it('null cuando no hay Fault', () => {
    expect(parseSoapFault('<ok/>')).toBeNull()
  })
})

describe('XXE-safety', () => {
  it('stripDoctype elimina la declaración DOCTYPE con entidades', () => {
    const evil = `<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><trt:MediaUri><tt:Uri>rtsp://x/&xxe;</tt:Uri></trt:MediaUri>`
    const clean = stripDoctype(evil)
    expect(clean).not.toContain('DOCTYPE')
    expect(clean).not.toContain('ENTITY')
  })
  it('NO expande entidades externas: &xxe; queda literal, sin leer archivos', () => {
    const evil = `<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><trt:MediaUri><tt:Uri>rtsp://cam/&xxe;/stream</tt:Uri></trt:MediaUri>`
    const uri = parseStreamUri(evil)
    // La entidad no se resuelve; el texto se conserva tal cual (sin contenido de archivo).
    expect(uri).toBe('rtsp://cam/&xxe;/stream')
  })
  it('CDATA se trata como texto literal', () => {
    expect(tagText('<tt:Uri><![CDATA[rtsp://c/a]]></tt:Uri>', 'Uri')).toBe('rtsp://c/a')
  })
})
