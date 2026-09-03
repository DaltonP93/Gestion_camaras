// src/lib/api.ts
import axios from 'axios'
import type { AxiosError } from 'axios'
import toast from 'react-hot-toast'

const BASE_URL = import.meta.env.VITE_API_URL || ''

export const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

// ─── Request interceptor: inyectar token desde localStorage/sessionStorage ──
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ─── Refresh mutex: evita múltiples refreshes en paralelo ────
let refreshPromise: Promise<void> | null = null

async function refreshAccessToken(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const refreshToken = localStorage.getItem('refreshToken') || sessionStorage.getItem('refreshToken')
    if (!refreshToken) throw new Error('No refresh token')
    try {
      const res = await axios.post<{ accessToken: string; refreshToken?: string }>(
        `${BASE_URL}/api/auth/refresh`,
        { refreshToken }
      )
      // Preserve whichever storage the refresh token came from. El backend ahora ROTA el
      // refresh token en cada refresh (fase 4c): hay que persistir el nuevo, o el próximo
      // refresh presentaría un token ya rotado y se detectaría como reutilización.
      const store = localStorage.getItem('refreshToken') ? localStorage : sessionStorage
      store.setItem('accessToken', res.data.accessToken)
      if (res.data.refreshToken) store.setItem('refreshToken', res.data.refreshToken)
    } catch (err: any) {
      // TOKEN_ROTATED: otra pestaña refrescó concurrentemente y ya dejó un accessToken
      // fresco en el storage compartido. No cerramos sesión: reutilizamos ese token.
      if (err?.response?.data?.code === 'TOKEN_ROTATED') {
        const fresh = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')
        if (fresh) return
      }
      throw err
    }
  })().finally(() => { refreshPromise = null })
  return refreshPromise
}

// ─── Señal de sesión expirada ─────────────────────────────────
export function dispatchAuthExpired() {
  window.dispatchEvent(new CustomEvent('visioncore:auth-expired'))
}

// ─── Deduplicación de toasts de error ─────────────────────────
// Sin esto, una tormenta de requests fallidas (varias cámaras + heartbeat +
// polling de analytics) genera decenas de toasts idénticos. Se muestra como
// máximo un toast equivalente (mismo status+mensaje) cada TOAST_DEDUP_MS.
const TOAST_DEDUP_MS = 30_000
const lastToastAt = new Map<string, number>()

function errorToastOnce(key: string, message: string) {
  const now = Date.now()
  const prev = lastToastAt.get(key) ?? 0
  if (now - prev < TOAST_DEDUP_MS) return
  lastToastAt.set(key, now)
  // Limitar el tamaño del mapa (defensivo — claves acotadas por status+msg)
  if (lastToastAt.size > 100) {
    for (const [k, t] of lastToastAt.entries()) {
      if (now - t > TOAST_DEDUP_MS) lastToastAt.delete(k)
    }
  }
  toast.error(message, { id: key })
}

// Retry-After en segundos (o backoff por defecto) — usado por callers que
// deciden reintentar (heartbeat de live view, polling). Se expone en el error.
export function getRetryAfterMs(error: AxiosError, fallbackMs = 10_000): number {
  const h = error.response?.headers?.['retry-after']
  const sec = h ? Number(h) : NaN
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : fallbackMs
}

// ─── Response interceptor: manejo de errores y refresh ───────
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ message?: string }>) => {
    const originalRequest = error.config as any
    const url = originalRequest?.url || ''

    // /auth/step-up gestiona su propio 401 (código incorrecto): NO debe disparar un
    // refresh + reintento, que duplicaría el intento fallido y gastaría 2 slots del
    // rate-limit por cada verificación errónea.
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/refresh') || url.includes('/auth/step-up')
    // Estos endpoints manejan sus propios errores — no mostrar toast global
    const isSilentEndpoint = url.includes('/nvrs/test-connection') || url.includes('/nvrs/detect') || url.includes('/alerts/settings/test-email')
    // /auth/me se llama en cada recarga de página — un 500/error de red no debe mostrar
    // toast porque el usuario ya tiene sesión activa y es un error interno del servidor.
    // /recordings/preview maneja sus errores por slot — sin toast global
    // (pero mantiene el refresh de token en 401, por eso no va en isSilentEndpoint).
    const isToastSuppressed = isSilentEndpoint || url.includes('/auth/me') || url.includes('/recordings/preview')

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint && !isSilentEndpoint) {
      originalRequest._retry = true
      try {
        await refreshAccessToken()
        const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')
        if (token) originalRequest.headers.Authorization = `Bearer ${token}`
        return api(originalRequest)
      } catch {
        localStorage.removeItem('accessToken')
        localStorage.removeItem('refreshToken')
        sessionStorage.removeItem('accessToken')
        sessionStorage.removeItem('refreshToken')
        dispatchAuthExpired()
        return Promise.reject(error)
      }
    }

    const status = error.response?.status
    // 429 en endpoints de streaming/polling: el caller aplica backoff con
    // Retry-After; no mostrar toast (o a lo sumo uno deduplicado) para no inundar.
    const isStreamLimit = url.includes('/start-stream') || url.includes('/live-view') || url.includes('/analytics')
    const suppress429 = status === 429 && (isAuthEndpoint || isStreamLimit)

    if (status !== 401 && !suppress429 && !isToastSuppressed) {
      const msg = error.response?.data?.message || 'Error de conexión'
      // Clave de deduplicación: status + mensaje (los toasts idénticos se colapsan)
      errorToastOnce(`${status ?? 'net'}:${msg}`, msg)
    }

    return Promise.reject(error)
  }
)

// ─── Asset URL resolver ───────────────────────────────────────
// Converts relative paths (/uploads/...) to full origin URLs.
// Converts any legacy http://localhost:PORT/... URL to the current origin,
// regardless of whether the current page is HTTPS or HTTP.
export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null
  // Relative path — prepend current origin
  if (url.startsWith('/')) return `${window.location.origin}${url}`
  // Absolute localhost URL (any protocol, any port) → rewrite to current origin
  if (/^https?:\/\/localhost(:\d+)?/.test(url)) {
    const path = url.replace(/^https?:\/\/localhost(:\d+)?/, '')
    return `${window.location.origin}${path}`
  }
  return url
}

// ─── Helpers tipados ──────────────────────────────────────────
export const apiGet = <T>(url: string, params?: object, headers?: Record<string, string>) =>
  api.get<T>(url, { params, ...(headers ? { headers } : {}) }).then((r) => r.data)

// `signal` es opcional y aditivo: los llamadores existentes no cambian. Lo usa
// el heartbeat de vista en vivo para cancelar una solicitud cuando la pestaña
// se oculta — y, como el interceptor reintenta con la MISMA config tras renovar
// el JWT, ese reintento hereda la señal y también queda cancelado.
export const apiPost = <T>(
  url: string,
  data?: object,
  headers?: Record<string, string>,
  signal?: AbortSignal,
) =>
  api.post<T>(url, data, {
    ...(headers ? { headers } : {}),
    ...(signal ? { signal } : {}),
  }).then((r) => r.data)

export const apiPut = <T>(url: string, data?: object, headers?: Record<string, string>) =>
  api.put<T>(url, data, headers ? { headers } : undefined).then((r) => r.data)

export const apiPatch = <T>(url: string, data?: object) =>
  api.patch<T>(url, data).then((r) => r.data)

export const apiDelete = <T>(url: string, data?: unknown, headers?: Record<string, string>) =>
  api.delete<T>(url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers ? { headers } : {}),
  }).then((r) => r.data)

export const apiUpload = <T>(url: string, formData: FormData) =>
  api.post<T>(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data)

// ─── Integraciones: estado de flags (ONVIF / Hik-Connect) ─────
// SIEMPRE disponible (la ruta backend no es condicional a flags): devuelve
// { onvif:{enabled}, hikConnect:{enabled} } para que la UI muestre el estado.
import type {
  IntegrationsStatus,
  OnvifCredentials,
  OnvifDiscoveredDevice,
  OnvifDeviceInformation,
  OnvifProfile,
  OnvifPtzConfiguration,
  OnvifImagingSettings,
  OnvifImagingInput,
  OnvifPtzVector,
  HikConnectTokenStatus,
  HikConnectHlsRequest,
  HikConnectHlsResponse,
  HikConnectIsapiRequest,
  HikConnectIsapiResponse,
} from '@/types'

export const integrationsApi = {
  getStatus: () => apiGet<IntegrationsStatus>('/integrations/status'),
}

// ─── ONVIF (ADMIN-only en el backend; rutas existen sólo con ONVIF_ENABLED) ──
// Todas las credenciales del dispositivo viajan en el body (`creds`) y NUNCA se
// persisten ni loguean en el cliente. La URI RTSP de getStreamUri se devuelve
// para mostrarse transitoriamente en la UI admin; el cliente no la almacena.
export const onvifApi = {
  discover: () => apiPost<{ devices: OnvifDiscoveredDevice[] }>('/onvif/discover'),

  deviceInformation: (deviceUrl: string, creds: OnvifCredentials) =>
    apiPost<OnvifDeviceInformation>('/onvif/device-information', { deviceUrl, creds }),

  profiles: (deviceUrl: string, creds: OnvifCredentials) =>
    apiPost<{ profiles: OnvifProfile[] }>('/onvif/profiles', { deviceUrl, creds }),

  streamUri: (deviceUrl: string, creds: OnvifCredentials, profileToken: string) =>
    apiPost<{ uri: string }>('/onvif/stream-uri', { deviceUrl, creds, profileToken }),

  ptzConfigurations: (deviceUrl: string, creds: OnvifCredentials) =>
    apiPost<{ configurations: OnvifPtzConfiguration[] }>('/onvif/ptz/configurations', { deviceUrl, creds }),

  ptzMove: (deviceUrl: string, creds: OnvifCredentials, profileToken: string, velocity: OnvifPtzVector) =>
    apiPost<{ ok: true }>('/onvif/ptz/move', { deviceUrl, creds, profileToken, velocity }),

  ptzStop: (deviceUrl: string, creds: OnvifCredentials, profileToken: string) =>
    apiPost<{ ok: true }>('/onvif/ptz/stop', { deviceUrl, creds, profileToken }),

  imagingGet: (deviceUrl: string, creds: OnvifCredentials, videoSourceToken: string) =>
    apiPost<{ settings: OnvifImagingSettings }>('/onvif/imaging/get', { deviceUrl, creds, videoSourceToken }),

  imagingSet: (deviceUrl: string, creds: OnvifCredentials, videoSourceToken: string, settings: OnvifImagingInput) =>
    apiPost<{ ok: true }>('/onvif/imaging/set', { deviceUrl, creds, videoSourceToken, settings }),
}

// ─── Hik-Connect (ADMIN-only; rutas existen sólo con HIK_CONNECT_ENABLED) ────
// AppKey/SecretKey viven SÓLO en el servidor (env): jamás se piden ni viajan
// desde el cliente. `tokenStatus` devuelve METADATOS (areaDomain + expiración),
// nunca el accessToken crudo. La URL HLS y la respuesta ISAPI son transitorias:
// el cliente no las persiste ni loguea.
export const hikConnectApi = {
  tokenStatus: () => apiPost<HikConnectTokenStatus>('/hik-connect/token'),

  getHls: ({ deviceSerial, channelNo }: HikConnectHlsRequest) =>
    apiPost<HikConnectHlsResponse>('/hik-connect/hls', {
      deviceSerial,
      ...(channelNo !== undefined ? { channelNo } : {}),
    }),

  proxyIsapi: ({ deviceSerial, method, isapiPath, body }: HikConnectIsapiRequest) =>
    apiPost<HikConnectIsapiResponse>('/hik-connect/isapi', {
      deviceSerial,
      method,
      isapiPath,
      ...(body !== undefined ? { body } : {}),
    }),
}
