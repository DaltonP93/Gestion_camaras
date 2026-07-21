import { describe, it, expect } from 'vitest'
import { mapOnlineToStatus, parseChannelHealthXml } from './hikvision-channel-health'

describe('mapOnlineToStatus', () => {
  it('online=true / chanDetect=online => ONLINE', () => {
    expect(mapOnlineToStatus('true')).toBe('ONLINE')
    expect(mapOnlineToStatus(undefined, 'online')).toBe('ONLINE')
    expect(mapOnlineToStatus('yes')).toBe('ONLINE')
  })
  it('online=false => OFFLINE', () => {
    expect(mapOnlineToStatus('false')).toBe('OFFLINE')
    expect(mapOnlineToStatus('0')).toBe('OFFLINE')
  })
  it('chanDetect=offline|channelErr|error => OFFLINE', () => {
    expect(mapOnlineToStatus(undefined, 'offline')).toBe('OFFLINE')
    expect(mapOnlineToStatus(undefined, 'channelErr')).toBe('OFFLINE')
    expect(mapOnlineToStatus(undefined, 'error')).toBe('OFFLINE')
  })
  it('ausente o no reconocido => UNKNOWN', () => {
    expect(mapOnlineToStatus(undefined, undefined)).toBe('UNKNOWN')
    expect(mapOnlineToStatus('', '')).toBe('UNKNOWN')
    expect(mapOnlineToStatus('weird', 'nonsense')).toBe('UNKNOWN')
  })
})

describe('parseChannelHealthXml', () => {
  // TEST 9.2 — InputProxy online=false => OFFLINE (la señal fiable)
  it('InputProxyChannelStatus online=false => OFFLINE', () => {
    const xml = `<?xml version="1.0"?><InputProxyChannelStatusList>
      <InputProxyChannelStatus><id>9</id><online>false</online>
        <sourceInputPortDescriptor><ipAddress>192.168.1.64</ipAddress></sourceInputPortDescriptor>
      </InputProxyChannelStatus>
      <InputProxyChannelStatus><id>1</id><online>true</online></InputProxyChannelStatus>
    </InputProxyChannelStatusList>`
    const r = parseChannelHealthXml(xml, 'inputproxy_status')
    expect(r.find(c => c.channel === 9)!.status).toBe('OFFLINE')
    expect(r.find(c => c.channel === 9)!.ipAddress).toBe('192.168.1.64')
    expect(r.find(c => c.channel === 1)!.status).toBe('ONLINE')
  })

  // TEST 9.3 — chanDetectResult=channelErr => OFFLINE
  it('chanDetectResult=channelErr => OFFLINE', () => {
    const xml = `<InputProxyChannelStatusList>
      <InputProxyChannelStatus><id>9</id><chanDetectResult>channelErr</chanDetectResult></InputProxyChannelStatus>
    </InputProxyChannelStatusList>`
    const r = parseChannelHealthXml(xml, 'inputproxy_status')
    expect(r[0].status).toBe('OFFLINE')
    expect(r[0].chanDetectResult).toBe('channelErr')
  })

  // TEST 9.4 — XML no reconocido => sin entradas (el caller lo trata como UNKNOWN)
  it('XML no reconocido => [] (=> UNKNOWN aguas arriba)', () => {
    expect(parseChannelHealthXml('<SomethingElse><foo>1</foo></SomethingElse>', 'x')).toHaveLength(0)
    expect(parseChannelHealthXml('not xml at all', 'x')).toHaveLength(0)
    expect(parseChannelHealthXml('', 'x')).toHaveLength(0)
  })

  it('parsea PasswordStatus y prioriza bloques Status sobre Channel', () => {
    const xml = `<list>
      <InputProxyChannelStatus><id>2</id><online>true</online><PasswordStatus>default</PasswordStatus></InputProxyChannelStatus>
    </list>`
    const r = parseChannelHealthXml(xml, 'inputproxy_status')
    expect(r[0].passwordStatus).toBe('default')
    expect(r[0].source).toContain('status_block')
  })

  it('cae a InputProxyChannel cuando no hay bloques Status', () => {
    const xml = `<InputProxyChannelList>
      <InputProxyChannel><id>3</id><online>false</online><ipAddress>10.0.0.3</ipAddress></InputProxyChannel>
    </InputProxyChannelList>`
    const r = parseChannelHealthXml(xml, 'inputproxy_channels')
    expect(r[0].status).toBe('OFFLINE')
    expect(r[0].source).toContain('channel_block')
  })

  it('JSON InputProxyChannelStatusList', () => {
    const json = JSON.stringify({ InputProxyChannelStatusList: { InputProxyChannelStatus: [
      { id: 9, online: false }, { id: 1, online: true },
    ] } })
    const r = parseChannelHealthXml(json, 'inputproxy_status')
    expect(r.find(c => c.channel === 9)!.status).toBe('OFFLINE')
    expect(r.find(c => c.channel === 1)!.status).toBe('ONLINE')
  })
})

// TEST 9.1 — el XML de VideoInput (que getNVRChannels marcaba online=true SIEMPRE)
// NO debe interpretarse como ONLINE por la fuente fiable: no trae señal física, así
// que parseChannelHealthXml no lo reconoce (=> [] => UNKNOWN aguas arriba, jamás ONLINE).
describe('regresión: VideoInput no es señal de online', () => {
  it('un cuerpo VideoInputChannel no produce ONLINE (queda para el fallback UNKNOWN)', () => {
    const videoInputXml = `<?xml version="1.0"?><VideoInputChannelList>
      <VideoInputChannel><id>9</id><customName>Sala Recuperación Endoscopía</customName></VideoInputChannel>
    </VideoInputChannelList>`
    const r = parseChannelHealthXml(videoInputXml, 'videoinput')
    // No hay bloques InputProxy → sin entradas → NO se afirma ONLINE.
    expect(r).toHaveLength(0)
    expect(r.some(e => e.status === 'ONLINE')).toBe(false)
  })
})
