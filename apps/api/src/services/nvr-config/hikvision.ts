// apps/api/src/services/nvr-config/hikvision.ts
// Read-only NVR configuration adapter for Hikvision via ISAPI.
// All writes are blocked at this layer until the write-with-backup
// workflow is implemented.
import axios from 'axios'
import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NvrCredentials {
  ipAddress: string
  port:      number
  username:  string
  password:  string  // plaintext (caller must decrypt before passing)
}

export interface VideoStreamConfig {
  streamType:      'main' | 'sub'
  videoCodecType:  string     // H.264, H.265, H.265+, MJPEG…
  videoScanType:   string     // progressive, interlaced
  width:           number
  height:          number
  fps:             number     // actual frames/s
  bitrateType:     string     // CBR | VBR
  bitrateMax:      number     // kbps
  qualityLevel:    string     // lowest…highest (VBR)
  h265Plus:        boolean
  audioEnabled:    boolean
  audioCodecType:  string
  audioInputType:  string
  audioBitrate:    number
  raw?:            string     // raw XML snippet for debug
}

export interface ChannelVideoConfig {
  nvrId:    string
  channel:  number
  main:     VideoStreamConfig | null
  sub:      VideoStreamConfig | null
  fetchedAt: string
  error?:   string
}

// ─── Digest auth ─────────────────────────────────────────────────────────────

function buildDigest(
  username: string, password: string, method: string, uri: string, wwwAuth: string
): string {
  const realm  = (wwwAuth.match(/realm="([^"]+)"/)  || [])[1] ?? ''
  const nonce  = (wwwAuth.match(/nonce="([^"]+)"/)  || [])[1] ?? ''
  const qop    = (wwwAuth.match(/qop="?([^",]+)"?/) || [])[1]
  const nc     = '00000001'
  const cnonce = crypto.randomBytes(8).toString('hex')
  const md5    = (s: string) => crypto.createHash('md5').update(s).digest('hex')
  const ha1    = md5(`${username}:${realm}:${password}`)
  const ha2    = md5(`${method}:${uri}`)
  const resp   = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`)
  let h = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${resp}"`
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  return h
}

function makeClient(creds: NvrCredentials, timeoutMs = 10000) {
  const { username, password } = creds
  const client = axios.create({
    baseURL: `http://${creds.ipAddress}:${creds.port}`,
    timeout: timeoutMs,
    headers: { Accept: 'application/xml, text/xml, */*' },
  })
  client.interceptors.response.use(undefined, async (err) => {
    const res = err.response
    if (res?.status === 401 && !err.config._digestRetried) {
      const wwwAuth: string = res.headers['www-authenticate'] ?? ''
      if (wwwAuth.toLowerCase().startsWith('digest')) {
        err.config._digestRetried = true
        const method = (err.config.method ?? 'GET').toUpperCase()
        const url    = new URL(err.config.url ?? '/', `http://${creds.ipAddress}`)
        err.config.headers['Authorization'] = buildDigest(username, password, method, url.pathname + url.search, wwwAuth)
        return client.request(err.config)
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

// ─── XML helpers ─────────────────────────────────────────────────────────────

function xmlGet(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

function parseBoolean(v: string): boolean {
  return v === 'true' || v === '1' || v === 'yes'
}

function parseFps(raw: string): number {
  const n = parseInt(raw || '0')
  // Hikvision stores fps * 100 for some models, direct value for others
  if (n > 100) return Math.round(n / 100)
  return n
}

// ─── Parse one streaming channel XML ─────────────────────────────────────────

function parseStreamXml(xml: string, streamType: 'main' | 'sub'): VideoStreamConfig {
  const codec   = xmlGet(xml, 'videoCodecType')
  const scanType = xmlGet(xml, 'videoScanType') || 'progressive'
  const w       = parseInt(xmlGet(xml, 'videoResolutionWidth')  || '0')
  const h       = parseInt(xmlGet(xml, 'videoResolutionHeight') || '0')
  const fpsRaw  = xmlGet(xml, 'maxFrameRate') || xmlGet(xml, 'frameRate')
  const bitrateType = xmlGet(xml, 'videoQualityControlType') || xmlGet(xml, 'bitrateType') || 'CBR'
  const bitrateMax  = parseInt(
    xmlGet(xml, 'videoBitRate') ||
    xmlGet(xml, 'vbrUpperCap')  ||
    xmlGet(xml, 'constantBitRate') || '0'
  )
  const qualityLevel = xmlGet(xml, 'fixedQuality') || xmlGet(xml, 'videoQuality') || ''
  const h265Plus     = codec.toLowerCase().includes('h.265+') || parseBoolean(xmlGet(xml, 'SmartEncode'))

  // Audio
  const audioEnabled   = parseBoolean(xmlGet(xml, 'enabled') || '0')
  const audioCodec     = xmlGet(xml, 'audioCompressionType') || xmlGet(xml, 'audioCodecType') || ''
  const audioInputType = xmlGet(xml, 'audioInputType') || ''
  const audioBitrate   = parseInt(xmlGet(xml, 'audioBitRate') || '0')

  return {
    streamType,
    videoCodecType: codec,
    videoScanType:  scanType,
    width:  w,
    height: h,
    fps:    parseFps(fpsRaw),
    bitrateType:  bitrateType.toUpperCase(),
    bitrateMax,
    qualityLevel,
    h265Plus,
    audioEnabled,
    audioCodecType:  audioCodec,
    audioInputType,
    audioBitrate,
    raw: xml.length > 2000 ? xml.slice(0, 2000) + '…' : xml,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read video/audio config for one channel from the NVR.
 * channel is 1-based.
 */
export async function getChannelVideoConfig(
  nvrId: string,
  creds: NvrCredentials,
  channel: number
): Promise<ChannelVideoConfig> {
  const result: ChannelVideoConfig = {
    nvrId,
    channel,
    main:      null,
    sub:       null,
    fetchedAt: new Date().toISOString(),
  }

  const client = makeClient(creds)
  const ch = String(channel).padStart(2, '0')

  const [mainRes, subRes] = await Promise.allSettled([
    client.get<string>(`/ISAPI/Streaming/channels/${ch}01`),
    client.get<string>(`/ISAPI/Streaming/channels/${ch}02`),
  ])

  if (mainRes.status === 'fulfilled') {
    const xml = typeof mainRes.value.data === 'string'
      ? mainRes.value.data
      : JSON.stringify(mainRes.value.data)
    result.main = parseStreamXml(xml, 'main')
  }

  if (subRes.status === 'fulfilled') {
    const xml = typeof subRes.value.data === 'string'
      ? subRes.value.data
      : JSON.stringify(subRes.value.data)
    result.sub = parseStreamXml(xml, 'sub')
  }

  if (!result.main && !result.sub) {
    const errMain = mainRes.status === 'rejected' ? (mainRes.reason as any)?.message ?? 'error' : null
    result.error = `No se pudo leer la configuración de video del canal ${channel}: ${errMain ?? 'streams no disponibles'}`
  }

  return result
}

/**
 * Read video config for ALL channels of an NVR by reading from DB channels.
 * channels: array of 1-based channel numbers.
 */
export async function getAllChannelsVideoConfig(
  nvrId: string,
  creds: NvrCredentials,
  channels: number[]
): Promise<ChannelVideoConfig[]> {
  // Limit to 32 channels to avoid hammering the NVR
  const limited = channels.slice(0, 32)
  const results = await Promise.all(
    limited.map((ch) => getChannelVideoConfig(nvrId, creds, ch))
  )
  return results
}

// ─── Write API ────────────────────────────────────────────────────────────────

export interface VideoStreamUpdate {
  videoCodecType?: string      // 'H.264' | 'H.265' | 'H.264+'| 'H.265+'
  width?: number
  height?: number
  fps?: number                 // will be stored as fps*100 for Hikvision
  bitrateType?: string         // 'CBR' | 'VBR'
  bitrateMax?: number          // kbps
  qualityLevel?: string
  audioEnabled?: boolean
  audioCodecType?: string
  audioBitrate?: number
}

/**
 * Writes video/audio configuration to NVR for one channel and stream (main=01, sub=02).
 * Strategy:
 *   1. GET current XML from ISAPI
 *   2. Replace only the fields present in `update` using simple XML tag replacement
 *   3. PUT modified XML back
 * Returns the updated config by re-reading from NVR after the write.
 */
export async function putChannelVideoConfig(
  nvrId: string,
  creds: NvrCredentials,
  channel: number,
  streamType: 'main' | 'sub',
  update: VideoStreamUpdate
): Promise<{ success: boolean; error?: string; config?: ChannelVideoConfig }> {
  try {
    function replaceXmlTag(xml: string, tag: string, value: string): string {
      return xml.replace(
        new RegExp(`(<${tag}(?:\\s[^>]*)?>)[\\s\\S]*?(</${tag}>)`, 'i'),
        `$1${value}$2`
      )
    }

    const suffix = streamType === 'main' ? '01' : '02'
    const ch = String(channel).padStart(2, '0')
    const endpoint = `/ISAPI/Streaming/channels/${ch}${suffix}`

    const client = makeClient(creds)

    // 1. GET current XML
    const getRes = await client.get<string>(endpoint)
    let xml: string = typeof getRes.data === 'string'
      ? getRes.data
      : JSON.stringify(getRes.data)

    // 2. Apply field replacements
    if (update.videoCodecType !== undefined) {
      xml = replaceXmlTag(xml, 'videoCodecType', update.videoCodecType)
    }
    if (update.width !== undefined) {
      xml = replaceXmlTag(xml, 'videoResolutionWidth', String(update.width))
    }
    if (update.height !== undefined) {
      xml = replaceXmlTag(xml, 'videoResolutionHeight', String(update.height))
    }
    if (update.fps !== undefined) {
      const fpsVal = String(update.fps * 100)
      if (/<maxFrameRate[\s>]/i.test(xml)) {
        xml = replaceXmlTag(xml, 'maxFrameRate', fpsVal)
      } else {
        xml = replaceXmlTag(xml, 'frameRate', fpsVal)
      }
    }
    if (update.bitrateType !== undefined) {
      if (/<videoQualityControlType[\s>]/i.test(xml)) {
        xml = replaceXmlTag(xml, 'videoQualityControlType', update.bitrateType)
      } else {
        xml = replaceXmlTag(xml, 'bitrateType', update.bitrateType)
      }
    }
    if (update.bitrateMax !== undefined) {
      if (/<videoBitRate[\s>]/i.test(xml)) {
        xml = replaceXmlTag(xml, 'videoBitRate', String(update.bitrateMax))
      } else {
        xml = replaceXmlTag(xml, 'constantBitRate', String(update.bitrateMax))
      }
    }
    if (update.qualityLevel !== undefined) {
      if (/<fixedQuality[\s>]/i.test(xml)) {
        xml = replaceXmlTag(xml, 'fixedQuality', update.qualityLevel)
      } else {
        xml = replaceXmlTag(xml, 'videoQuality', update.qualityLevel)
      }
    }
    if (update.audioEnabled !== undefined) {
      xml = replaceXmlTag(xml, 'enabled', update.audioEnabled ? 'true' : 'false')
    }
    if (update.audioCodecType !== undefined) {
      if (/<audioCompressionType[\s>]/i.test(xml)) {
        xml = replaceXmlTag(xml, 'audioCompressionType', update.audioCodecType)
      } else {
        xml = replaceXmlTag(xml, 'audioCodecType', update.audioCodecType)
      }
    }
    if (update.audioBitrate !== undefined) {
      xml = replaceXmlTag(xml, 'audioBitRate', String(update.audioBitrate))
    }

    // 3. PUT modified XML back
    const putRes = await client.put(endpoint, xml, {
      headers: { 'Content-Type': 'application/xml' },
    })

    if (putRes.status < 200 || putRes.status >= 300) {
      return { success: false, error: putRes.statusText }
    }

    // 4. Re-read and return the updated config
    const freshConfig = await getChannelVideoConfig(nvrId, creds, channel)
    return { success: true, config: freshConfig }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}
