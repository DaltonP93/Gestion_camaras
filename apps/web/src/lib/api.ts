// src/lib/api.ts
import axios from 'axios'
import type { AxiosError } from 'axios'
import toast from 'react-hot-toast'

const BASE_URL = import.meta.env.VITE_API_URL || ''

export const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

// ─── Refresh mutex: evita múltiples refreshes en paralelo ────
let refreshPromise: Promise<void> | null = null

async function refreshAccessToken(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = axios
    .post(`${BASE_URL}/api/auth/refresh`, {}, { withCredentials: true })
    .then(() => { /* nueva cookie 'at' seteada automáticamente */ })
    .finally(() => { refreshPromise = null })
  return refreshPromise
}

// ─── Redirect seguro: limpia el estado persistido primero ────
// Si no se limpia, Zustand rehidrata user → ProtectedRoute redirige al
// dashboard → API falla otra vez → redirect → bucle infinito.
function redirectToLogin() {
  localStorage.removeItem('visioncore-auth')
  if (window.location.pathname !== '/login') {
    window.location.href = '/login'
  }
}

// ─── Response interceptor: manejo de errores y refresh ───────
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ message?: string }>) => {
    const originalRequest = error.config as any
    const url = originalRequest?.url || ''

    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/refresh')

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true
      try {
        await refreshAccessToken()
        return api(originalRequest)
      } catch {
        redirectToLogin()
        return Promise.reject(error)
      }
    }

    // No mostrar toast para 401 (manejado arriba) ni 429 en endpoints de auth
    if (error.response?.status !== 401 && !(error.response?.status === 429 && isAuthEndpoint)) {
      const msg = error.response?.data?.message || 'Error de conexión'
      toast.error(msg)
    }

    return Promise.reject(error)
  }
)

// ─── Helpers tipados ──────────────────────────────────────────
export const apiGet = <T>(url: string, params?: object) =>
  api.get<T>(url, { params }).then((r) => r.data)

export const apiPost = <T>(url: string, data?: object) =>
  api.post<T>(url, data).then((r) => r.data)

export const apiPut = <T>(url: string, data?: object) =>
  api.put<T>(url, data).then((r) => r.data)

export const apiDelete = <T>(url: string) =>
  api.delete<T>(url).then((r) => r.data)
