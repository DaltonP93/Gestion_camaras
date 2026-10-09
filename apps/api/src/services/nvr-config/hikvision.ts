// apps/api/src/services/nvr-config/hikvision.ts
// Read-only NVR configuration adapter for Hikvision via ISAPI.
// All writes are blocked at this layer until the write-with-backup
// workflow is implemented.
import axios from 'axios'
import crypto from 'crypto'
import { assertSafeNvrHostForUrl } from '../net/nvr-host-guard'

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
  // true sólo si audioEnabled/codec/bitrate se leyeron del ÚNICO bloque <Audio>.
  // Los backups anteriores no lo traen: su audioEnabled era el <enabled> del CANAL.
  audioBlockPresent?: boolean
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
  // Defensa en profundidad SSRF: valida el host (IP-literal LAN) y usa la forma
  // CANÓNICA para construir la URL (IPv6 entre corchetes) — igual que services/
  // hikvision.ts — de modo que se conecte EXACTAMENTE al destino validado y una IPv6
  // no genere una URL ambigua (`http://fd12::1:80`).
  const urlHost = assertSafeNvrHostForUrl(creds.ipAddress)
  const client = axios.create({
    baseURL: `http://${urlHost}:${creds.port}`,
    timeout: timeoutMs,
    headers: { Accept: 'application/xml, text/xml, */*' },
    // Anti-SSRF: no seguir 3xx (evita saltos a loopback/metadatos y el reenvío de
    // la cabecera Authorization Digest/Basic a otro origen). El reintento Digest
    // hereda esta política por reutilizar este cliente. Ver nvr-host-guard.ts.
    maxRedirects: 0,
  })
  client.interceptors.response.use(undefined, async (err) => {
    const res = err.response
    if (res?.status === 401 && !err.config._digestRetried) {
      const wwwAuth: string = res.headers['www-authenticate'] ?? ''
      if (wwwAuth.toLowerCase().startsWith('digest')) {
        err.config._digestRetried = true
        const method = (err.config.method ?? 'GET').toUpperCase()
        const url    = new URL(err.config.url ?? '/', `http://${urlHost}`)
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

// ─── Bloque <Audio> ──────────────────────────────────────────────────────────
//
// En /ISAPI/Streaming/channels/<NN><01|02> hay VARIOS <enabled>: el del CANAL
// (el primero, antes de <Transport>), los de Transport (Unicast/Multicast/
// Security), los de <Video> (y SVC/SmartCodec) y recién al final el de <Audio>.
// Leer o escribir "el primer <enabled>" informa/apaga el CANAL, no el audio.
// Por eso todo lo de audio se lee y se escribe SÓLO dentro del único bloque
// <Audio>…</Audio>, y el resto del documento queda idéntico byte a byte.

// Prefijo de namespace opcional (p.ej. <hik:Audio>); Hikvision suele usar el
// namespace por defecto, pero no cuesta nada tolerarlo. Sin distinguir mayúsculas,
// igual que xmlGet; el lookahead (?=[\s/>]) exige el nombre EXACTO (no confunde
// <Audio> con <audioInputChannelID> ni <enabled> con <enabledX>).
const XML_NS_PREFIX = '(?:[A-Za-z_][\\w.-]*:)?'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface AudioBlock {
  innerStart: number   // primer byte después de <Audio …>
  innerEnd:   number   // índice donde empieza </Audio>
}

function findAudioBlock(xml: string): { block: AudioBlock } | { error: string } {
  const opens = [...xml.matchAll(new RegExp(`<(${XML_NS_PREFIX}Audio)(?=[\\s/>])[^>]*>`, 'gi'))]
  if (opens.length === 0) return { error: 'El stream no expone un bloque <Audio>; no se aplicó ningún cambio' }
  if (opens.length > 1)   return { error: 'El stream tiene más de un bloque <Audio>; no se aplicó ningún cambio' }
  const open = opens[0]
  if (open[0].endsWith('/>')) return { error: 'El bloque <Audio> del stream está vacío; no se aplicó ningún cambio' }
  const innerStart = (open.index ?? 0) + open[0].length
  const closeRe = new RegExp(`</${escapeRegExp(open[1])}\\s*>`, 'gi')
  closeRe.lastIndex = innerStart
  const close = closeRe.exec(xml)
  if (!close) return { error: 'El bloque <Audio> del stream no está cerrado; no se aplicó ningún cambio' }
  return { block: { innerStart, innerEnd: close.index } }
}

interface AudioTag { open: string; value: string; close: string; index: number; length: number }

/** Localiza el ÚNICO <tag>valor</tag> dentro del contenido del bloque <Audio>. */
function findAudioTag(inner: string, tag: string): AudioTag | 'missing' | 'ambiguous' {
  const count = (inner.match(new RegExp(`<${XML_NS_PREFIX}${tag}(?=[\\s/>])`, 'gi')) ?? []).length
  if (count === 0) return 'missing'
  if (count > 1)   return 'ambiguous'
  // (?<!/)> descarta <tag/> autocerrado: no hay valor que reemplazar.
  const m = new RegExp(`(<(${XML_NS_PREFIX}${tag})(?:\\s[^>]*)?(?<!/)>)([^<]*)(</\\2\\s*>)`, 'i').exec(inner)
  if (!m) return 'missing'
  return { open: m[1], value: m[3], close: m[4], index: m.index, length: m[0].length }
}

function escapeXmlText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unescapeXmlText(v: string): string {
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function parseAudioBlock(xml: string): Pick<VideoStreamConfig, 'audioBlockPresent' | 'audioEnabled' | 'audioCodecType' | 'audioBitrate'> {
  const found = findAudioBlock(xml)
  // Sin bloque (o ambiguo) no se puede afirmar que haya audio ⇒ se informa apagado.
  if ('error' in found) return { audioBlockPresent: false, audioEnabled: false, audioCodecType: '', audioBitrate: 0 }
  const inner = xml.slice(found.block.innerStart, found.block.innerEnd)
  const read = (tag: string): string => {
    const t = findAudioTag(inner, tag)
    return typeof t === 'string' ? '' : unescapeXmlText(t.value.trim())
  }
  return {
    audioBlockPresent: true,
    audioEnabled:   parseBoolean(read('enabled') || '0'),
    audioCodecType: read('audioCompressionType') || read('audioCodecType') || '',
    audioBitrate:   parseInt(read('audioBitRate') || '0'),
  }
}

/**
 * Aplica los cambios de audio EXCLUSIVAMENTE dentro del bloque <Audio>. Si no hay
 * un único bloque, o falta (o se repite) el tag a modificar, devuelve error y el
 * llamador NO debe hacer el PUT: nunca se aplica a medias ni se toca otro <enabled>.
 */
function applyAudioUpdate(
  xml: string,
  update: Pick<VideoStreamUpdate, 'audioEnabled' | 'audioCodecType' | 'audioBitrate'>,
): { xml: string } | { error: string } {
  const changes: Array<{ tags: string[]; value: string }> = []
  if (update.audioEnabled !== undefined) {
    changes.push({ tags: ['enabled'], value: update.audioEnabled ? 'true' : 'false' })
  }
  if (update.audioCodecType !== undefined) {
    changes.push({ tags: ['audioCompressionType', 'audioCodecType'], value: update.audioCodecType })
  }
  if (update.audioBitrate !== undefined) {
    changes.push({ tags: ['audioBitRate'], value: String(update.audioBitrate) })
  }
  if (changes.length === 0) return { xml }

  const found = findAudioBlock(xml)
  if ('error' in found) return found
  let inner = xml.slice(found.block.innerStart, found.block.innerEnd)

  for (const { tags, value } of changes) {
    let applied = false
    for (const tag of tags) {
      const t = findAudioTag(inner, tag)
      if (t === 'missing') continue
      if (t === 'ambiguous') return { error: `El bloque <Audio> tiene más de un <${tag}>; no se aplicó ningún cambio` }
      // Conserva los espacios/saltos de línea que rodean al valor original. El valor
      // se escapa: un "codec" con </Audio> no puede salirse del bloque.
      const lead  = /^\s*/.exec(t.value)![0]
      const trail = /\s*$/.exec(t.value.slice(lead.length))![0]
      inner = inner.slice(0, t.index) + t.open + lead + escapeXmlText(value) + trail + t.close + inner.slice(t.index + t.length)
      applied = true
      break
    }
    if (!applied) return { error: `El bloque <Audio> no tiene <${tags[0]}>; no se aplicó ningún cambio` }
  }

  return { xml: xml.slice(0, found.block.innerStart) + inner + xml.slice(found.block.innerEnd) }
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

  // Audio: SÓLO desde el bloque <Audio> (el primer <enabled> del XML es el del canal).
  const audio          = parseAudioBlock(xml)
  const audioInputType = xmlGet(xml, 'audioInputType') || ''

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
    audioEnabled:    audio.audioEnabled,
    audioCodecType:  audio.audioCodecType,
    audioInputType,
    audioBitrate:    audio.audioBitrate,
    audioBlockPresent: audio.audioBlockPresent,
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
 * Código del rechazo LOCAL de un cambio de audio (no se envió ningún PUT al NVR):
 * falta el bloque <Audio>, es ambiguo, falta (o se repite) el tag, o el valor no es
 * válido (tipo, codec vacío, bitrate no entero positivo). Las rutas lo responden
 * como 422 (no es un fallo del NVR).
 */
export const AUDIO_UPDATE_REJECTED = 'AUDIO_UPDATE_REJECTED' as const

/**
 * Writes video/audio configuration to NVR for one channel and stream (main=01, sub=02).
 * Strategy:
 *   1. GET current XML from ISAPI
 *   2. Replace only the fields present in `update` using simple XML tag replacement
 *      (audio: SÓLO dentro del bloque <Audio>; si no se puede, no hay PUT)
 *   3. PUT modified XML back
 * Returns the updated config by re-reading from NVR after the write.
 */
export async function putChannelVideoConfig(
  nvrId: string,
  creds: NvrCredentials,
  channel: number,
  streamType: 'main' | 'sub',
  update: VideoStreamUpdate
): Promise<{ success: boolean; error?: string; code?: typeof AUDIO_UPDATE_REJECTED; config?: ChannelVideoConfig }> {
  // El body de PUT /nvrs/:id/video-audio/:channel no pasa por Zod: un "false"
  // (string) es truthy y encendería el audio. Se valida antes de tocar el NVR.
  // Codec vacío (o sólo espacios): es lo que manda NVRDetailPage aunque el usuario no
  // toque el audio; escribirlo dejaba <audioCompressionType></audioCompressionType>.
  // Bitrate: entero positivo (kbps); -5 o 64.5 se escribían tal cual en <audioBitRate>.
  if ((update.audioEnabled   !== undefined && typeof update.audioEnabled !== 'boolean') ||
      (update.audioCodecType !== undefined && (typeof update.audioCodecType !== 'string' || !update.audioCodecType.trim())) ||
      (update.audioBitrate   !== undefined && !(Number.isInteger(update.audioBitrate) && update.audioBitrate > 0))) {
    return {
      success: false,
      code: AUDIO_UPDATE_REJECTED,
      error: 'Valores de audio inválidos (audioEnabled booleano, audioCodecType texto no vacío, audioBitrate entero positivo); no se aplicó ningún cambio',
    }
  }
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
    // Audio: sólo dentro del bloque <Audio>. Antes se reemplazaba el PRIMER
    // <enabled> del documento, que es el del CANAL ⇒ apagar el audio deshabilitaba
    // el stream. Si el cambio no se puede aplicar ahí, no se hace el PUT.
    const audio = applyAudioUpdate(xml, update)
    if ('error' in audio) {
      return { success: false, code: AUDIO_UPDATE_REJECTED, error: audio.error }
    }
    xml = audio.xml

    // 3. PUT modified XML back
    const putRes = await client.put(endpoint, xml, {
      headers: { 'Content-Type': 'application/xml' },
    })

    if (putRes.status < 200 || putRes.status >= 300) {
      return { success: false, error: putRes.statusText }
    }

    // 4. Re-read and return the updated config to confirm values were applied
    const freshConfig = await getChannelVideoConfig(nvrId, creds, channel)
    return { success: true, config: freshConfig }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

// ─── Capabilities ─────────────────────────────────────────────────────────────

export interface StreamCapabilities {
  codecs:       string[]
  resolutions:  Array<{ width: number; height: number; label: string }>
  fpsOptions:   number[]
  bitrateRange: { min: number; max: number }
  bitrateTypes: string[]
  exists:       boolean
  editable:     boolean
  reason?:      string
}

export interface ChannelCapabilities {
  nvrId:     string
  channel:   number
  fetchedAt: string
  main:      StreamCapabilities
  sub:       StreamCapabilities
}

/** Known safe defaults when the NVR doesn't expose a /capabilities endpoint */
function defaultCapabilities(streamType: 'main' | 'sub', currentCodec?: string): StreamCapabilities {
  const isMain = streamType === 'main'
  const codecs = isMain
    ? ['H.264', 'H.265', 'H.264+', 'H.265+']
    : ['H.264', 'H.265']

  const resolutions = isMain
    ? [
        { width: 3840, height: 2160, label: '4K (3840×2160)' },
        { width: 2688, height: 1520, label: '5MP (2688×1520)' },
        { width: 2560, height: 1440, label: '4MP (2560×1440)' },
        { width: 1920, height: 1080, label: '2MP (1920×1080)' },
        { width: 1280, height: 720,  label: 'HD (1280×720)' },
        { width: 704,  height: 576,  label: 'D1 (704×576)' },
        { width: 352,  height: 288,  label: 'CIF (352×288)' },
      ]
    : [
        { width: 1280, height: 720,  label: 'HD (1280×720)' },
        { width: 704,  height: 576,  label: 'D1 (704×576)' },
        { width: 640,  height: 360,  label: '360p (640×360)' },
        { width: 352,  height: 288,  label: 'CIF (352×288)' },
        { width: 320,  height: 240,  label: 'QCIF (320×240)' },
      ]

  const fpsOptions = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 16, 20, 25, 30]

  return {
    codecs,
    resolutions,
    fpsOptions,
    bitrateRange:  { min: 32, max: 16384 },
    bitrateTypes:  ['CBR', 'VBR'],
    exists:   true,
    editable: true,
  }
}

/** Parse capabilities XML from Hikvision (StreamingChannelCapabilities or similar) */
function parseCapabilitiesXml(xml: string, streamType: 'main' | 'sub'): StreamCapabilities {
  const base = defaultCapabilities(streamType)

  // Try to extract supported codecs from capability XML
  const codecMatches = xml.match(/<videoCodecType[^>]*>([^<]+)<\/videoCodecType>/gi)
  if (codecMatches && codecMatches.length > 0) {
    const codecs = codecMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(Boolean)
    if (codecs.length > 0) base.codecs = codecs
  }

  // Try resolution list from capabilities
  const resBlocks = xml.match(/<Resolution>[^]*?<\/Resolution>/gi)
  if (resBlocks && resBlocks.length > 0) {
    const parsed = resBlocks.map(b => ({
      width:  parseInt(xmlGet(b, 'videoResolutionWidth')  || xmlGet(b, 'width')  || '0'),
      height: parseInt(xmlGet(b, 'videoResolutionHeight') || xmlGet(b, 'height') || '0'),
    })).filter(r => r.width > 0 && r.height > 0)
    if (parsed.length > 0) {
      base.resolutions = parsed.map(r => ({ ...r, label: `${r.width}×${r.height}` }))
    }
  }

  // Bitrate limits
  const bitrateMin = parseInt(xmlGet(xml, 'minBitrate') || xmlGet(xml, 'MinVideoBitRate') || '0')
  const bitrateMax = parseInt(xmlGet(xml, 'maxBitrate') || xmlGet(xml, 'MaxVideoBitRate') || '0')
  if (bitrateMin > 0 && bitrateMax > bitrateMin) {
    base.bitrateRange = { min: bitrateMin, max: bitrateMax }
  }

  return base
}

/**
 * Query NVR for channel stream capabilities.
 * Falls back to safe defaults when the firmware doesn't expose the capabilities endpoint.
 */
export async function getChannelCapabilities(
  nvrId: string,
  creds: NvrCredentials,
  channel: number,
): Promise<ChannelCapabilities> {
  const client = makeClient(creds)
  const ch = String(channel).padStart(2, '0')

  // Read current config to know what exists and current codec
  const current = await getChannelVideoConfig(nvrId, creds, channel)

  const mainCaps = await (async (): Promise<StreamCapabilities> => {
    try {
      const res = await client.get<string>(`/ISAPI/Streaming/channels/${ch}01/capabilities`)
      const xml = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      return parseCapabilitiesXml(xml, 'main')
    } catch {
      // Firmware doesn't expose capabilities — return safe defaults based on current config
      return defaultCapabilities('main', current.main?.videoCodecType)
    }
  })()

  const subCaps = await (async (): Promise<StreamCapabilities> => {
    if (!current.sub) {
      return { ...defaultCapabilities('sub'), exists: false, editable: false, reason: 'Sub-stream no disponible en este canal' }
    }
    try {
      const res = await client.get<string>(`/ISAPI/Streaming/channels/${ch}02/capabilities`)
      const xml = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      return parseCapabilitiesXml(xml, 'sub')
    } catch {
      return defaultCapabilities('sub', current.sub?.videoCodecType)
    }
  })()

  return {
    nvrId,
    channel,
    fetchedAt: new Date().toISOString(),
    main: mainCaps,
    sub:  subCaps,
  }
}
