// src/hooks/useNVRs.ts
import { useEffect } from 'react'
import { useCameraStore } from '@/stores/cameraStore'

export function useNVRs() {
  const { nvrs, cameras, isLoading, loadNVRs, loadCameras } = useCameraStore()

  useEffect(() => {
    if (nvrs.length === 0) loadNVRs()
    if (cameras.length === 0) loadCameras()
  }, [])

  return { nvrs, cameras, isLoading, reload: () => { loadNVRs(); loadCameras() } }
}
