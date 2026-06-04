// services/recordingProvider.ts
import http from 'http'
import https from 'https'

export type RecordingProviderType = 'ISAPI' | 'HIKVISION_SDK' | 'MEDIAMTX_LOCAL' | 'MANUAL_NVR' | 'UNSUPPORTED'

interface NvrCreds { ipAddress: string; port: number; username: string; password: string }

export async function checkIsapiRecordingSupport(creds: NvrCreds): Promise<{ supported: boolean; error?: string }> {
  const now = new Date()
  const start = new Date(now.getTime() - 5000).toISOString().replace('T', 'T').slice(0, 19)
  const end   = now.toISOString().slice(0, 19)

  const body = `<CMSearchDescription><searchID>1</searchID><timeSpanList><timeSpan><startTime>${start}</startTime><endTime>${end}</endTime></timeSpan></timeSpanList><maxResults>1</maxResults><searchResultPosition>0</searchResultPosition></CMSearchDescription>`

  return new Promise((resolve) => {
    const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
    const options = {
      hostname: creds.ipAddress,
      port: creds.port || 80,
      path: '/ISAPI/ContentMgmt/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }

    const req = (creds.port === 443 ? https : http).request(options, (res) => {
      const code = res.statusCode ?? 0
      if (code === 401 || code === 403) {
        resolve({ supported: false, error: `Auth failed: HTTP ${code}` })
      } else if (code >= 200 && code < 500) {
        resolve({ supported: true })
      } else {
        resolve({ supported: false, error: `HTTP ${code}` })
      }
      res.resume()
    })

    req.on('error', (e) => resolve({ supported: false, error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ supported: false, error: 'timeout' }) })
    req.write(body)
    req.end()
  })
}

export function detectProviderFromCapabilities(supportsIsapi: boolean): RecordingProviderType {
  return supportsIsapi ? 'ISAPI' : 'MANUAL_NVR'
}
