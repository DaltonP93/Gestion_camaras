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
    const res = await axios.post<{ accessToken: string }>(
      `${BASE_URL}/api/auth/refresh`,
      { refreshToken }
    )
    // Preserve whichever storage the refresh token came from
    if (localStorage.getItem('refreshToken')) {
      localStorage.setItem('accessToken', res.data.accessToken)
    } else {
      sessionStorage.setItem('accessToken', res.data.accessToken)
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

    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/refresh')
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
export const apiGet = <T>(url: string, params?: object) =>
  api.get<T>(url, { params }).then((r) => r.data)

export const apiPost = <T>(url: string, data?: object) =>
  api.post<T>(url, data).then((r) => r.data)

export const apiPut = <T>(url: string, data?: object) =>
  api.put<T>(url, data).then((r) => r.data)

export const apiPatch = <T>(url: string, data?: object) =>
  api.patch<T>(url, data).then((r) => r.data)

export const apiDelete = <T>(url: string, data?: unknown) =>
  api.delete<T>(url, data !== undefined ? { data } : undefined).then((r) => r.data)

export const apiUpload = <T>(url: string, formData: FormData) =>
  api.post<T>(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => r.data)
