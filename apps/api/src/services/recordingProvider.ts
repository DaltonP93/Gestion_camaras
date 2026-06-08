// services/recordingProvider.ts
import http from 'http'
import https from 'https'
import crypto from 'crypto'

export type RecordingProviderType = 'ISAPI' | 'HIKVISION_SDK' | 'MEDIAMTX_LOCAL' | 'MANUAL_NVR' | 'UNSUPPORTED'
export type RecordingCheckErrorCode =
  | 'AUTH_FAILED'
  | 'UNSUPPORTED_MODEL'
  | 'INVALID_REQUEST'
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'

interface NvrCreds { ipAddress: string; port: number; username: string; password: string }

export interface CheckResult {
  supported: boolean
  error?: string
  errorCode?: RecordingCheckErrorCode
  /** Raw response body from the NVR (for diagnostics) */
  responseBody?: string
  /** HTTP status returned by NVR */
  httpStatus?: number
  /** XML sent to NVR (credentials stripped) */
  requestXml?: string
  /** Track ID used in the request */
  trackId?: number
}

const ISAPI_PATH = '/ISAPI/ContentMgmt/search'

/** Build capability-check XML for track 101 (D1 always present).
 *  Uses proper spelling "searchResultPosition" and the Hikvision namespace.
 */
export function buildIsapiSearchXml(opts: {
  trackId: number
  startTime: Date
  endTime: Date
  maxResults?: number
  searchId?: string
}): string {
  const { trackId, startTime, endTime, maxResults = 1, searchId = crypto.randomUUID() } = opts
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <searchID>${searchId}</searchID>
  <trackList>
    <trackID>${trackId}</trackID>
  </trackList>
  <timeSpanList>
    <timeSpan>
      <startTime>${fmt(startTime)}</startTime>
      <endTime>${fmt(endTime)}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>${maxResults}</maxResults>
  <searchResultPosition>0</searchResultPosition>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>`
}

// Track IDs to probe in order — covers channels D1..D4; stops at first non-400 response.
const PROBE_TRACK_IDS = [101, 201, 301, 401]

function buildBody(trackId = 101): string {
  const now   = new Date()
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) // 7 days — maximises hit chance
  return buildIsapiSearchXml({ trackId, startTime: start, endTime: now, maxResults: 1 })
}

function buildDigestHeader(wwwAuth: string, username: string, password: string, method: string, uri: string): string {
  const realm  = (wwwAuth.match(/realm="([^"]+)"/)  ?? [])[1] ?? ''
  const nonce  = (wwwAuth.match(/nonce="([^"]+)"/)  ?? [])[1] ?? ''
  const qop    = (wwwAuth.match(/qop="?([^",\s]+)"?/) ?? [])[1]
  const nc     = '00000001'
  const cnonce = crypto.randomBytes(8).toString('hex')
  const ha1    = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex')
  const ha2    = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex')
  const response = qop
    ? crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex')
    : crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex')
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  return header
}

interface RequestResult {
  code: number
  wwwAuth?: string
  body: string
}

function doRequest(creds: NvrCreds, authHeader: string, body: string): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const useHttps = creds.port === 443
    const options = {
      hostname: creds.ipAddress,
      port:     creds.port || 80,
      path:     ISAPI_PATH,
      method:   'POST',
      headers: {
        'Content-Type':   'application/xml',
        'Authorization':  authHeader,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }
    const req = (useHttps ? https : http).request(options, (res) => {
      const code    = res.statusCode ?? 0
      const wwwRaw  = res.headers['www-authenticate']
      const wwwAuth = Array.isArray(wwwRaw) ? wwwRaw[0] : wwwRaw
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ code, wwwAuth, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

/** Classify a non-2xx HTTP status into an error code.
 *  400 is INVALID_REQUEST (bad XML), not UNSUPPORTED_MODEL.
 *  404/405/501 are UNSUPPORTED_MODEL.
 */
function classifyHttpError(code: number, responseBody: string): { error: string; errorCode: RecordingCheckErrorCode } {
  if (code === 401) return { error: 'Credenciales inválidas (HTTP 401)', errorCode: 'AUTH_FAILED' }
  if (code === 403) return { error: 'Credenciales válidas pero sin permiso ISAPI (HTTP 403)', errorCode: 'AUTH_FAILED' }
  if (code === 400) {
    // Extract NVR's own error message if present
    const nvrMsg = extractResponseStatus(responseBody)
    return {
      error: nvrMsg
        ? `XML inválido o parámetros incorrectos (HTTP 400): ${nvrMsg}`
        : `XML inválido o parámetros incorrectos (HTTP 400)`,
      errorCode: 'INVALID_REQUEST',
    }
  }
  if (code === 404 || code === 405 || code === 501) {
    return { error: `Endpoint ISAPI no disponible (HTTP ${code})`, errorCode: 'UNSUPPORTED_MODEL' }
  }
  return { error: `ISAPI no disponible (HTTP ${code})`, errorCode: 'UNSUPPORTED_MODEL' }
}

/** Extract statusString / statusCode from Hikvision XML response body */
function extractResponseStatus(body: string): string {
  if (!body) return ''
  const statusCode = body.match(/<statusCode>(\d+)<\/statusCode>/)?.[1]
  const statusStr  = body.match(/<statusString>([^<]*)<\/statusString>/)?.[1]
  const subStatus  = body.match(/<subStatusCode>([^<]*)<\/subStatusCode>/)?.[1]
  const parts: string[] = []
  if (statusCode) parts.push(`statusCode=${statusCode}`)
  if (statusStr)  parts.push(statusStr)
  if (subStatus)  parts.push(`sub=${subStatus}`)
  return parts.join(' — ')
}

/** Send one probed request (with Basic or resolved-Digest auth) and return the result. */
async function probeOnce(
  creds: NvrCreds,
  trackId: number,
): Promise<RequestResult & { requestXml: string; trackId: number; resolvedAuth: string }> {
  const xml   = buildBody(trackId)
  const basic = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`

  const r1 = await doRequest(creds, basic, xml)
  if (r1.code === 401 && r1.wwwAuth?.toLowerCase().includes('digest')) {
    const digestHeader = buildDigestHeader(r1.wwwAuth!, creds.username, creds.password, 'POST', ISAPI_PATH)
    const r2 = await doRequest(creds, digestHeader, xml)
    return { ...r2, requestXml: xml, trackId, resolvedAuth: 'digest' }
  }
  return { ...r1, requestXml: xml, trackId, resolvedAuth: 'basic' }
}

export async function checkIsapiRecordingSupport(creds: NvrCreds): Promise<CheckResult> {
  try {
    // Probe multiple channels so a single empty channel (400) doesn't block detection.
    // Stop as soon as a non-400 response is received.
    let lastResult: RequestResult & { requestXml: string; trackId: number } | null = null

    for (const tid of PROBE_TRACK_IDS) {
      const r = await probeOnce(creds, tid)
      lastResult = r

      if (r.code >= 200 && r.code < 300) {
        return { supported: true, httpStatus: r.code, responseBody: r.body, requestXml: r.requestXml, trackId: tid }
      }
      // Auth errors and real "unsupported" — stop immediately, no point probing more channels
      if (r.code === 401 || r.code === 403 || r.code === 404 || r.code === 405 || r.code === 501) {
        break
      }
      // 400 — this channel may not exist; continue to next channel
    }

    if (!lastResult) {
      return { supported: false, error: 'Sin respuesta del NVR', errorCode: 'NETWORK_ERROR' }
    }

    const classified = classifyHttpError(lastResult.code, lastResult.body)
    return {
      supported: false,
      ...classified,
      httpStatus: lastResult.code,
      responseBody: lastResult.body,
      requestXml: lastResult.requestXml,
      trackId: lastResult.trackId,
    }
  } catch (e: any) {
    if (e.message === 'timeout') {
      return { supported: false, error: 'Timeout al conectar con el NVR', errorCode: 'NETWORK_TIMEOUT' }
    }
    return { supported: false, error: e.message ?? 'Error de red', errorCode: 'NETWORK_ERROR' }
  }
}

export function detectProviderFromCapabilities(supportsIsapi: boolean): RecordingProviderType {
  return supportsIsapi ? 'ISAPI' : 'MANUAL_NVR'
}
