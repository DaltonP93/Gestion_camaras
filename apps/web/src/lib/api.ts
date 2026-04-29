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

// ─── Request interceptor: inyectar token ─────────────────────
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ─── Response interceptor: manejo de errores y refresh ───────
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ message?: string }>) => {
    const originalRequest = error.config as any

    // Token expirado → intentar refresh automático
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      const refreshToken = localStorage.getItem('refreshToken')
      if (refreshToken) {
        try {
          const { data } = await axios.post(`${BASE_URL}/api/auth/refresh`, { refreshToken })
          localStorage.setItem('accessToken', data.accessToken)
          originalRequest.headers.Authorization = `Bearer ${data.accessToken}`
          return api(originalRequest)
        } catch {
          // Refresh falló → limpiar sesión
          localStorage.removeItem('accessToken')
          localStorage.removeItem('refreshToken')
          window.location.href = '/login'
          return Promise.reject(error)
        }
      } else {
        window.location.href = '/login'
      }
    }

    // Mostrar toast de error para errores 4xx/5xx (excepto 401 que se maneja arriba)
    if (error.response?.status !== 401) {
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
