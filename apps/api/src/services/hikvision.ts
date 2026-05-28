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
  chanDetectResult?: string
  passwordStatus?: string
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
  _rawCapacity?: number  // raw value from ISAPI (for unit debugging)
  _rawFree?: number
}

export interface HikNVRUser {
  id: number
  name: string
  userLevel: string   // Administrator, Operator, User
  active: boolean
  enabled?: boolean   // explicit enabled flag (some models expose it)
}

export interface HikUserWriteResult {
  success: boolean
  id?: number         // returned on create
  error?: string
  unsupported?: boolean  // true when NVR doesn't support the ISAPI operation
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
    const data = res.data

    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'VideoInputChannel')
      const channels: HikChannel[] = []
      for (const block of blocks) {
        const id = parseInt(xmlGet(block, 'id') || '0')
        if (!id) continue
        const name = xmlGet(block, 'customName') || xmlGet(block, 'name')
        channels.push({
          id,
          name:    name || `Canal ${id}`,
          online:  true,
          rtspUrl: buildRtspUrl(nvr, id),
        })
      }
      return channels
    }

    const channelsData = data?.VideoInputChannelList?.VideoInputChannel
    if (!channelsData) return []
    const channels = Array.isArray(channelsData) ? channelsData : [channelsData]

    return channels.map((ch: any) => ({
      id:     parseInt(ch.id),
      name:   ch.customName || ch.name || `Canal ${ch.id}`,
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

// Helper: decides whether a name looks like an auto-generated placeholder.
// Only matches PURELY auto-generated names — real names like "Box 7" or "Ingreso UTI" return false.
function isPlaceholderName(name: string): boolean {
  if (!name || !name.trim()) return true
  const trimmed = name.trim()
  // "IPCamera01", "IPCamera 1", "IPCamera" — purely auto-generated
  if (/^IPCamera\s*\d*$/i.test(trimmed)) return true
  // "Camera1", "Camera 01" — purely auto-generated
  if (/^Camera\s*\d*$/i.test(trimmed)) return true
  // "Canal 1", "Canal 01" — purely auto-generated
  if (/^Canal\s*\d+$/i.test(trimmed)) return true
  // "D1", "D12" — D followed by ONLY digits (end of string) — placeholder
  // "D1 Box 7" — has real text after digits — NOT a placeholder
  if (/^D\d+$/i.test(trimmed)) return true
  // Pure 3-4 digit number = Hikvision streaming channel ID (101=ch1 main, 102=ch1 sub, 1201=ch12 main)
  if (/^\d{3,4}$/.test(trimmed)) return true
  // "Channel X" variations
  if (/^Channel\s*\d+$/i.test(trimmed)) return true
  return false
}

export async function getIpCameraList(nvr: NVR): Promise<HikIpCamera[]> {
  const client = createHikClient(nvr)

  // ── Step 1: InputProxy channels ────────────────────────────
  interface InputProxyEntry {
    channel: number
    name: string
    ipAddress: string
    protocol: string
    managementPort: number
    securityStatus: string
    status: string
    chanDetectResult?: string
    passwordStatus?: string
  }

  const inputProxyMap = new Map<number, InputProxyEntry>()

  try {
    const res = await client.get('/ISAPI/ContentMgmt/InputProxy/channels')
    const data = res.data
    let items: any[] = []

    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'InputProxyChannel')
      items = blocks.map(block => ({
        id:             parseInt(xmlGet(block, 'id') || '0'),
        // customName is the user-set label; name may be auto-generated
        name:           xmlGet(block, 'customName') || xmlGet(block, 'name'),
        ipAddress:      xmlGet(block, 'ipAddress'),
        protocol:       xmlGet(block, 'proxyProtocol') || xmlGet(block, 'protocolType'),
        port:           parseInt(xmlGet(block, 'managePortNo') || xmlGet(block, 'managementPortNo') || '8000'),
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
      inputProxyMap.set(ch, {
        channel:        ch,
        name:           item.customName || item.name || '',
        ipAddress:      item.ipAddress || item.ip || '',
        protocol:       item.protocol || item.protocolType || item.proxyProtocol || 'HIKVISION',
        managementPort: parseInt(item.port || item.managementPortNo || '8000'),
        securityStatus: item.securityStatus || '',
        status:         item.status || '',
      })
    }
  } catch {
    // InputProxy endpoint not available — fall through to VideoInput or fallback
  }

  // ── Step 1.5: InputProxy channel status (accurate online per channel) ─
  try {
    const res = await client.get('/ISAPI/ContentMgmt/InputProxy/channels/status')
    const data = res.data
    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'InputProxyChannelStatus')
      for (const block of blocks) {
        const ch = parseInt(xmlGet(block, 'id') || '0')
        if (!ch) continue
        const onlineStr = xmlGet(block, 'online')
        const entry = inputProxyMap.get(ch)
        if (entry) {
          entry.status = onlineStr === 'true' ? 'online' : 'offline'
          const chanDetect = xmlGet(block, 'chanDetectResult')
          const pwdStatus = xmlGet(block, 'PasswordStatus')
          if (chanDetect) entry.chanDetectResult = chanDetect
          if (pwdStatus) entry.passwordStatus = pwdStatus
        }
      }
    } else {
      const raw = data?.InputProxyChannelStatusList?.InputProxyChannelStatus
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        for (const item of list) {
          const ch = parseInt(item.id || '0')
          if (!ch) continue
          const entry = inputProxyMap.get(ch)
          if (entry) {
            entry.status = item.online === true || item.online === 'true' ? 'online' : 'offline'
            if (item.chanDetectResult) entry.chanDetectResult = item.chanDetectResult
            if (item.SecurityStatus?.PasswordStatus) entry.passwordStatus = item.SecurityStatus.PasswordStatus
            else if (item.PasswordStatus) entry.passwordStatus = item.PasswordStatus
          }
        }
      }
    }
  } catch {
    // Status endpoint may not exist — continue with status from channels endpoint
  }

  // ── Step 2: VideoInput channels (often have custom/real names) ─
  const videoInputNames = new Map<number, string>()

  try {
    const res = await client.get('/ISAPI/System/Video/inputs/channels')
    const data = res.data

    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'VideoInputChannel')
      for (const block of blocks) {
        const id = parseInt(xmlGet(block, 'id') || xmlGet(block, 'inputPort') || '0')
        if (!id) continue
        const customName = xmlGet(block, 'customName') || xmlGet(block, 'name')
        if (customName) videoInputNames.set(id, customName)
      }
    } else {
      const channelsData = data?.VideoInputChannelList?.VideoInputChannel
      if (channelsData) {
        const channels = Array.isArray(channelsData) ? channelsData : [channelsData]
        for (const ch of channels) {
          const id = parseInt(ch.id || ch.inputPort || '0')
          if (!id) continue
          const customName = ch.customName || ch.name || ''
          if (customName) videoInputNames.set(id, customName)
        }
      }
    }
  } catch {
    // VideoInput endpoint may not be available — continue with what we have
  }

  // ── Step 3: Streaming channels — often have real camera names ─
  const streamingChannelNames = new Map<number, string>()

  try {
    const res = await client.get('/ISAPI/Streaming/channels')
    const data = res.data

    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'StreamingChannel')
      for (const block of blocks) {
        const rawId = parseInt(xmlGet(block, 'id') || '0')
        if (!rawId) continue
        // id 101 = ch1, 202 = ch2, 1901 = ch19
        const ch = Math.floor(rawId / 100)
        const channelName = xmlGet(block, 'channelName')
        // Skip channelNames that are just the stream ID or pure numerics
        if (channelName && channelName.trim() !== String(rawId) && !isPlaceholderName(channelName)) {
          if (!streamingChannelNames.has(ch)) {
            streamingChannelNames.set(ch, channelName)
          }
        }
      }
    } else {
      const rawChannels = data?.StreamingChannelList?.StreamingChannel
      if (rawChannels) {
        const chList = Array.isArray(rawChannels) ? rawChannels : [rawChannels]
        for (const sc of chList) {
          const rawId = parseInt(sc.id || '0')
          if (!rawId) continue
          const ch = Math.floor(rawId / 100)
          const channelName = sc.channelName || ''
          // Skip channelNames that are just the stream ID or pure numerics
          if (channelName && channelName.trim() !== String(rawId) && !isPlaceholderName(channelName)) {
            if (!streamingChannelNames.has(ch)) {
              streamingChannelNames.set(ch, channelName)
            }
          }
        }
      }
    }
  } catch {
    // Streaming channels endpoint not available — continue
  }

  // ── Step 4: Merge — prefer InputProxy data, use best available name ─
  // Priority: InputProxy name > VideoInput name > Streaming channel name > placeholder fallback
  if (inputProxyMap.size === 0 && videoInputNames.size === 0 && streamingChannelNames.size === 0) {
    // No ISAPI camera-management endpoint worked — fall back to VideoInput channel list.
    // Status is NOT reliable from this fallback (only VideoInput connectivity, not IP camera state).
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
        status:         'unknown',  // fallback doesn't know real IP camera status
      }))
    } catch {
      return []
    }
  }

  // Build merged result from InputProxy entries (supplemented by VideoInput/Streaming names)
  const cameras: HikIpCamera[] = []

  for (const [ch, entry] of inputProxyMap.entries()) {
    const inputProxyName   = entry.name
    const videoInputName   = videoInputNames.get(ch) || ''
    const streamingName    = streamingChannelNames.get(ch) || ''

    // Priority: InputProxy name > VideoInput name > Streaming channel name > placeholder fallback
    let bestName: string
    if (!isPlaceholderName(inputProxyName)) {
      bestName = inputProxyName
    } else if (!isPlaceholderName(videoInputName)) {
      bestName = videoInputName
    } else if (!isPlaceholderName(streamingName)) {
      bestName = streamingName
    } else {
      bestName = inputProxyName || videoInputName || streamingName || `Canal ${ch}`
    }

    cameras.push({
      channel:          ch,
      channelCode:      `D${ch}`,
      name:             bestName,
      ipAddress:        entry.ipAddress,
      protocol:         entry.protocol,
      managementPort:   entry.managementPort,
      securityStatus:   entry.securityStatus,
      status:           entry.status,
      chanDetectResult: entry.chanDetectResult,
      passwordStatus:   entry.passwordStatus,
    })
  }

  // Collect all channel numbers seen in VideoInput or Streaming but not in InputProxy
  const extraChannels = new Set<number>([
    ...videoInputNames.keys(),
    ...streamingChannelNames.keys(),
  ])
  for (const ch of extraChannels) {
    if (inputProxyMap.has(ch)) continue
    const videoInputName = videoInputNames.get(ch) || ''
    const streamingName  = streamingChannelNames.get(ch) || ''

    let bestName: string
    if (!isPlaceholderName(videoInputName)) {
      bestName = videoInputName
    } else if (!isPlaceholderName(streamingName)) {
      bestName = streamingName
    } else {
      bestName = videoInputName || streamingName || `Canal ${ch}`
    }

    cameras.push({
      channel:        ch,
      channelCode:    `D${ch}`,
      name:           bestName,
      ipAddress:      '',
      protocol:       'HIKVISION',
      managementPort: 8000,
      securityStatus: '',
      status:         'unknown',
    })
  }

  cameras.sort((a, b) => a.channel - b.channel)
  return cameras
}

// ─── Debug: raw name sources from each ISAPI endpoint ─────────
// Returns raw intermediate data so admins can diagnose why names aren't syncing.
export async function debugGetCameraNameSources(nvr: NVR): Promise<{
  inputProxy:      { ok: boolean; count: number; channels: { ch: number; name: string }[]; error?: string }
  videoInput:      { ok: boolean; count: number; channels: { ch: number; name: string }[]; error?: string }
  streaming:       { ok: boolean; count: number; channels: { ch: number; name: string }[]; error?: string }
  streamingProxy?: { ok: boolean; count: number; channels: { ch: number; name: string }[]; error?: string }
}> {
  const client = createHikClient(nvr)

  // InputProxy
  const inputProxy = { ok: false, count: 0, channels: [] as { ch: number; name: string }[], error: undefined as string | undefined }
  try {
    const res = await client.get('/ISAPI/ContentMgmt/InputProxy/channels')
    const data = res.data
    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'InputProxyChannel')
      for (const block of blocks) {
        const ch = parseInt(xmlGet(block, 'id') || '0')
        const name = xmlGet(block, 'customName') || xmlGet(block, 'name')
        if (ch) inputProxy.channels.push({ ch, name })
      }
    } else {
      const raw = data?.InputProxyChannelList?.InputProxyChannel
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        for (const item of list) {
          const ch = parseInt(item.id || item.channelNo || '0')
          const name = item.customName || item.name || ''
          if (ch) inputProxy.channels.push({ ch, name })
        }
      }
    }
    inputProxy.ok = true
    inputProxy.count = inputProxy.channels.length
  } catch (e: any) {
    inputProxy.error = e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || 'Error')
  }

  // VideoInput
  const videoInput = { ok: false, count: 0, channels: [] as { ch: number; name: string }[], error: undefined as string | undefined }
  try {
    const res = await client.get('/ISAPI/System/Video/inputs/channels')
    const data = res.data
    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'VideoInputChannel')
      for (const block of blocks) {
        const ch = parseInt(xmlGet(block, 'id') || xmlGet(block, 'inputPort') || '0')
        const name = xmlGet(block, 'customName') || xmlGet(block, 'name')
        if (ch) videoInput.channels.push({ ch, name })
      }
    } else {
      const raw = data?.VideoInputChannelList?.VideoInputChannel
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        for (const item of list) {
          const ch = parseInt(item.id || item.inputPort || '0')
          const name = item.customName || item.name || ''
          if (ch) videoInput.channels.push({ ch, name })
        }
      }
    }
    videoInput.ok = true
    videoInput.count = videoInput.channels.length
  } catch (e: any) {
    videoInput.error = e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || 'Error')
  }

  // Streaming channels
  const streaming = { ok: false, count: 0, channels: [] as { ch: number; name: string }[], error: undefined as string | undefined }
  try {
    const res = await client.get('/ISAPI/Streaming/channels')
    const data = res.data
    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'StreamingChannel')
      for (const block of blocks) {
        const rawId = parseInt(xmlGet(block, 'id') || '0')
        if (!rawId) continue
        const ch = Math.round(rawId / 100)
        const name = xmlGet(block, 'channelName')
        streaming.channels.push({ ch, name })
      }
    } else {
      const raw = data?.StreamingChannelList?.StreamingChannel
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        for (const item of list) {
          const rawId = parseInt(item.id || '0')
          if (!rawId) continue
          streaming.channels.push({ ch: Math.round(rawId / 100), name: item.channelName || '' })
        }
      }
    }
    streaming.ok = true
    streaming.count = streaming.channels.length
  } catch (e: any) {
    streaming.error = e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || 'Error')
  }

  // StreamingProxy channels (some Hikvision NVR firmware exposes this)
  const streamingProxy = { ok: false, count: 0, channels: [] as { ch: number; name: string }[], error: undefined as string | undefined }
  try {
    const res = await client.get('/ISAPI/ContentMgmt/StreamingProxy/channels')
    const data = res.data
    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'StreamingProxyChannel')
      for (const block of blocks) {
        const ch = parseInt(xmlGet(block, 'id') || xmlGet(block, 'channelNo') || '0')
        const name = xmlGet(block, 'customName') || xmlGet(block, 'name') || xmlGet(block, 'channelName')
        if (ch) streamingProxy.channels.push({ ch, name })
      }
    } else {
      const raw = data?.StreamingProxyChannelList?.StreamingProxyChannel
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        for (const item of list) {
          const ch = parseInt(item.id || item.channelNo || '0')
          const name = item.customName || item.name || item.channelName || ''
          if (ch) streamingProxy.channels.push({ ch, name })
        }
      }
    }
    streamingProxy.ok = true
    streamingProxy.count = streamingProxy.channels.length
  } catch (e: any) {
    streamingProxy.error = e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || 'Error')
  }

  return { inputProxy, videoInput, streaming, streamingProxy }
}

// ─── Probe InputProxy availability ───────────────────────────
// Quick single-request probe to determine ISAPI permission for InputProxy.
// Returns a semantic status string without throwing.
export async function probeInputProxy(nvr: NVR): Promise<'available' | 'no_permission' | 'unsupported' | 'error' | 'unknown'> {
  const client = createHikClient(nvr)
  try {
    await client.get('/ISAPI/ContentMgmt/InputProxy/channels')
    return 'available'
  } catch (e: any) {
    const s: number | undefined = e?.response?.status
    if (s === 401 || s === 403) return 'no_permission'
    if (s === 400 || s === 404 || s === 405 || s === 501) return 'unsupported'
    if (s) return 'error'
    return 'unknown'  // network error / no response
  }
}

// ─── Diagnóstico de fuentes ISAPI para cámaras IP ─────────────
// Prueba cada endpoint con Digest Auth y devuelve status HTTP, content-type,
// tamaño, snippet sanitizado, si es parseable y top-level XML tags detectados.
// Nunca loguea credenciales ni cookies.
// Los endpoints marcados con "security=..." son firmados por la UI Hikvision
// con HMAC interno — no reproducibles desde backend con Digest Auth estándar.
export async function getIpCameraSourcesDebug(nvr: NVR): Promise<{
  endpoint: string
  status: number | null
  ok: boolean
  contentType: string
  byteLength: number
  snippet: string
  parseable: boolean
  detectedFields: string[]   // top-level XML tags or JSON keys found in the response
  hasFields: Record<string, boolean>  // presence check for specific important tags
  note?: string
  error?: string
}[]> {
  const client = createHikClient(nvr)
  const endpoints: Array<{ ep: string; note?: string }> = [
    { ep: '/ISAPI/System/deviceInfo' },
    { ep: '/ISAPI/ContentMgmt/InputProxy/channels',         note: 'Prioridad A: IP, nombre, protocolo por canal' },
    { ep: '/ISAPI/ContentMgmt/InputProxy/channels/status',  note: 'Prioridad B: estado online/offline real por canal' },
    { ep: '/ISAPI/ContentMgmt/ZeroVideo/channels',          note: 'Diagnóstico: canales sin video activo (no usar para nombres/IP)' },
    { ep: '/ISAPI/System/Video/inputs/channels',            note: 'Nombres de cámara — puede devolver 403 en algunos modelos' },
    { ep: '/ISAPI/Streaming/channels',                      note: 'Prioridad D: solo RTSP/códec — IDs (101,102) no son nombres reales' },
    { ep: '/ISAPI/Streaming/channels/101' },
    { ep: '/ISAPI/ContentMgmt/StreamingProxy/channels' },
    { ep: '/ISAPI/Security/users',                          note: 'Lista de usuarios configurados' },
  ]

  function isParseableBody(body: string, ct: string): boolean {
    if (ct.includes('json')) {
      try { JSON.parse(body); return true } catch { return false }
    }
    return body.trimStart().startsWith('<') && body.includes('</')
  }

  // Extract top-level XML tag names or JSON object keys for quick field inspection.
  function detectFields(body: string, ct: string): string[] {
    if (ct.includes('json')) {
      try {
        const parsed = JSON.parse(body)
        if (parsed && typeof parsed === 'object') return Object.keys(parsed).slice(0, 20)
      } catch { /* ignore */ }
      return []
    }
    // XML: find all unique top-level-ish tag names (children of root)
    const matches = body.match(/<([A-Za-z][A-Za-z0-9]*)[>\s/]/g) || []
    const tags = [...new Set(matches.map(m => m.replace(/[<>\s/]/g, '')))]
    return tags.slice(0, 20)
  }

  const IMPORTANT_FIELDS = [
    'ipAddress', 'managePortNo', 'proxyProtocol', 'name', 'online',
    'chanDetectResult', 'sourceInputPortDescriptor', 'channelName',
    'dynVideoInputChannelID', 'id', 'PasswordStatus', 'securityStatus',
  ]

  function checkHasFields(body: string, ct: string): Record<string, boolean> {
    const result: Record<string, boolean> = {}
    if (ct.includes('json')) {
      let flat = ''
      try { flat = JSON.stringify(JSON.parse(body)) } catch { flat = body }
      for (const f of IMPORTANT_FIELDS) result[f] = flat.includes(`"${f}"`)
    } else {
      for (const f of IMPORTANT_FIELDS) result[f] = new RegExp(`<${f}[>\\s/]`).test(body)
    }
    return result
  }

  const results = await Promise.allSettled(
    endpoints.map(async ({ ep, note }) => {
      try {
        const res = await client.get(ep)
        const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
        const ct = String(res.headers['content-type'] || '')
        const snippet = body.slice(0, 400).replace(/password[^<"'\s]*/gi, 'password***')
        return {
          endpoint:       ep,
          status:         res.status,
          ok:             true,
          contentType:    ct,
          byteLength:     body.length,
          snippet,
          parseable:      isParseableBody(body, ct),
          detectedFields: detectFields(body, ct),
          hasFields:      checkHasFields(body, ct),
          ...(note ? { note } : {}),
        }
      } catch (e: any) {
        const httpStatus: number | null = e?.response?.status ?? null
        const body = typeof e?.response?.data === 'string' ? e.response.data : JSON.stringify(e?.response?.data || '')
        const ct = String(e?.response?.headers?.['content-type'] || '')
        const snippet = body ? body.slice(0, 200) : ''
        return {
          endpoint:       ep,
          status:         httpStatus,
          ok:             false,
          contentType:    ct,
          byteLength:     body.length,
          snippet,
          parseable:      false,
          detectedFields: [],
          hasFields:      {},
          ...(note ? { note } : {}),
          error: httpStatus ? `HTTP ${httpStatus}` : (e?.code || e?.message || 'Error de red'),
        }
      }
    })
  )

  return results.map((r) => r.status === 'fulfilled' ? r.value : {
    endpoint:       'unknown',
    status:         null,
    ok:             false,
    contentType:    '',
    byteLength:     0,
    snippet:        '',
    parseable:      false,
    detectedFields: [],
    error:          'Promise rejected',
  })
}

// ─── Almacenamiento / HDDs ────────────────────────────────────

export async function getStorageInfo(nvr: NVR): Promise<HikStorageDisk[]> {
  const client = createHikClient(nvr)

  const parseDisksJson = (raw: any, disks: HikStorageDisk[]) => {
    const list = Array.isArray(raw) ? raw : [raw]
    list.forEach((d: any, i: number) => {
      const capacityKb = parseInt(d.capacity || d.totalCapacity || '0')
      const freeKb     = parseInt(d.freeSpace || d.remainCapacity || '0')
      const capGb      = capacityKb / 1024
      const freeGb     = freeKb / 1024
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

  const parseDisksXml = (data: string, disks: HikStorageDisk[]) => {
    const blocks = xmlGetAll(data, 'hdd')
    blocks.forEach((b, i) => {
      const cap  = parseInt(xmlGet(b, 'capacity') || '0')
      const free = parseInt(xmlGet(b, 'freeSpace') || '0')
      const capGb  = cap / 1024
      const freeGb = free / 1024
      disks.push({
        diskNumber:  i + 1,
        capacityGb:  Math.round(capGb * 100) / 100,
        freeGb:      Math.round(freeGb * 100) / 100,
        usedPercent: capGb > 0 ? Math.round(((capGb - freeGb) / capGb) * 100) : 0,
        status:      xmlGet(b, 'status'),
        type:        xmlGet(b, 'type') || 'local',
        property:    xmlGet(b, 'property'),
        process:     xmlGet(b, 'hddProcess'),
        _rawCapacity: cap,
        _rawFree: free,
      })
    })
  }

  const tryEndpoint = async (path: string): Promise<HikStorageDisk[] | null> => {
    try {
      const res = await client.get(path)
      if (!res?.data) return null
      const disks: HikStorageDisk[] = []
      if (typeof res.data === 'string') {
        parseDisksXml(res.data, disks)
      } else {
        const storage = res.data?.StorageList?.storage || res.data?.hddList?.hdd
          || res.data?.HDDList?.HDD || res.data?.diskList?.disk
        if (storage) parseDisksJson(storage, disks)
      }
      return disks.length > 0 ? disks : null
    } catch (err: any) {
      const status: number | undefined = err?.response?.status
      // 401/403 → permission error (not just unsupported) — propagate with context
      if (status === 401 || status === 403) {
        const e = new Error(`${path} rechazado (HTTP ${status}) — el usuario no tiene permiso`)
        ;(e as any).unsupported = true
        ;(e as any).httpStatus = status
        ;(e as any).permissionDenied = true
        throw e
      }
      return null  // 404/405/network — try next endpoint
    }
  }

  // Try endpoints in order; stop if we get a permission error (401/403).
  // Model-specific fallbacks cover DS-7732NI-K4, DS-7616NI-K2/16P, etc.
  const storagePaths = [
    '/ISAPI/ContentMgmt/Storage',
    '/ISAPI/System/Storage',
    '/ISAPI/Storage/hdd',
  ]

  for (const path of storagePaths) {
    try {
      const disks = await tryEndpoint(path)
      if (disks !== null) return disks
    } catch (e: any) {
      if ((e as any).permissionDenied) throw e  // 401/403 → stop trying, surface error
      // 404/405 → continue to next fallback
    }
  }

  // All endpoints returned 404/405 → model doesn't support storage ISAPI
  const e = new Error(`Almacenamiento ISAPI no soportado por este modelo/firmware`)
  ;(e as any).unsupported = true
  ;(e as any).httpStatus = 404
  throw e
}

// ─── Usuarios del NVR ─────────────────────────────────────────

export async function getNVRUsers(nvr: NVR): Promise<HikNVRUser[]> {
  const client = createHikClient(nvr)

  const parseUsers = (data: any): HikNVRUser[] => {
    const users: HikNVRUser[] = []
    if (typeof data === 'string') {
      const blocks = xmlGetAll(data, 'User')
      blocks.forEach(b => {
        const enabledStr = xmlGet(b, 'enabled')
        users.push({
          id:        parseInt(xmlGet(b, 'id') || '0'),
          name:      xmlGet(b, 'userName'),
          userLevel: xmlGet(b, 'userLevel') || xmlGet(b, 'roleType'),
          active:    enabledStr ? enabledStr === 'true' : true,
          enabled:   enabledStr ? enabledStr === 'true' : undefined,
        })
      })
    } else {
      const raw = data?.UserList?.User || data?.userList?.User || data?.users?.User
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        list.forEach((u: any) => {
          const enabled = u.enabled !== undefined ? u.enabled === true || u.enabled === 'true' : undefined
          users.push({
            id:        parseInt(u.id || '0'),
            name:      u.userName || u.name || '',
            userLevel: u.userLevel || u.roleType || '',
            active:    enabled !== undefined ? enabled : true,
            enabled,
          })
        })
      }
    }
    return users
  }

  const tryEndpoint = async (path: string): Promise<HikNVRUser[] | null> => {
    try {
      const res = await client.get(path)
      if (!res?.data) return null
      const users = parseUsers(res.data)
      return users.length > 0 ? users : null
    } catch (err: any) {
      const status: number | undefined = err?.response?.status
      if (status === 401 || status === 403) {
        const e = new Error(`${path} rechazado (HTTP ${status}) — el usuario no tiene permiso para gestión de usuarios`)
        ;(e as any).unsupported = true
        ;(e as any).httpStatus = status
        ;(e as any).permissionDenied = true
        throw e
      }
      return null  // 404/405 → try next
    }
  }

  const userPaths = [
    '/ISAPI/Security/users',
    '/ISAPI/Security/UserCheck',
    '/ISAPI/System/userList',
  ]

  for (const path of userPaths) {
    try {
      const users = await tryEndpoint(path)
      if (users !== null) return users
    } catch (e: any) {
      if ((e as any).permissionDenied) throw e
    }
  }

  const e = new Error(`Gestión de usuarios ISAPI no soportada por este modelo/firmware`)
  ;(e as any).unsupported = true
  ;(e as any).httpStatus = 404
  throw e
}

// ─── Gestión de usuarios NVR ─────────────────────────────────

function hikUserError(err: any): HikUserWriteResult {
  const status: number = err?.response?.status
  if (status === 404 || status === 405)
    return { success: false, unsupported: true, error: 'El NVR no soporta este endpoint ISAPI' }
  if (status === 400) {
    const detail = err?.response?.data
    const msg = typeof detail === 'string'
      ? (detail.match(/<errorMsg>([^<]+)<\/errorMsg>/)?.[1] || detail.slice(0, 120))
      : (detail?.ResponseStatus?.subStatusCode || detail?.statusString || 'Datos inválidos')
    return { success: false, error: String(msg) }
  }
  if (status === 401) return { success: false, error: 'Sin autorización (credenciales NVR)' }
  if (status === 403) return { success: false, error: 'Sin permisos para esta operación en el NVR' }
  return { success: false, error: `Error HTTP ${status ?? 'desconocido'}: ${err?.message || ''}` }
}

export async function createNVRUser(
  nvr: NVR,
  params: { name: string; password: string; userLevel: string }
): Promise<HikUserWriteResult> {
  try {
    const client = createHikClient(nvr)
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<User version="2.0">
  <userName>${params.name}</userName>
  <userLevel>${params.userLevel}</userLevel>
  <password>${params.password}</password>
</User>`
    const res = await client.post('/ISAPI/Security/users', body, {
      headers: { 'Content-Type': 'application/xml' },
    })
    const newId = parseInt(
      (typeof res.data === 'string' ? xmlGet(res.data, 'id') : String(res.data?.id || '')) || '0'
    )
    return { success: true, id: newId || undefined }
  } catch (err) {
    return hikUserError(err)
  }
}

export async function updateNVRUser(
  nvr: NVR,
  userId: number,
  params: { name: string; userLevel: string; enabled?: boolean }
): Promise<HikUserWriteResult> {
  try {
    const client = createHikClient(nvr)
    const enabledTag = params.enabled !== undefined
      ? `\n  <enabled>${params.enabled}</enabled>`
      : ''
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<User version="2.0">
  <id>${userId}</id>
  <userName>${params.name}</userName>
  <userLevel>${params.userLevel}</userLevel>${enabledTag}
</User>`
    await client.put(`/ISAPI/Security/users/${userId}`, body, {
      headers: { 'Content-Type': 'application/xml' },
    })
    return { success: true }
  } catch (err) {
    return hikUserError(err)
  }
}

export async function changeNVRUserPassword(
  nvr: NVR,
  userId: number,
  newPassword: string,
  userName: string
): Promise<HikUserWriteResult> {
  try {
    const client = createHikClient(nvr)
    // Include userName to satisfy strict NVR validators that require it on PUT
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<User version="2.0">
  <id>${userId}</id>
  <userName>${userName}</userName>
  <password>${newPassword}</password>
</User>`
    await client.put(`/ISAPI/Security/users/${userId}`, body, {
      headers: { 'Content-Type': 'application/xml' },
    })
    return { success: true }
  } catch (err) {
    return hikUserError(err)
  }
}

export async function deleteNVRUser(nvr: NVR, userId: number): Promise<HikUserWriteResult> {
  try {
    const client = createHikClient(nvr)
    await client.delete(`/ISAPI/Security/users/${userId}`)
    return { success: true }
  } catch (err) {
    return hikUserError(err)
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

// ─── Adopción de cámara IP en NVR ─────────────────────────────

export interface AdoptCameraParams {
  channel: number          // Canal destino en el NVR (1-based)
  name: string
  ipAddress: string
  port?: number            // Puerto de gestión (default 8000)
  username: string
  password: string
  protocol?: string        // HIKVISION | ONVIF | DAHUA | etc.
}

export async function adoptIpCamera(nvr: NVR, params: AdoptCameraParams): Promise<{ success: boolean; error?: string }> {
  try {
    const client = createHikClient(nvr)
    const ch = String(params.channel)

    const body = {
      InputProxyChannel: {
        id: ch,
        name: params.name,
        addressingFormatType: 'ipaddress',
        ipAddress: params.ipAddress,
        managePort: params.port || 8000,
        userName: params.username,
        password: params.password,
        srcInputPortDescriptor: {
          ProxyProtocol: { proxyProtocolType: params.protocol || 'HIKVISION' },
        },
      },
    }

    // Intentar crear primero
    try {
      await client.post(`/ISAPI/ContentMgmt/InputProxy/channels`, body)
      return { success: true }
    } catch (err: any) {
      const status = err.response?.status
      // Si ya existe en ese canal, intentar actualizar
      if (status === 400 || status === 409) {
        await client.put(`/ISAPI/ContentMgmt/InputProxy/channels/${ch}`, body)
        return { success: true }
      }
      throw err
    }
  } catch (err: any) {
    const msg = err.response?.data?.ResponseStatus?.statusString
      || err.response?.statusText
      || err.message
      || 'Error desconocido'
    return { success: false, error: msg }
  }
}

// Obtener lista de canales libres en un NVR (canales sin cámara asignada)
export async function getFreeChannels(nvr: NVR, totalChannels: number): Promise<number[]> {
  try {
    const cameras = await getIpCameraList(nvr)
    const usedChannels = new Set(cameras.map(c => c.channel))
    const free: number[] = []
    for (let i = 1; i <= totalChannels; i++) {
      if (!usedChannels.has(i)) free.push(i)
    }
    return free
  } catch {
    return []
  }
}

// ─── Test de conexión robusto ──────────────────────────────────
// Prueba múltiples endpoints ISAPI — no falla si uno no responde.
// Retorna structured result con código de error específico.

export interface HikConnectionTestResult {
  reachable: boolean
  errorCode?: 'AUTH_FAILED' | 'ISAPI_PERMISSION_DENIED' | 'NETWORK_UNREACHABLE' | 'ENDPOINT_UNSUPPORTED' | 'DEVICE_REACHABLE_PARTIAL_ISAPI'
  errorMessage?: string
  hint?: string        // User-facing guidance (e.g. "use Admin account, not Integration Protocol")
  firmware?: string
  model?: string
  serialNumber?: string
  diskUsage?: number
  channelCount?: number
  endpoints: { path: string; status: number | 'ok' | 'network_error' | 'auth' | 'unsupported' }[]
}

export async function testNVRConnection(
  nvr: { ipAddress: string; port: number; username: string; password: string },
): Promise<HikConnectionTestResult> {
  const client = createHikClient(nvr as any, 8000)
  const endpoints = [
    '/ISAPI/System/deviceInfo',
    '/ISAPI/ContentMgmt/InputProxy/channels',
    '/ISAPI/System/Video/inputs/channels',
  ]

  type EndpointResult = { path: string; status: number | 'ok' | 'network_error' | 'auth' | 'unsupported'; data?: any }
  const results: EndpointResult[] = []
  let networkError = false
  let allAuth = true

  for (const path of endpoints) {
    try {
      const res = await client.get(path)
      results.push({ path, status: 'ok', data: res.data })
      allAuth = false
    } catch (err: any) {
      const httpStatus: number | undefined = err.response?.status
      const code = err.code as string | undefined
      const isNetwork = !err.response && ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH', 'ENOTFOUND', 'ECONNRESET'].includes(code ?? '')

      if (isNetwork) {
        results.push({ path, status: 'network_error' })
        networkError = true
      } else if (httpStatus === 401 || httpStatus === 403) {
        results.push({ path, status: 'auth' })
        // allAuth stays true unless another endpoint succeeded
      } else if (httpStatus === 404 || httpStatus === 405) {
        results.push({ path, status: 'unsupported' })
        allAuth = false
      } else {
        results.push({ path, status: httpStatus ?? 'network_error' })
        allAuth = false
      }
    }
  }

  const summary = results.map(r => ({ path: r.path, status: r.status }))
  const anyOk   = results.some(r => r.status === 'ok')
  const anyAuth  = results.some(r => r.status === 'auth')

  // Network unreachable: all endpoints had network errors, none responded with any HTTP
  if (!anyOk && networkError && !anyAuth) {
    return {
      reachable: false,
      errorCode: 'NETWORK_UNREACHABLE',
      errorMessage: `No se pudo alcanzar ${nvr.ipAddress}:${nvr.port} — verifica IP, puerto y que el NVR esté encendido`,
      endpoints: summary,
    }
  }

  // All endpoints rejected credentials: distinguish wrong password from ISAPI permission issues.
  // If the device responded with HTTP 401 to Digest Auth (after retry), it could be:
  //   a) Wrong password: credentials rejected entirely
  //   b) User exists but has no ISAPI access (e.g. created under "Integration Protocol" only)
  // We cannot distinguish these from HTTP code alone, so we surface both possibilities.
  if (!anyOk && allAuth) {
    return {
      reachable: false,
      errorCode: 'AUTH_FAILED',
      errorMessage: `Credenciales rechazadas por el NVR (HTTP 401). El usuario "${nvr.username}" tiene contraseña incorrecta o no tiene acceso ISAPI.`,
      hint: 'En Hikvision, los usuarios creados sólo en "Protocolo de integración" no tienen acceso a /ISAPI/System/deviceInfo. Usa un usuario creado en "Administración de cuenta" del NVR con nivel Administrador u Operador.',
      endpoints: summary,
    }
  }

  // Some endpoints returned 401 but others succeeded: the user exists but lacks full ISAPI permissions
  if (anyOk && anyAuth) {
    const failedPaths = results.filter(r => r.status === 'auth').map(r => r.path)
    return {
      reachable: true,
      errorCode: 'ISAPI_PERMISSION_DENIED',
      errorMessage: `El usuario "${nvr.username}" tiene acceso parcial: ${failedPaths.length} endpoint(s) devolvieron 401.`,
      hint: 'Para acceso completo al sistema, usa un usuario Administrador del NVR. Los usuarios de "Protocolo de integración" pueden tener acceso ISAPI limitado.',
      endpoints: summary,
    }
  }

  if (!anyOk) {
    return {
      reachable: false,
      errorCode: 'ENDPOINT_UNSUPPORTED',
      errorMessage: 'El dispositivo responde pero ningún endpoint ISAPI fue accesible',
      endpoints: summary,
    }
  }

  // At least one endpoint OK — extract device info
  const deviceInfoResult = results.find(r => r.path === '/ISAPI/System/deviceInfo' && r.status === 'ok')
  let firmware: string | undefined
  let model: string | undefined
  let serialNumber: string | undefined
  let channelCount: number | undefined

  if (deviceInfoResult?.data) {
    const d = deviceInfoResult.data
    if (typeof d === 'string') {
      firmware      = xmlGet(d, 'firmwareVersion') || undefined
      model         = xmlGet(d, 'model') || undefined
      serialNumber  = xmlGet(d, 'serialNumber') || undefined
      const chNum   = parseInt(xmlGet(d, 'ipChannelNum') || xmlGet(d, 'analogChannelNum') || '0')
      channelCount  = chNum || undefined
    } else {
      const di = d?.DeviceInfo || d
      firmware      = di?.firmwareVersion || undefined
      model         = di?.model || undefined
      serialNumber  = di?.serialNumber || undefined
      const chNum   = parseInt(di?.ipChannelNum || di?.analogChannelNum || '0')
      channelCount  = chNum || undefined
    }
  }

  // Partial reachability: some endpoints failed
  const partialOnly = results.some(r => r.status !== 'ok' && r.status !== 'unsupported')
  if (partialOnly && !deviceInfoResult) {
    return {
      reachable: true,
      errorCode: 'DEVICE_REACHABLE_PARTIAL_ISAPI',
      errorMessage: 'Dispositivo alcanzable pero algunos endpoints ISAPI no respondieron correctamente',
      firmware,
      model,
      serialNumber,
      channelCount,
      endpoints: summary,
    }
  }

  return { reachable: true, firmware, model, serialNumber, channelCount, endpoints: summary }
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
