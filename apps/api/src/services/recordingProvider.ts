// services/recordingProvider.ts
import http from 'http'
import https from 'https'
import crypto from 'crypto'

export type RecordingProviderType = 'ISAPI' | 'HIKVISION_SDK' | 'MEDIAMTX_LOCAL' | 'MANUAL_NVR' | 'UNSUPPORTED'
export type RecordingCheckErrorCode = 'AUTH_FAILED' | 'UNSUPPORTED_MODEL' | 'NETWORK_TIMEOUT' | 'NETWORK_ERROR' | 'PARSE_ERROR'

interface NvrCreds { ipAddress: string; port: number; username: string; password: string }

interface CheckResult {
  supported: boolean
  error?: string
  errorCode?: RecordingCheckErrorCode
}

const ISAPI_PATH = '/ISAPI/ContentMgmt/search'

function buildBody(): string {
  const now   = new Date()
  const start = new Date(now.getTime() - 5000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const end   = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription><searchID>1</searchID><trackList><trackID>101</trackID></trackList><timeSpanList><timeSpan><startTime>${start}</startTime><endTime>${end}</endTime></timeSpan></timeSpanList><maxResults>1</maxResults><searchResultPostion>0</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`
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

function doRequest(creds: NvrCreds, authHeader: string, body: string): Promise<{ code: number; wwwAuth?: string }> {
  return new Promise((resolve, reject) => {
    const useHttps = creds.port === 443
    const options = {
      hostname: creds.ipAddress,
      port: creds.port || 80,
      path: ISAPI_PATH,
      method: 'POST',
      headers: {
        'Content-Type':   'application/xml',
        'Authorization':  authHeader,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }
    const req = (useHttps ? https : http).request(options, (res) => {
      const code     = res.statusCode ?? 0
      const wwwRaw   = res.headers['www-authenticate']
      const wwwAuth  = Array.isArray(wwwRaw) ? wwwRaw[0] : wwwRaw
      res.resume()
      resolve({ code, wwwAuth })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

export async function checkIsapiRecordingSupport(creds: NvrCreds): Promise<CheckResult> {
  const body  = buildBody()
  const basic = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`

  try {
    // Attempt 1: Basic auth
    const r1 = await doRequest(creds, basic, body)

    if (r1.code >= 200 && r1.code < 400) {
      return { supported: true }
    }

    // Hikvision returns 401 + Digest challenge — retry with Digest
    if (r1.code === 401 && r1.wwwAuth?.toLowerCase().includes('digest')) {
      const digestHeader = buildDigestHeader(r1.wwwAuth!, creds.username, creds.password, 'POST', ISAPI_PATH)
      const r2 = await doRequest(creds, digestHeader, body)

      if (r2.code >= 200 && r2.code < 400) {
        return { supported: true }
      }
      if (r2.code === 403) {
        return { supported: false, error: 'Credenciales válidas pero sin permiso ISAPI (HTTP 403)', errorCode: 'AUTH_FAILED' }
      }
      if (r2.code === 401) {
        return { supported: false, error: 'Credenciales inválidas (HTTP 401)', errorCode: 'AUTH_FAILED' }
      }
      return { supported: false, error: `ISAPI no disponible (HTTP ${r2.code})`, errorCode: 'UNSUPPORTED_MODEL' }
    }

    if (r1.code === 403) {
      return { supported: false, error: 'Credenciales válidas pero sin permiso ISAPI (HTTP 403)', errorCode: 'AUTH_FAILED' }
    }
    if (r1.code === 401) {
      return { supported: false, error: 'Credenciales inválidas (HTTP 401)', errorCode: 'AUTH_FAILED' }
    }

    if (r1.code >= 400 && r1.code < 600) {
      return { supported: false, error: `ISAPI no disponible (HTTP ${r1.code})`, errorCode: 'UNSUPPORTED_MODEL' }
    }

    return { supported: false, error: `HTTP ${r1.code}`, errorCode: 'UNSUPPORTED_MODEL' }
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
