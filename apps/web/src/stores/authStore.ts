// src/stores/authStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiGet, apiPost } from '@/lib/api'
import { connectWebSocket, disconnectWebSocket } from '@/lib/websocket'
import type { User, LoginResponse, UserFeaturePermissions } from '@/types'

interface TwoFactorChallenge {
  tempToken: string
  username: string
}

interface MfaEnrollment {
  enrollToken: string
  username: string
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  twoFactorChallenge: TwoFactorChallenge | null
  // Enrolamiento forzoso de MFA (fase 4b): activo cuando la política exige MFA y el
  // usuario aún no lo tiene con la gracia agotada — no hay acceso hasta completarlo.
  mfaEnrollment: MfaEnrollment | null
  // Usuario ya autenticado por el enrolamiento pero AÚN no promovido a la sesión:
  // se retiene hasta que el usuario confirme haber visto sus códigos de recuperación
  // (si autenticáramos de inmediato, App.tsx redirige y nunca se muestran los códigos).
  pendingUser: User | null
  // Inicios de gracia restantes tras un login de cortesía (para avisar al usuario).
  mfaGraceRemaining: number | null

  login:         (username: string, password: string, rememberMe?: boolean) => Promise<void>
  verify2FA:     (code: string) => Promise<void>
  cancelTwoFactor: () => void
  startMfaEnroll:    () => Promise<{ secret: string; qrCodeUri: string }>
  completeMfaEnroll: (code: string) => Promise<string[]>
  finishMfaEnroll:   () => void
  cancelMfaEnroll:   () => void
  logout:        () => Promise<void>
  loadUser:      () => Promise<void>
  hasRole:       (...roles: User['role'][]) => boolean
  canFeature:    (key: keyof UserFeaturePermissions) => boolean
  canViewRecordings: () => boolean
  canManageUsers:    () => boolean
  canConfigureNVR:   () => boolean
}

// Guarda los tokens en el almacenamiento elegido y fija el header Authorization.
function persistTokens(data: { accessToken: string; refreshToken: string }, rememberMe: boolean) {
  const storage = rememberMe ? localStorage : sessionStorage
  storage.setItem('accessToken', data.accessToken)
  storage.setItem('refreshToken', data.refreshToken)
  if (!rememberMe) {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
  }
  api.defaults.headers.common.Authorization = `Bearer ${data.accessToken}`
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      twoFactorChallenge: null,
      mfaEnrollment: null,
      pendingUser: null,
      mfaGraceRemaining: null,

      login: async (username, password, rememberMe = true) => {
        set({ isLoading: true })
        try {
          const data = await apiPost<any>('/auth/login', { username, password })

          if (data.requiresTwoFactor) {
            // Store rememberMe preference for the 2FA step
            sessionStorage.setItem('pendingRememberMe', rememberMe ? '1' : '0')
            set({ twoFactorChallenge: { tempToken: data.tempToken, username }, isLoading: false })
            return
          }

          if (data.requiresMfaEnrollment) {
            // Enrolamiento forzoso: aún no hay tokens de acceso, sólo enrollToken.
            sessionStorage.setItem('pendingRememberMe', rememberMe ? '1' : '0')
            set({ mfaEnrollment: { enrollToken: data.enrollToken, username }, isLoading: false })
            return
          }

          persistTokens(data, rememberMe)
          set({
            user: data.user, isAuthenticated: true, isLoading: false, twoFactorChallenge: null,
            mfaGraceRemaining: data.mustEnrollMfa ? (data.mfaGraceRemaining ?? 0) : null,
          })
          connectWebSocket()
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      verify2FA: async (code) => {
        const { twoFactorChallenge } = get()
        if (!twoFactorChallenge) throw new Error('Sin desafío 2FA activo')

        set({ isLoading: true })
        try {
          const data = await apiPost<LoginResponse>('/auth/2fa/verify', {
            tempToken: twoFactorChallenge.tempToken,
            code,
          })
          const rememberMe = sessionStorage.getItem('pendingRememberMe') !== '0'
          sessionStorage.removeItem('pendingRememberMe')
          persistTokens(data, rememberMe)
          set({ user: data.user, isAuthenticated: true, isLoading: false, twoFactorChallenge: null })
          connectWebSocket()
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      cancelTwoFactor: () => set({ twoFactorChallenge: null }),

      // Enrolamiento forzoso de MFA — genera secreto + QR con el enrollToken.
      startMfaEnroll: async () => {
        const { mfaEnrollment } = get()
        if (!mfaEnrollment) throw new Error('Sin enrolamiento MFA activo')
        return apiPost<{ secret: string; qrCodeUri: string }>('/auth/mfa/enroll/start', {
          enrollToken: mfaEnrollment.enrollToken,
        })
      },

      // Verifica el primer código y activa MFA. Persiste los tokens pero NO promueve
      // aún la sesión (isAuthenticated queda false y mfaEnrollment se mantiene) para
      // que la pantalla de códigos de recuperación permanezca montada. La promoción
      // ocurre en finishMfaEnroll, al confirmar el usuario. Devuelve los códigos.
      completeMfaEnroll: async (code) => {
        const { mfaEnrollment } = get()
        if (!mfaEnrollment) throw new Error('Sin enrolamiento MFA activo')
        set({ isLoading: true })
        try {
          const data = await apiPost<any>('/auth/mfa/enroll/complete', {
            enrollToken: mfaEnrollment.enrollToken,
            code,
          })
          const rememberMe = sessionStorage.getItem('pendingRememberMe') !== '0'
          sessionStorage.removeItem('pendingRememberMe')
          persistTokens(data, rememberMe)
          set({ isLoading: false, pendingUser: data.user })
          return (data.backupCodes ?? []) as string[]
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      // Promueve la sesión tras confirmar los códigos de recuperación.
      finishMfaEnroll: () => {
        const { pendingUser } = get()
        set({ user: pendingUser, isAuthenticated: true, mfaEnrollment: null, pendingUser: null })
        connectWebSocket()
      },

      cancelMfaEnroll: () => set({ mfaEnrollment: null, pendingUser: null }),

      logout: async () => {
        const refreshToken = localStorage.getItem('refreshToken') || sessionStorage.getItem('refreshToken')
        try {
          if (refreshToken) await apiPost('/auth/logout', { refreshToken })
        } finally {
          localStorage.removeItem('accessToken')
          localStorage.removeItem('refreshToken')
          sessionStorage.removeItem('accessToken')
          sessionStorage.removeItem('refreshToken')
          delete api.defaults.headers.common.Authorization
          disconnectWebSocket()
          set({ user: null, isAuthenticated: false, twoFactorChallenge: null })
        }
      },

      loadUser: async () => {
        // Check localStorage first (rememberMe=true), then sessionStorage (rememberMe=false)
        const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')
        if (!token) {
          set({ user: null, isAuthenticated: false })
          return
        }
        api.defaults.headers.common.Authorization = `Bearer ${token}`
        try {
          const user = await apiGet<User>('/auth/me')
          set({ user, isAuthenticated: true })
          connectWebSocket()
        } catch (err: any) {
          // Only clear session on explicit 401 — not on network errors or 5xx
          // to avoid logout on temporary connectivity issues during page load.
          if (err?.response?.status === 401) {
            localStorage.removeItem('accessToken')
            localStorage.removeItem('refreshToken')
            sessionStorage.removeItem('accessToken')
            sessionStorage.removeItem('refreshToken')
            set({ user: null, isAuthenticated: false })
          }
        }
      },

      hasRole: (...roles) => {
        const { user } = get()
        return user ? roles.includes(user.role) : false
      },

      canFeature: (key) => {
        const { user } = get()
        if (!user) return false
        if (user.role === 'ADMIN') return true
        return user.featurePermissions?.[key] ?? false
      },

      canViewRecordings: () => {
        const { user } = get()
        if (!user) return false
        if (user.role === 'ADMIN') return true
        return user.featurePermissions?.canViewRecordings ?? ['SUPERVISOR', 'AUDITOR'].includes(user.role)
      },

      canManageUsers: () => {
        const { user } = get()
        if (!user) return false
        if (user.role === 'ADMIN') return true
        return user.featurePermissions?.canManageUsers ?? false
      },

      canConfigureNVR: () => {
        const { user } = get()
        if (!user) return false
        if (user.role === 'ADMIN') return true
        return user.featurePermissions?.canManageNVRs ?? false
      },
    }),
    {
      name: 'visioncore-auth',
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
