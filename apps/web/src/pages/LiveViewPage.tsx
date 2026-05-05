// src/pages/LiveViewPage.tsx
import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Grid2x2, Grid3x3, LayoutGrid, Maximize2, ChevronDown,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { VideoPlayer } from '@/components/cameras/VideoPlayer'
import { PTZControls } from '@/components/cameras/PTZControls'
import { useAuthStore } from '@/stores/authStore'
import { apiGet } from '@/lib/api'
import { clsx } from 'clsx'
import type { Camera, StreamInfo, GridLayout } from '@/types'

const GRID_OPTIONS: { value: GridLayout; label: string; icon: React.ReactNode; cols: string }[] = [
  { value: 1,  label: '1×1',  icon: <Maximize2 size={14} />,  cols: 'grid-cols-1' },
  { value: 4,  label: '2×2',  icon: <Grid2x2 size={14} />,    cols: 'grid-cols-2' },
  { value: 9,  label: '3×3',  icon: <Grid3x3 size={14} />,    cols: 'grid-cols-3' },
  { value: 16, label: '4×4',  icon: <LayoutGrid size={14} />, cols: 'grid-cols-4' },
]

export function LiveViewPage() {
  const [searchParams] = useSearchParams()
  const nvrFilter = searchParams.get('nvr')

  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()
  const { user } = useAuthStore()

  const [gridLayout, setGridLayout] = useState<GridLayout>(9)
  const [selectedNVR, setSelectedNVR] = useState<string>(nvrFilter || 'all')
  const [page, setPage] = useState(0)
  const [streams, setStreams] = useState<Record<string, StreamInfo>>({})
  const [loadingStreams, setLoadingStreams] = useState<Record<string, boolean>>({})
  const [failedStreams, setFailedStreams] = useState<Set<string>>(new Set())
  const [focusCamera, setFocusCamera] = useState<string | null>(null)

  useEffect(() => {
    loadNVRs()
    loadCameras()
  }, [])

  useEffect(() => {
    if (nvrFilter) setSelectedNVR(nvrFilter)
  }, [nvrFilter])

  // Resetear página al cambiar NVR o layout
  useEffect(() => { setPage(0) }, [selectedNVR, gridLayout])

  // Todas las cámaras filtradas por NVR (sin paginar)
  const allFiltered = cameras.filter((c) =>
    selectedNVR === 'all' ? true : c.nvrId === selectedNVR
  )

  const totalPages = Math.max(1, Math.ceil(allFiltered.length / gridLayout))
  const safePage = Math.min(page, totalPages - 1)

  // Cámaras de la página actual
  const filteredCameras = allFiltered.slice(safePage * gridLayout, (safePage + 1) * gridLayout)

  // Cargar stream de una cámara
  const loadStream = useCallback(async (camera: Camera) => {
    if (streams[camera.id] || loadingStreams[camera.id]) return

    setLoadingStreams((prev) => ({ ...prev, [camera.id]: true }))
    try {
      const info = await apiGet<StreamInfo>(`/cameras/${camera.id}/stream`)
      setStreams((prev) => ({ ...prev, [camera.id]: info }))
      setFailedStreams((prev) => {
        if (!prev.has(camera.id)) return prev
        const next = new Set(prev); next.delete(camera.id); return next
      })
    } catch {
      setFailedStreams((prev) => new Set(prev).add(camera.id))
    } finally {
      setLoadingStreams((prev) => ({ ...prev, [camera.id]: false }))
    }
  }, [streams, loadingStreams])

  useEffect(() => {
    filteredCameras.forEach((cam) => loadStream(cam))
  }, [filteredCameras.map(c => c.id).join(',')])

  const currentGrid = GRID_OPTIONS.find((g) => g.value === gridLayout) || GRID_OPTIONS[2]

  const handleFullscreen = (cameraId: string) => {
    setFocusCamera(focusCamera === cameraId ? null : cameraId)
  }

  const totalForFilter = allFiltered.length

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-surface-800 border-b border-surface-600">
        {/* Selector NVR */}
        <div className="relative">
          <select
            value={selectedNVR}
            onChange={(e) => setSelectedNVR(e.target.value)}
            className="appearance-none pl-3 pr-8 py-1.5 rounded-lg bg-surface-700 border border-surface-600
                       text-surface-100 text-xs focus:outline-none focus:border-brand-500 cursor-pointer"
          >
            <option value="all">Todos los NVRs ({cameras.length} cámaras)</option>
            {nvrs.map((nvr) => (
              <option key={nvr.id} value={nvr.id}>
                {nvr.name} ({nvr.channels} canales)
              </option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
        </div>

        <div className="h-4 w-px bg-surface-600" />

        {/* Layout selector */}
        <div className="flex gap-1">
          {GRID_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setGridLayout(opt.value)}
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors',
                gridLayout === opt.value
                  ? 'bg-brand-600 text-white'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
              )}
            >
              {opt.icon}
              <span className="hidden sm:block">{opt.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Paginación */}
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="p-1 rounded-lg bg-surface-700 text-surface-300 hover:bg-surface-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Página anterior"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-surface-400 tabular-nums min-w-[4rem] text-center">
              {safePage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage === totalPages - 1}
              className="p-1 rounded-lg bg-surface-700 text-surface-300 hover:bg-surface-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Página siguiente"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}

        <span className="text-xs text-surface-500">
          {safePage * gridLayout + 1}–{Math.min((safePage + 1) * gridLayout, totalForFilter)} de {totalForFilter} cámaras
        </span>
      </div>

      {/* Grid de video */}
      <div className="flex-1 overflow-hidden p-2 bg-surface-900">
        {focusCamera ? (
          // Vista de una sola cámara
          <div className="h-full">
            {(() => {
              const cam = cameras.find(c => c.id === focusCamera)
              const stream = streams[focusCamera]
              if (!cam) return null
              return (
                <div className="h-full flex gap-2">
                  <VideoPlayer
                    hlsUrl={stream?.hls || ''}
                    cameraName={`${cam.nvr?.name} — ${cam.name}`}
                    isRecording={cam.online}
                    onFullscreen={() => handleFullscreen(focusCamera)}
                    className="flex-1 h-full"
                    error={failedStreams.has(focusCamera)}
                  />
                  {(user?.role === 'ADMIN' || user?.role === 'SUPERVISOR') && cam.ptzEnabled && (
                    <PTZControls cameraId={cam.id} />
                  )}
                </div>
              )
            })()}
          </div>
        ) : (
          // Grid de cámaras
          <div className={clsx('grid gap-1.5 h-full', currentGrid.cols)}>
            {filteredCameras.map((camera) => {
              const stream = streams[camera.id]
              return (
                <div key={camera.id} className="relative min-h-0 rounded-lg overflow-hidden border border-surface-700">
                  <VideoPlayer
                    hlsUrl={stream?.hls || ''}
                    cameraName={`${camera.nvr?.name || ''} · ${camera.name}`}
                    isRecording={camera.online}
                    onFullscreen={() => handleFullscreen(camera.id)}
                    className="w-full h-full"
                    error={failedStreams.has(camera.id)}
                  />
                </div>
              )
            })}
            {/* Celdas vacías para completar la grilla */}
            {Array.from({ length: Math.max(0, gridLayout - filteredCameras.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="rounded-lg border border-surface-700 bg-surface-800/50 flex items-center justify-center">
                <span className="text-xs text-surface-600">Sin cámara</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
