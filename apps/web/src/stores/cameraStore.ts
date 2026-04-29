// src/stores/cameraStore.ts
import { create } from 'zustand'
import { apiGet, apiPost } from '@/lib/api'
import type { Camera, NVR, NVRStatus, StreamInfo } from '@/types'

interface CameraState {
  nvrs: NVR[]
  cameras: Camera[]
  nvrStatuses: Record<string, NVRStatus>
  activeStreams: Record<string, StreamInfo>
  selectedCameras: string[]
  isLoading: boolean

  loadNVRs: () => Promise<void>
  loadCameras: (nvrId?: string) => Promise<void>
  loadNVRStatus: (nvrId: string) => Promise<void>
  getStream: (cameraId: string) => Promise<StreamInfo>
  toggleCameraSelection: (cameraId: string, maxSelect?: number) => void
  clearSelection: () => void
}

export const useCameraStore = create<CameraState>((set, get) => ({
  nvrs: [],
  cameras: [],
  nvrStatuses: {},
  activeStreams: {},
  selectedCameras: [],
  isLoading: false,

  loadNVRs: async () => {
    set({ isLoading: true })
    try {
      const nvrs = await apiGet<NVR[]>('/nvrs')
      set({ nvrs, isLoading: false })
    } catch {
      set({ isLoading: false })
    }
  },

  loadCameras: async (nvrId?: string) => {
    set({ isLoading: true })
    try {
      const cameras = await apiGet<Camera[]>('/cameras', nvrId ? { nvrId } : {})
      set({ cameras, isLoading: false })
    } catch {
      set({ isLoading: false })
    }
  },

  loadNVRStatus: async (nvrId: string) => {
    try {
      const status = await apiGet<NVRStatus>(`/nvrs/${nvrId}/status`)
      set((state) => ({
        nvrStatuses: { ...state.nvrStatuses, [nvrId]: status },
      }))
    } catch {
      // Mantener estado anterior si falla
    }
  },

  getStream: async (cameraId: string) => {
    const existing = get().activeStreams[cameraId]
    if (existing) return existing

    const info = await apiGet<StreamInfo>(`/cameras/${cameraId}/stream`)
    set((state) => ({
      activeStreams: { ...state.activeStreams, [cameraId]: info },
    }))
    return info
  },

  toggleCameraSelection: (cameraId, maxSelect = 16) => {
    set((state) => {
      const selected = state.selectedCameras
      if (selected.includes(cameraId)) {
        return { selectedCameras: selected.filter((id) => id !== cameraId) }
      }
      if (selected.length >= maxSelect) return state
      return { selectedCameras: [...selected, cameraId] }
    })
  },

  clearSelection: () => set({ selectedCameras: [] }),
}))
