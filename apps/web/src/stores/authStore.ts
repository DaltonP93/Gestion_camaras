// src/stores/authStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { apiGet, apiPost } from '@/lib/api'
import { connectWebSocket, disconnectWebSocket } from '@/lib/websocket'
import type { User } from '@/types'

interface LoginResponse {
  user: User
}

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
          // Las cookies httpOnly 'at' y 'rt' son seteadas por el servidor automáticamente
          const data = await apiPost<LoginResponse>('/auth/login', { username, password })
          set({ user: data.user, isAuthenticated: true, isLoading: false })
          connectWebSocket()
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      logout: async () => {
        try {
          await apiPost('/auth/logout')
        } finally {
          disconnectWebSocket()
          set({ user: null, isAuthenticated: false })
        }
      },

      loadUser: async () => {
        // No hay token en localStorage; la cookie httpOnly se envía automáticamente
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
      // Persistir solo el flag; al recargar, loadUser() verifica con el servidor
      partialize: (state) => ({ isAuthenticated: state.isAuthenticated }),
    }
  )
)
