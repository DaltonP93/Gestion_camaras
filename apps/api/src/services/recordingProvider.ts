// apps/api/src/services/recordingProvider.ts
import axios from 'axios'
import crypto from 'crypto'
import type { NvrCredentials } from './nvr-config/hikvision'

export type RecordingProviderType =
  | 'ISAPI'
  | 'HIKVISION_SDK'
  | 'MEDIAMTX_LOCAL'
  | 'MANUAL_NVR'
  | 'UNSUPPORTED'

// ─── Digest auth helper ───────────────────────────────────────

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

/**
 * Check if an NVR supports ISAPI recording search.
 *
 * Strategy:
 *   - POST /ISAPI/ContentMgmt/search with a minimal 5-second window
 *   - HTTP 200 or 400 (even bad request) → supported
 *   - HTTP 401 or 403                    → auth_error
 *   - Any other 4xx or network error     → unsupported
 *
 * Returns { supported: boolean, error?: string }
 */
export async function checkIsapiRecordingSupport(
  creds: NvrCredentials
): Promise<{ supported: boolean; error?: string }> {
  const { ipAddress, port, username, password } = creds
  const uri = '/ISAPI/ContentMgmt/search'
  const baseUrl = `http://${ipAddress}:${port}`

  // Dummy search body: 5-second window starting now
  const now   = new Date()
  const end   = new Date(now.getTime() + 5000)
  const fmt   = (d: Date) =>
    d.toISOString().replace('T', 'T').replace(/\.\d{3}Z$/, 'Z')
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>00000000-0000-0000-0000-000000000001</searchID>
  <trackList>
    <trackID>101</trackID>
  </trackList>
  <timeSpanList>
    <timeSpan>
      <startTime>${fmt(now)}</startTime>
      <endTime>${fmt(end)}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>1</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>`

  const client = axios.create({
    baseURL: baseUrl,
    timeout: 12000,
    validateStatus: () => true,   // never throw on HTTP error
  })

  // First attempt (no auth)
  let res = await client.post(uri, body, {
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml, text/xml, */*' },
  }).catch((err: any) => {
    return { status: 0, headers: {}, _networkError: err?.message ?? 'network_error' } as any
  })

  // Network error → unsupported
  if (res.status === 0) {
    return { supported: false, error: `Network error: ${res._networkError}` }
  }

  // Need Digest auth
  if (res.status === 401) {
    const wwwAuth: string = res.headers?.['www-authenticate'] ?? ''
    if (wwwAuth.toLowerCase().startsWith('digest')) {
      const authHeader = buildDigest(username, password, 'POST', uri, wwwAuth)
      res = await client.post(uri, body, {
        headers: {
          'Content-Type': 'application/xml',
          Accept: 'application/xml, text/xml, */*',
          Authorization: authHeader,
        },
      }).catch((err: any) => {
        return { status: 0, _networkError: err?.message ?? 'network_error' } as any
      })
    } else {
      // Basic auth fallback
      res = await client.post(uri, body, {
        auth: { username, password },
        headers: { 'Content-Type': 'application/xml', Accept: 'application/xml, text/xml, */*' },
      }).catch((err: any) => {
        return { status: 0, _networkError: err?.message ?? 'network_error' } as any
      })
    }
  }

  if (res.status === 0) {
    return { supported: false, error: `Network error after auth: ${res._networkError}` }
  }

  const status = res.status as number

  // 200 or 400 (bad request) → endpoint exists, supported
  if (status === 200 || status === 400) {
    return { supported: true }
  }

  // Auth errors → report specifically
  if (status === 401 || status === 403) {
    return { supported: false, error: `auth_error: HTTP ${status}` }
  }

  // Any other 4xx or 5xx → not supported by this NVR
  return { supported: false, error: `HTTP ${status}` }
}

/**
 * Derive a recording provider from ISAPI capability.
 *
 * - true  → ISAPI (confirmed working)
 * - false → MANUAL_NVR (not supported, manual access required)
 * - null  → MANUAL_NVR (unchecked / unknown)
 */
export function detectProviderFromCapabilities(
  supportsIsapi: boolean | null
): RecordingProviderType {
  if (supportsIsapi === true) return 'ISAPI'
  return 'MANUAL_NVR'
}
