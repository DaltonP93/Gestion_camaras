// apps/api/src/services/hikvision.ts
// Integración completa con la API ISAPI de Hikvision
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'
import crypto from 'crypto'
import type { NVR } from '@prisma/client'

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

// Build Digest Authorization header from a WWW-Authenticate challenge
function buildDigestAuth(
  username: string, password: string,
  method: string, uri: string,
  wwwAuth: string,
): string {
  const realm = (wwwAuth.match(/realm="([^"]+)"/) || [])[1] ?? ''
  const nonce = (wwwAuth.match(/nonce="([^"]+)"/) || [])[1] ?? ''
  const qop   = (wwwAuth.match(/qop="?([^",]+)"?/) || [])[1]
  const nc    = '00000001'
  const cnonce = crypto.randomBytes(8).toString('hex')

  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')
  const ha1 = md5(`${username}:${realm}:${password}`)
  const ha2 = md5(`${method}:${uri}`)

  let response: string
  if (qop) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`)
  }

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  return header
}

// Crea cliente HTTP con soporte Basic + Digest automático para Hikvision
function createHikClient(nvr: NVR): AxiosInstance {
  const { username, password } = nvr

  const client = axios.create({
    baseURL: `http://${nvr.ipAddress}:${nvr.port}`,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  })

  // Interceptor: on 401 Digest challenge, retry once with Digest auth
  client.interceptors.response.use(undefined, async (err) => {
    const res = err.response
    if (res?.status === 401 && !err.config._digestRetried) {
      const wwwAuth: string = res.headers['www-authenticate'] ?? ''
      if (wwwAuth.toLowerCase().startsWith('digest')) {
        err.config._digestRetried = true
        const cfg: AxiosRequestConfig & { _digestRetried?: boolean } = err.config
        const method = (cfg.method ?? 'GET').toUpperCase()
        const url = new URL(cfg.url ?? '/', `http://${nvr.ipAddress}`)
        const uri = url.pathname + url.search
        cfg.headers = cfg.headers ?? {}
        cfg.headers['Authorization'] = buildDigestAuth(username, password, method, uri, wwwAuth)
        return client.request(cfg)
      }
      // Basic auth fallback (some NVRs accept it when configured)
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

// ─── Obtener estado general del NVR ──────────────────────────
export async function getNVRStatus(nvr: NVR): Promise<HikNVRStatus> {
  try {
    const client = createHikClient(nvr)

    // ISAPI: Información del sistema
    const [sysResponse, diskResponse] = await Promise.allSettled([
      client.get('/ISAPI/System/deviceInfo'),
      client.get('/ISAPI/ContentMgmt/Storage'),
    ])

    // If the primary call failed the NVR is unreachable or credentials are wrong
    if (sysResponse.status === 'rejected') {
      return {
        online: false,
        firmware: nvr.firmware || 'Desconocido',
        diskUsage: 0,
        cpuUsage: 0,
      }
    }

    const sysData = sysResponse.value.data
    const diskData = diskResponse.status === 'fulfilled' ? diskResponse.value.data : null

    // Calcular uso de disco
    let diskUsage = 0
    if (diskData?.StorageList?.storage) {
      const storages = Array.isArray(diskData.StorageList.storage)
        ? diskData.StorageList.storage
        : [diskData.StorageList.storage]
      const totalHDD = storages.reduce((acc: number, s: any) => acc + (s.capacity || 0), 0)
      const usedHDD = storages.reduce((acc: number, s: any) => acc + (s.freeSpace ? s.capacity - s.freeSpace : 0), 0)
      diskUsage = totalHDD > 0 ? Math.round((usedHDD / totalHDD) * 100) : 0
    }

    return {
      online: true,
      firmware: sysData?.DeviceInfo?.firmwareVersion || nvr.firmware || 'Desconocido',
      diskUsage,
      cpuUsage: 0,
    }
  } catch (err) {
    return {
      online: false,
      firmware: nvr.firmware || 'Desconocido',
      diskUsage: 0,
      cpuUsage: 0,
    }
  }
}

// ─── Obtener canales del NVR ─────────────────────────────────
export async function getNVRChannels(nvr: NVR): Promise<HikChannel[]> {
  try {
    const client = createHikClient(nvr)
    const response = await client.get('/ISAPI/System/Video/inputs/channels')

    const channelsData = response.data?.VideoInputChannelList?.VideoInputChannel
    if (!channelsData) return []

    const channels = Array.isArray(channelsData) ? channelsData : [channelsData]

    return channels.map((ch: any) => ({
      id: parseInt(ch.id),
      name: ch.name || `Canal ${ch.id}`,
      online: ch.connectionType !== 'N/A',
      rtspUrl: buildRtspUrl(nvr, parseInt(ch.id)),
    }))
  } catch (err) {
    // Si ISAPI falla, generar canales genéricos basados en la config del NVR
    return Array.from({ length: nvr.channels }, (_, i) => ({
      id: i + 1,
      name: `Canal ${i + 1}`,
      online: false,
      rtspUrl: buildRtspUrl(nvr, i + 1),
    }))
  }
}

// ─── Construir URL RTSP para una cámara ──────────────────────
export function buildRtspUrl(nvr: NVR, channel: number, subStream = false): string {
  // Formato estándar Hikvision: rtsp://user:pass@ip:554/Streaming/Channels/CH01
  const channelStr = String(channel).padStart(2, '0')
  const streamType = subStream ? '02' : '01'
  return `rtsp://${nvr.username}:${nvr.password}@${nvr.ipAddress}:${nvr.rtspPort}/Streaming/Channels/${channelStr}${streamType}`
}

// ─── Buscar grabaciones ───────────────────────────────────────
export async function searchRecordings(
  nvr: NVR,
  channel: number,
  startTime: Date,
  endTime: Date
): Promise<HikRecording[]> {
  try {
    const client = createHikClient(nvr)

    const body = {
      CMSearchDescription: {
        searchID: `search_${Date.now()}`,
        trackList: {
          TrackDescriptor: {
            trackID: `${String(channel).padStart(2, '0')}00`,
          },
        },
        timeSpanList: {
          TimeSpan: {
            startTime: startTime.toISOString().replace('Z', '+00:00'),
            endTime: endTime.toISOString().replace('Z', '+00:00'),
          },
        },
        maxResults: 100,
        searchResultPostion: 0,
        metadataList: {
          metadataDescriptor: '//recordType.meta.std-cgi.com',
        },
      },
    }

    const response = await client.post('/ISAPI/ContentMgmt/search', body)
    const items = response.data?.CMSearchResult?.matchList?.SearchMatchItem

    if (!items) return []
    const recordingList = Array.isArray(items) ? items : [items]

    return recordingList.map((item: any, index: number) => ({
      id: `${nvr.id}_${channel}_${index}`,
      channel,
      startTime: item.timeSpan?.startTime || '',
      endTime: item.timeSpan?.endTime || '',
      size: item.mediaSegmentDescriptor?.contentLength || 0,
      type: item.mediaSegmentDescriptor?.contentType || 'video/mp4',
    }))
  } catch (err) {
    return []
  }
}

// ─── Obtener URL de reproducción de grabación ─────────────────
export async function getPlaybackUrl(
  nvr: NVR,
  channel: number,
  startTime: Date,
  endTime: Date
): Promise<HikPlaybackUrl> {
  // Hikvision soporta playback via RTSP con parámetros de tiempo
  const channelStr = String(channel).padStart(2, '0')
  const startIso = startTime.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  const endIso = endTime.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'

  const url = `rtsp://${nvr.username}:${nvr.password}@${nvr.ipAddress}:${nvr.rtspPort}/Streaming/tracks/${channelStr}00?starttime=${startIso}&endtime=${endIso}`

  return {
    url,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }
}

// ─── Control PTZ ──────────────────────────────────────────────
export type PTZCommand = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'ZOOM_IN' | 'ZOOM_OUT' | 'STOP'

export async function sendPTZCommand(
  nvr: NVR,
  channel: number,
  command: PTZCommand,
  speed: number = 50
): Promise<boolean> {
  try {
    const client = createHikClient(nvr)

    const ptzMap: Record<PTZCommand, object> = {
      UP: { pan: 0, tilt: speed, zoom: 0 },
      DOWN: { pan: 0, tilt: -speed, zoom: 0 },
      LEFT: { pan: -speed, tilt: 0, zoom: 0 },
      RIGHT: { pan: speed, tilt: 0, zoom: 0 },
      ZOOM_IN: { pan: 0, tilt: 0, zoom: speed },
      ZOOM_OUT: { pan: 0, tilt: 0, zoom: -speed },
      STOP: { pan: 0, tilt: 0, zoom: 0 },
    }

    const channelStr = String(channel).padStart(2, '0')
    await client.put(
      `/ISAPI/PTZCtrl/channels/${channelStr}/continuous`,
      { PTZData: ptzMap[command] }
    )

    return true
  } catch (err) {
    return false
  }
}

// ─── Capturar imagen (snapshot) ──────────────────────────────
export async function captureSnapshot(nvr: NVR, channel: number): Promise<Buffer | null> {
  try {
    const client = createHikClient(nvr)
    const channelStr = String(channel).padStart(2, '0')

    const response = await client.get(
      `/ISAPI/Streaming/channels/${channelStr}01/picture`,
      { responseType: 'arraybuffer' }
    )

    return Buffer.from(response.data)
  } catch (err) {
    return null
  }
}
