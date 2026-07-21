// Salud de canal POR CÁMARA a partir de ISAPI InputProxy — lógica PURA y testeable.
//
// PROBLEMA que resuelve: getNVRChannels() (VideoInput) marca online=true para todo
// canal que aparezca en /ISAPI/System/Video/inputs/channels, así una IP-cam
// físicamente desconectada seguía "online" y nunca se generaba CAMERA_OFFLINE. La
// señal fiable vive en InputProxy (online / chanDetectResult). Este módulo parsea
// esa señal SIN pegarle a la red (los parsers reciben el XML/JSON ya capturado),
// para poder cubrirla con fixtures. La parte de red vive en hikvision.ts.

export type ChannelHealthStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN'

export interface NvrChannelHealth {
  channel: number
  status: ChannelHealthStatus
  source: string
  onlineRaw?: string
  chanDetectResult?: string
  passwordStatus?: string
  ipAddress?: string
  checkedAt: Date
}

// Entrada sin timestamp (el parser es determinista; checkedAt lo pone el caller).
export type NvrChannelHealthParsed = Omit<NvrChannelHealth, 'checkedAt'>

// ── xmlGet/xmlGetAll autocontenidos (copia mínima de hikvision.ts, sin depender
//    de sus internos privados — así el módulo es puro y testeable aislado) ──────
function xmlGet(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<([A-Za-z0-9_:-]*${tag})\\b[^>]*>([^<]*)</\\1>`))
  return m ? m[2].trim() : ''
}
function xmlGetAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<([A-Za-z0-9_:-]*${tag})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[2])
  return out
}

/**
 * Mapea la señal cruda de InputProxy a ONLINE/OFFLINE/UNKNOWN. Reglas (spec):
 *  - online=true  | chanDetectResult=online                     => ONLINE
 *  - online=false                                               => OFFLINE
 *  - chanDetectResult=offline|channelErr|error                  => OFFLINE
 *  - ausente / no reconocido                                    => UNKNOWN
 * UNKNOWN NUNCA debe marcar una cámara como offline (lo respeta el debounce).
 */
export function mapOnlineToStatus(onlineRaw?: string, chanDetect?: string): ChannelHealthStatus {
  const o = (onlineRaw || '').toLowerCase().trim()
  if (o === 'true' || o === '1' || o === 'yes' || o === 'online') return 'ONLINE'
  if (o === 'false' || o === '0' || o === 'no' || o === 'offline') return 'OFFLINE'
  const c = (chanDetect || '').toLowerCase().trim()
  if (c === 'online') return 'ONLINE'
  if (c === 'offline' || c === 'channelerr' || c === 'error') return 'OFFLINE'
  return 'UNKNOWN'
}

/**
 * Parsea el cuerpo de /ISAPI/ContentMgmt/InputProxy/channels/status (o /channels)
 * y devuelve la salud por canal. Prioriza los bloques InputProxyChannelStatus
 * (traen online/chanDetectResult), y si no, InputProxyChannel. Un cuerpo no
 * reconocido devuelve [] → el caller lo trata como UNKNOWN (nunca offline).
 */
export function parseChannelHealthXml(body: string, source: string): NvrChannelHealthParsed[] {
  const out: NvrChannelHealthParsed[] = []
  const trimmed = (body || '').trimStart()
  if (!trimmed.startsWith('<')) {
    // Intentar JSON (algunos firmwares mandan JSON con content-type xml y viceversa).
    try {
      const data = JSON.parse(body)
      const raw = data?.InputProxyChannelStatusList?.InputProxyChannelStatus
        ?? data?.InputProxyChannelList?.InputProxyChannel
      if (raw) {
        const list = Array.isArray(raw) ? raw : [raw]
        for (const item of list) {
          const ch = parseInt(item.id || item.channelNo || '0', 10)
          if (!ch) continue
          const onlineRaw = item.online != null ? String(item.online) : undefined
          const chanDetect = item.chanDetectResult != null ? String(item.chanDetectResult) : undefined
          const pwd = item.SecurityStatus?.PasswordStatus || item.PasswordStatus || undefined
          const src = item.sourceInputPortDescriptor || {}
          out.push({
            channel: ch,
            status: mapOnlineToStatus(onlineRaw, chanDetect),
            source, onlineRaw, chanDetectResult: chanDetect, passwordStatus: pwd,
            ipAddress: src.ipAddress || item.ipAddress || undefined,
          })
        }
      }
    } catch { /* no es JSON → sin datos */ }
    return out
  }

  const blocks = xmlGetAll(body, 'InputProxyChannelStatus')
  const useStatus = blocks.length > 0
  const chosen = useStatus ? blocks : xmlGetAll(body, 'InputProxyChannel')
  for (const block of chosen) {
    const ch = parseInt(xmlGet(block, 'id') || xmlGet(block, 'channelNo') || '0', 10)
    if (!ch) continue
    const onlineRaw  = xmlGet(block, 'online') || undefined
    const chanDetect = xmlGet(block, 'chanDetectResult') || undefined
    const pwdStatus  = xmlGet(block, 'PasswordStatus') || undefined
    const ipAddress  = xmlGet(block, 'ipAddress') || undefined
    out.push({
      channel: ch,
      status: mapOnlineToStatus(onlineRaw, chanDetect),
      source: useStatus ? `${source}:status_block` : `${source}:channel_block`,
      onlineRaw, chanDetectResult: chanDetect, passwordStatus: pwdStatus, ipAddress,
    })
  }
  return out
}
