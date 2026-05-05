// src/stores/authStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiGet, apiPost } from '@/lib/api'
import { connectWebSocket, disconnectWebSocket } from '@/lib/websocket'
import type { User, LoginResponse } from '@/types'

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean

  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  loadUser: () => Promise<void>
  hasRole: (...roles: User['role'][]) => boolean
  canViewRecordings: () => boolean
  canManageUsers: () => boolean
  canConfigureNVR: () => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (username, password) => {
        set({ isLoading: true })
        try {
          const data = await apiPost<LoginResponse>('/auth/login', { username, password })
          localStorage.setItem('accessToken', data.accessToken)
          localStorage.setItem('refreshToken', data.refreshToken)
          api.defaults.headers.common.Authorization = `Bearer ${data.accessToken}`
          set({ user: data.user, isAuthenticated: true, isLoading: false })
          connectWebSocket()
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      logout: async () => {
        const refreshToken = localStorage.getItem('refreshToken')
        try {
          if (refreshToken) await apiPost('/auth/logout', { refreshToken })
        } finally {
          localStorage.removeItem('accessToken')
          localStorage.removeItem('refreshToken')
          delete api.defaults.headers.common.Authorization
          disconnectWebSocket()
          set({ user: null, isAuthenticated: false })
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
        } catch {
          set({ user: null, isAuthenticated: false })
        }
      },

      hasRole: (...roles) => {
        const { user } = get()
        return user ? roles.includes(user.role) : false
      },

      canViewRecordings: () => {
        const { user } = get()
        return user ? ['ADMIN', 'SUPERVISOR', 'AUDITOR'].includes(user.role) : false
      },

      canManageUsers: () => {
        const { user } = get()
        return user?.role === 'ADMIN'
      },

      canConfigureNVR: () => {
        const { user } = get()
        return user?.role === 'ADMIN'
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
