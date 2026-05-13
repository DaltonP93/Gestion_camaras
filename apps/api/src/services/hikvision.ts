// apps/api/src/services/hikvision.ts
// Integración completa con la API ISAPI de Hikvision
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'
import crypto from 'crypto'
import type { NVR } from '@prisma/client'

// ─── Interfaces ───────────────────────────────────────────────

export interface HikChannel {
  id: number
  name: string
  online: boolean
  rtspUrl?: string
}

export interface HikNVRStatus {
  online: boolean
  firmware: string
  diskUsage: number
  cpuUsage: number
  temperature?: number
  errorReason?: 'network' | 'auth' | 'unknown'
}

export interface HikDeviceInfo {
  deviceName: string
  model: string
  serialNumber: string
  firmware: string
  encodingVersion: string
  webVersion: string
  pluginVersion: string
  macAddress: string
  channelCount: number
  hddCount: number
}

export interface HikIpCamera {
  channel: number           // 1-based
  channelCode: string       // D1, D2...
  name: string
  ipAddress: string
  protocol: string          // HIKVISION, ONVIF, etc.
  managementPort: number    // 8000
  securityStatus: string    // Secure, Non-Secure
  status: string            // online, offline
}

export interface HikStorageDisk {
  diskNumber: number
  capacityGb: number
  freeGb: number
  usedPercent: number
  status: string
  type: string
  property: string
  process: string
}

export interface HikNVRUser {
  id: number
  name: string
  userLevel: string   // Administrator, Operator, User
  active: boolean
}

export interface HikVideoEncoding {
  channel: number
  mainCodec: string
  mainResolution: string
  mainFps: number
  mainBitrate: number
  subCodec: string
  subResolution: string
  subFps: number
  subBitrate: number
}

export interface HikRecording {
  id: string
  channel: number
  startTime: string
  endTime: string
  size: number
  type: string
}

export interface HikPlaybackUrl {
  url: string
  expiresAt: string
}

// ─── Digest Auth ──────────────────────────────────────────────

function buildDigestAuth(
  username: string, password: string,
  method: string, uri: string,
  wwwAuth: string,
): string {
  const realm  = (wwwAuth.match(/realm="([^"]+)"/)  || [])[1] ?? ''
  const nonce  = (wwwAuth.match(/nonce="([^"]+)"/)  || [])[1] ?? ''
  const qop    = (wwwAuth.match(/qop="?([^",]+)"?/) || [])[1]
  const nc     = '00000001'
  const cnonce = crypto.randomBytes(8).toString('hex')

  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')
  const ha1  = md5(`${username}:${realm}:${password}`)
  const ha2  = md5(`${method}:${uri}`)
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`)

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  return header
}

// ─── HTTP Client ──────────────────────────────────────────────

function createHikClient(nvr: { ipAddress: string; port: number; username: string; password: string }, timeoutMs = 10000): AxiosInstance {
  const { username, password } = nvr

  const client = axios.create({
    baseURL: `http://${nvr.ipAddress}:${nvr.port}`,
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  })

  client.interceptors.response.use(undefined, async (err) => {
    const res = err.response
    if (res?.status === 401 && !err.config._digestRetried) {
      const wwwAuth: string = res.headers['www-authenticate'] ?? ''
      if (wwwAuth.toLowerCase().startsWith('digest')) {
        err.config._digestRetried = true
        const cfg: AxiosRequestConfig & { _digestRetried?: boolean } = err.config
        const method = (cfg.method ?? 'GET').toUpperCase()
        const url    = new URL(cfg.url ?? '/', `http://${nvr.ipAddress}`)
        const uri    = url.pathname + url.search
        cfg.headers  = cfg.headers ?? {}
        cfg.headers['Authorization'] = buildDigestAuth(username, password, method, uri, wwwAuth)
        return client.request(cfg)
      }
      if (!err.config._basicRetried) {
        err.config._basicRetried = true
        err.config.auth = { username, password }
        return client.request(err.config)
      }
    }
    return Promise.reject(err)
  })

  return client
}

// ─── Helper XML ───────────────────────────────────────────────

function xmlGet(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() || ''
}

function xmlGetAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')
  return (xml.match(re) || [])
}

// ─── Estado general del NVR ───────────────────────────────────

export async function getNVRStatus(nvr: NVR): Promise<HikNVRStatus> {
  try {
    const client = createHikClient(nvr)

    const [sysRes, diskRes] = await Promise.allSettled([
      client.get('/ISAPI/System/deviceInfo'),
      client.get('/ISAPI/ContentMgmt/Storage'),
    ])

    if (sysRes.status === 'rejected') {
      const err = sysRes.reason as any
      let errorReason: HikNVRStatus['errorReason'] = 'unknown'
      if (err?.response?.status === 401) errorReason = 'auth'
      else if (!err?.response || ['ECONNREFUSED','ETIMEDOUT','ECONNABORTED','EHOSTUNREACH','ENOTFOUND'].includes(err?.code)) errorReason = 'network'
      return { online: false, firmware: nvr.firmware || '', diskUsage: 0, cpuUsage: 0, errorReason }
    }

    const sysData  = sysRes.value.data
    const diskData = diskRes.status === 'fulfilled' ? diskRes.value.data : null

    let diskUsage = 0
    if (diskData?.StorageList?.storage) {
      const storages = Array.isArray(diskData.StorageList.storage)
        ? diskData.StorageList.storage : [diskData.StorageList.storage]
      const total = storages.reduce((a: number, s: any) => a + (s.capacity || 0), 0)
      const used  = storages.reduce((a: number, s: any) => a + (s.freeSpace ? s.capacity - s.freeSpace : 0), 0)
      diskUsage = total > 0 ? Math.round((used / total) * 100) : 0
    }

    return {
      online: true,
      firmware: sysData?.DeviceInfo?.firmwareVersion || nvr.firmware || '',
      diskUsage,
      cpuUsage: 0,
    }
  } catch {
    return { online: false, firmware: nvr.firmware || '', diskUsage: 0, cpuUsage: 0 }
  }
}

// ─── Información detallada del dispositivo ────────────────────

export async function getDeviceInfo(nvr: NVR): Promise<HikDeviceInfo | null> {
  try {
    const client = createHikClient(nvr)
    const res = await client.get('/ISAPI/System/deviceInfo')
    const d = res.data?.DeviceInfo || {}

    // Intenta parsear XML si respuesta es string
    if (typeof res.data === 'string') {
      const x = res.data
      return {
        deviceName:      xmlGet(x, 'deviceName'),
        model:           xmlGet(x, 'model'),
        serialNumber:    xmlGet(x, 'serialNumber'),
        firmware:        xmlGet(x, 'firmwareVersion'),
        encodingVersion: xmlGet(x, 'encodingVersion'),
        webVersion:      xmlGet(x, 'webVersion'),
        pluginVersion:   xmlGet(x, 'pluginVersion'),
        macAddress:      xmlGet(x, 'macAddress'),
        channelCount:    parseInt(xmlGet(x, 'ipChannelNum') || xmlGet(x, 'analogChannelNum') || '0'),
        hddCount:        parseInt(xmlGet(x, 'diskNum') || '0'),
      }
    }

    return {
      deviceName:      d.deviceName || '',
      model:           d.model || '',
      serialNumber:    d.serialNumber || '',
      firmware:        d.firmwareVersion || '',
      encodingVersion: d.encodingVersion || '',
      webVersion:      d.webVersion || '',
      pluginVersion:   d.pluginVersion || '',
      macAddress:      d.macAddress || '',
      channelCount:    parseInt(d.ipChannelNum || d.analogChannelNum || '0'),
      hddCount:        parseInt(d.diskNum || '0'),
    }
  } catch {
    return null
  }
}

// ─── Canales de video (ISAPI legacy) ─────────────────────────

export async function getNVRChannels(nvr: NVR): Promise<HikChannel[]> {
  try {
    const client = createHikClient(nvr)
    const res = await client.get('/ISAPI/System/Video/inputs/channels')

    const channelsData = res.data?.VideoInputChannelList?.VideoInputChannel
    if (!channelsData) return []
    const channels = Array.isArray(channelsData) ? channelsData : [channelsData]

    return channels.map((ch: any) => ({
      id:     parseInt(ch.id),
      name:   ch.name || `Canal ${ch.id}`,
      online: ch.connectionType !== 'N/A',
      rtspUrl: buildRtspUrl(nvr, parseInt(ch.id)),
    }))
  } catch {
    return Array.from({ length: nvr.channels }, (_, i) => ({
      id:     i + 1,
      name:   `Canal ${i + 1}`,
      online: false,
      rtspUrl: buildRtspUrl(nvr, i + 1),
    }))
  }
}

// ─── Lista de cámaras IP conectadas (con nombres reales) ──────

export async function getIpCameraList(nvr: NVR): Promise<HikIpCamera[]> {
  const client = createHikClient(nvr)
  const cameras: HikIpCamera[] = []

  try {
    // Endpoint principal para cámaras IP
    const res = await client.get('/ISAPI/ContentMgmt/InputProxy/channels')
    const data = res.data

    let items: any[] = []

    if (typeof data === 'string') {
      // Parsear XML
      const blocks = xmlGetAll(data, 'InputProxyChannel')
      items = blocks.map(block => ({
        _xml: block,
        id:             parseInt(xmlGet(block, 'id') || '0'),
        name:           xmlGet(block, 'name'),
        ipAddress:      xmlGet(block, 'ipAddress'),
        protocol:       xmlGet(block, 'protocolType') || xmlGet(block, 'proxyProtocol'),
        port:           parseInt(xmlGet(block, 'managementPortNo') || '8000'),
        securityStatus: xmlGet(block, 'securityStatus'),
        status:         xmlGet(block, 'status'),
      }))
    } else if (data?.InputProxyChannelList?.InputProxyChannel) {
      const raw = data.InputProxyChannelList.InputProxyChannel
      items = Array.isArray(raw) ? raw : [raw]
    }

    for (const item of items) {
      const ch = parseInt(item.id || item.channelNo || '0')
      if (!ch) continue
      cameras.push({
        channel:        ch,
        channelCode:    `D${ch}`,
        name:           item.name || `Canal ${ch}`,
        ipAddress:      item.ipAddress || item.ip || '',
        protocol:       item.protocol || item.protocolType || item.proxyProtocol || 'HIKVISION',
        managementPort: parseInt(item.port || item.managementPortNo || '8000'),
        securityStatus: item.securityStatus || '',
        status:         item.status || '',
      })
    }
  } catch {
    // Fallback a endpoint de canales de video
    try {
      const fallback = await getNVRChannels(nvr)
      return fallback.map(ch => ({
        channel:        ch.id,
        channelCode:    `D${ch.id}`,
        name:           ch.name,
        ipAddress:      '',
        protocol:       'HIKVISION',
        managementPort: 8000,
        securityStatus: '',
        status:         ch.online ? 'online' : 'offline',
      }))
    } catch {
      return []
    }
  }

  return cameras
}

// ─── Almacenamiento / HDDs ────────────────────────────────────

export async function getStorageInfo(nvr: NVR): Promise<HikStorageDisk[]> {
  try {
    const client = createHikClient(nvr)
    const res = await client.get('/ISAPI/ContentMgmt/Storage')
    const disks: HikStorageDisk[] = []

    const parseDisks = (raw: any) => {
      const list = Array.isArray(raw) ? raw : [raw]
      list.forEach((d: any, i: number) => {
        const capacityKb = parseInt(d.capacity || d.totalCapacity || '0')
        const freeKb     = parseInt(d.freeSpace || d.remainCapacity || '0')
        const capGb      = capacityKb / 1024 / 1024
        const freeGb     = freeKb / 1024 / 1024
        disks.push({
          diskNumber:  parseInt(d.id || d.hddIndex || `${i + 1}`),
          capacityGb:  Math.round(capGb * 100) / 100,
          freeGb:      Math.round(freeGb * 100) / 100,
          usedPercent: capGb > 0 ? Math.round(((capGb - freeGb) / capGb) * 100) : 0,
          status:      d.status || d.hddStatus || '',
          type:        d.type || d.hddType || 'local',
          property:    d.property || d.hddProperty || '',
          process:     d.hddProcess || d.process || '',
        })
      })
    }

    if (typeof res.data === 'string') {
      const blocks = xmlGetAll(res.data, 'hdd')
      blocks.forEach((b, i) => {
        const cap  = parseInt(xmlGet(b, 'capacity') || '0')
        const free = parseInt(xmlGet(b, 'freeSpace') || '0')
        const capGb  = cap / 1024 / 1024
        const freeGb = free / 1024 / 1024
        disks.push({
          diskNumber:  i + 1,
          capacityGb:  Math.round(capGb * 100) / 100,
          freeGb:      Math.round(freeGb * 100) / 100,
          usedPercent: capGb > 0 ? Math.round(((capGb - freeGb) / capGb) * 100) : 0,
          status:      xmlGet(b, 'status'),
          type:        xmlGet(b, 'type') || 'local',
          property:    xmlGet(b, 'property'),
          process:     xmlGet(b, 'hddProcess'),
        })
      })
    } else {
      const storage = res.data?.StorageList?.storage || res.data?.hddList?.hdd
      if (storage) parseDisks(storage)
    }

    return disks
  } catch {
    return []
  }
}

// ─── Usuarios del NVR ─────────────────────────────────────────

export async function getNVRUsers(nvr: NVR): Promise<HikNVRUser[]> {
  try {
    const client = createHikClient(nvr)
    const res = await client.get('/ISAPI/Security/users')
    const users: HikNVRUser[] = []

    if (typeof res.data === 'string') {
      const blocks = xmlGetAll(res.data, 'User')
      blocks.forEach(b => {
        users.push({
          id:        parseInt(xmlGet(b, 'id') || '0'),
          name:      xmlGet(b, 'userName'),
          userLevel: xmlGet(b, 'userLevel') || xmlGet(b, 'roleType'),
          active:    true,
        })
      })
    } else {
      const raw = res.data?.UserList?.User || res.data?.userList?.User
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        list.forEach((u: any) => {
          users.push({
            id:        parseInt(u.id || '0'),
            name:      u.userName || u.name || '',
            userLevel: u.userLevel || u.roleType || '',
            active:    true,
          })
        })
      }
    }

    return users
  } catch {
    return []
  }
}

// ─── Configuración de codificación de video ───────────────────

export async function getVideoEncodingConfig(nvr: NVR, channel: number): Promise<HikVideoEncoding | null> {
  try {
    const client = createHikClient(nvr)
    const ch = String(channel).padStart(2, '0')

    const [mainRes, subRes] = await Promise.allSettled([
      client.get(`/ISAPI/Streaming/channels/${ch}01`),
      client.get(`/ISAPI/Streaming/channels/${ch}02`),
    ])

    const parseStream = (data: any) => {
      if (!data) return { codec: '', resolution: '', fps: 0, bitrate: 0 }
      if (typeof data === 'string') {
        return {
          codec:      xmlGet(data, 'videoCodecType'),
          resolution: `${xmlGet(data, 'videoResolutionWidth')}x${xmlGet(data, 'videoResolutionHeight')}`,
          fps:        parseInt(xmlGet(data, 'maxFrameRate') || '0') / 100 || parseInt(xmlGet(data, 'frameRate') || '0'),
          bitrate:    parseInt(xmlGet(data, 'videoBitRate') || xmlGet(data, 'constantBitRate') || '0'),
        }
      }
      const v = data?.StreamingChannel?.Video || {}
      return {
        codec:      v.videoCodecType || '',
        resolution: v.videoResolutionWidth ? `${v.videoResolutionWidth}x${v.videoResolutionHeight}` : '',
        fps:        v.maxFrameRate ? v.maxFrameRate / 100 : (v.frameRate || 0),
        bitrate:    v.videoBitRate || v.constantBitRate || 0,
      }
    }

    const main = mainRes.status === 'fulfilled' ? parseStream(mainRes.value.data) : { codec: '', resolution: '', fps: 0, bitrate: 0 }
    const sub  = subRes.status === 'fulfilled'  ? parseStream(subRes.value.data)  : { codec: '', resolution: '', fps: 0, bitrate: 0 }

    return {
      channel,
      mainCodec:      main.codec,
      mainResolution: main.resolution,
      mainFps:        main.fps,
      mainBitrate:    main.bitrate,
      subCodec:       sub.codec,
      subResolution:  sub.resolution,
      subFps:         sub.fps,
      subBitrate:     sub.bitrate,
    }
  } catch {
    return null
  }
}

// ─── Construir URL RTSP ───────────────────────────────────────

export function buildRtspUrl(nvr: { ipAddress: string; rtspPort: number; username: string; password: string }, channel: number, subStream = false): string {
  const streamType  = subStream ? '02' : '01'
  const encodedPass = encodeURIComponent(nvr.password)
  return `rtsp://${nvr.username}:${encodedPass}@${nvr.ipAddress}:${nvr.rtspPort}/Streaming/Channels/${channel}${streamType}`
}

export function buildRtspUrlMasked(nvr: { ipAddress: string; rtspPort: number; username: string }, channel: number, subStream = false): string {
  const streamType = subStream ? '02' : '01'
  return `rtsp://${nvr.username}:***@${nvr.ipAddress}:${nvr.rtspPort}/Streaming/Channels/${channel}${streamType}`
}

// ─── Reiniciar dispositivo ────────────────────────────────────

export async function rebootDevice(nvr: NVR): Promise<boolean> {
  try {
    const client = createHikClient(nvr)
    await client.put('/ISAPI/System/reboot')
    return true
  } catch {
    return false
  }
}

// ─── Buscar grabaciones ───────────────────────────────────────

export async function searchRecordings(
  nvr: NVR, channel: number, startTime: Date, endTime: Date
): Promise<HikRecording[]> {
  try {
    const client = createHikClient(nvr)
    const body = {
      CMSearchDescription: {
        searchID: `search_${Date.now()}`,
        trackList: { TrackDescriptor: { trackID: `${String(channel).padStart(2, '0')}00` } },
        timeSpanList: {
          TimeSpan: {
            startTime: startTime.toISOString().replace('Z', '+00:00'),
            endTime:   endTime.toISOString().replace('Z', '+00:00'),
          },
        },
        maxResults: 100,
        searchResultPostion: 0,
        metadataList: { metadataDescriptor: '//recordType.meta.std-cgi.com' },
      },
    }

    const response = await client.post('/ISAPI/ContentMgmt/search', body)
    const items = response.data?.CMSearchResult?.matchList?.SearchMatchItem
    if (!items) return []
    const list = Array.isArray(items) ? items : [items]

    return list.map((item: any, index: number) => ({
      id:        `${nvr.id}_${channel}_${index}`,
      channel,
      startTime: item.timeSpan?.startTime || '',
      endTime:   item.timeSpan?.endTime || '',
      size:      item.mediaSegmentDescriptor?.contentLength || 0,
      type:      item.mediaSegmentDescriptor?.contentType || 'video/mp4',
    }))
  } catch {
    return []
  }
}

// ─── URL de playback de grabación ─────────────────────────────

export async function getPlaybackUrl(
  nvr: NVR, channel: number, startTime: Date, endTime: Date
): Promise<HikPlaybackUrl> {
  const channelStr = String(channel).padStart(2, '0')
  const startIso   = startTime.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  const endIso     = endTime.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  const url = `rtsp://${nvr.username}:${nvr.password}@${nvr.ipAddress}:${nvr.rtspPort}/Streaming/tracks/${channelStr}00?starttime=${startIso}&endtime=${endIso}`
  return { url, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
}

// ─── Control PTZ ──────────────────────────────────────────────

export type PTZCommand = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'ZOOM_IN' | 'ZOOM_OUT' | 'STOP'

export async function sendPTZCommand(nvr: NVR, channel: number, command: PTZCommand, speed = 50): Promise<boolean> {
  try {
    const client = createHikClient(nvr)
    const ptzMap: Record<PTZCommand, object> = {
      UP:       { pan: 0,      tilt: speed,  zoom: 0 },
      DOWN:     { pan: 0,      tilt: -speed, zoom: 0 },
      LEFT:     { pan: -speed, tilt: 0,      zoom: 0 },
      RIGHT:    { pan: speed,  tilt: 0,      zoom: 0 },
      ZOOM_IN:  { pan: 0,      tilt: 0,      zoom: speed },
      ZOOM_OUT: { pan: 0,      tilt: 0,      zoom: -speed },
      STOP:     { pan: 0,      tilt: 0,      zoom: 0 },
    }
    const ch = String(channel).padStart(2, '0')
    await client.put(`/ISAPI/PTZCtrl/channels/${ch}/continuous`, { PTZData: ptzMap[command] })
    return true
  } catch {
    return false
  }
}

// ─── Snapshot ─────────────────────────────────────────────────

export async function captureSnapshot(nvr: NVR, channel: number): Promise<Buffer | null> {
  try {
    const client = createHikClient(nvr)
    const ch = String(channel).padStart(2, '0')
    const res = await client.get(`/ISAPI/Streaming/channels/${ch}01/picture`, { responseType: 'arraybuffer' })
    return Buffer.from(res.data)
  } catch {
    return null
  }
}
