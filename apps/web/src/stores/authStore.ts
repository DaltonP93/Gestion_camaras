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

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  twoFactorChallenge: TwoFactorChallenge | null

  login:         (username: string, password: string) => Promise<void>
  verify2FA:     (code: string) => Promise<void>
  cancelTwoFactor: () => void
  logout:        () => Promise<void>
  loadUser:      () => Promise<void>
  hasRole:       (...roles: User['role'][]) => boolean
  canFeature:    (key: keyof UserFeaturePermissions) => boolean
  canViewRecordings: () => boolean
  canManageUsers:    () => boolean
  canConfigureNVR:   () => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      twoFactorChallenge: null,

      login: async (username, password) => {
        set({ isLoading: true })
        try {
          const data = await apiPost<any>('/auth/login', { username, password })

          if (data.requiresTwoFactor) {
            set({ twoFactorChallenge: { tempToken: data.tempToken, username }, isLoading: false })
            return
          }

          localStorage.setItem('accessToken', data.accessToken)
          localStorage.setItem('refreshToken', data.refreshToken)
          api.defaults.headers.common.Authorization = `Bearer ${data.accessToken}`
          set({ user: data.user, isAuthenticated: true, isLoading: false, twoFactorChallenge: null })
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
          localStorage.setItem('accessToken', data.accessToken)
          localStorage.setItem('refreshToken', data.refreshToken)
          api.defaults.headers.common.Authorization = `Bearer ${data.accessToken}`
          set({ user: data.user, isAuthenticated: true, isLoading: false, twoFactorChallenge: null })
          connectWebSocket()
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      cancelTwoFactor: () => set({ twoFactorChallenge: null }),

      logout: async () => {
        const refreshToken = localStorage.getItem('refreshToken')
        try {
          if (refreshToken) await apiPost('/auth/logout', { refreshToken })
        } finally {
          localStorage.removeItem('accessToken')
          localStorage.removeItem('refreshToken')
          delete api.defaults.headers.common.Authorization
          disconnectWebSocket()
          set({ user: null, isAuthenticated: false, twoFactorChallenge: null })
        }
      },

      loadUser: async () => {
        const token = localStorage.getItem('accessToken')
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
