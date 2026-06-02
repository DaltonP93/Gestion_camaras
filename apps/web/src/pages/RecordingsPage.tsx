// src/pages/RecordingsPage.tsx
import { useEffect, useState, useMemo } from 'react'
import { Search, Play, Download, Calendar, Clock, ChevronDown, CheckSquare, Square, AlertTriangle, Server } from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiGet } from '@/lib/api'
import { format, subDays, subHours } from 'date-fns'
import { clsx } from 'clsx'
import type { Recording, Camera } from '@/types'
import toast from 'react-hot-toast'

interface RecordingWithCamera extends Recording {
  cameraId: string
  cameraName: string
  nvrName: string
}

interface IsapiError {
  cameraId: string
  cameraName: string
  nvrModel?: string
  code: string
}

export function RecordingsPage() {
  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()
  const [selectedNVR, setSelectedNVR] = useState<string>('all')
  const [selectedCameras, setSelectedCameras] = useState<Set<string>>(new Set())
  const [startDate, setStartDate] = useState(format(subDays(new Date(), 1), "yyyy-MM-dd'T'HH:mm"))
  const [endDate, setEndDate]     = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"))
  const [recordings, setRecordings] = useState<RecordingWithCamera[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [selectedRec, setSelectedRec] = useState<RecordingWithCamera | null>(null)
  const [showCameraList, setShowCameraList] = useState(false)
  const [isapiErrors, setIsapiErrors] = useState<IsapiError[]>([])
  const [searchSource, setSearchSource] = useState<string | null>(null)

  useEffect(() => {
    loadNVRs()
    loadCameras()
  }, [])

  // Cámaras filtradas por NVR
  const filteredCameras = useMemo(() =>
    cameras.filter(c => selectedNVR === 'all' ? true : c.nvrId === selectedNVR),
    [cameras, selectedNVR]
  )

  // Cámaras agrupadas por NVR
  const camerasByNVR = useMemo(() => {
    const map = new Map<string, { nvrName: string; cameras: Camera[] }>()
    filteredCameras.forEach((cam) => {
      const nvrName = cam.nvr?.name || 'Sin NVR'
      if (!map.has(cam.nvrId)) map.set(cam.nvrId, { nvrName, cameras: [] })
      map.get(cam.nvrId)!.cameras.push(cam)
    })
    return map
  }, [filteredCameras])

  // Reset selection when NVR filter changes
  useEffect(() => { setSelectedCameras(new Set()) }, [selectedNVR])

  const toggleCamera = (cameraId: string) => {
    setSelectedCameras(prev => {
      const next = new Set(prev)
      next.has(cameraId) ? next.delete(cameraId) : next.add(cameraId)
      return next
    })
  }

  const toggleAllInNVR = (nvrId: string) => {
    const group = camerasByNVR.get(nvrId)
    if (!group) return
    const allIds = group.cameras.map(c => c.id)
    const allSelected = allIds.every(id => selectedCameras.has(id))
    setSelectedCameras(prev => {
      const next = new Set(prev)
      if (allSelected) allIds.forEach(id => next.delete(id))
      else allIds.forEach(id => next.add(id))
      return next
    })
  }

  const selectAll = () => setSelectedCameras(new Set(filteredCameras.map(c => c.id)))
  const clearAll  = () => setSelectedCameras(new Set())

  const handleSearch = async () => {
    if (selectedCameras.size === 0) { toast.error('Selecciona al menos una cámara'); return }
    setIsSearching(true)
    setPlaybackUrl(null)
    setRecordings([])
    setIsapiErrors([])
    setSearchSource(null)

    const cameraIds = [...selectedCameras]
    const errors: IsapiError[] = []
    let foundSource: string | null = null

    const results = await Promise.allSettled(
      cameraIds.map(async (cameraId) => {
        const cam = cameras.find(c => c.id === cameraId)
        try {
          const res = await apiGet<{ recordings: Recording[]; source?: string; nvrModel?: string }>('/recordings/search', {
            cameraId,
            startTime: new Date(startDate).toISOString(),
            endTime: new Date(endDate).toISOString(),
          })
          if (res?.source) foundSource = res.source
          return (res?.recordings ?? []).map((r): RecordingWithCamera => ({
            ...r,
            cameraId,
            cameraName: cam?.name || 'Desconocida',
            nvrName: cam?.nvr?.name || '',
          }))
        } catch (err: any) {
          const code = err?.response?.data?.code || err?.code || 'NVR_ERROR'
          errors.push({
            cameraId,
            cameraName: cam?.name || 'Desconocida',
            nvrModel: err?.response?.data?.nvrModel,
            code,
          })
          return []
        }
      })
    )

    const all: RecordingWithCamera[] = results
      .filter((r): r is PromiseFulfilledResult<RecordingWithCamera[]> => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())

    setRecordings(all)
    setIsapiErrors(errors)
    if (foundSource) setSearchSource(foundSource)
    if (all.length === 0 && errors.length === 0) toast('Sin grabaciones en ese rango', { icon: 'ℹ️' })
    setIsSearching(false)
  }

  const handlePlay = async (rec: RecordingWithCamera) => {
    setSelectedRec(rec)
    try {
      const result = await apiPost<{ url: string }>('/recordings/playback', {
        cameraId: rec.cameraId,
        startTime: rec.startTime,
        endTime: rec.endTime,
      })
      setPlaybackUrl(result.url)
    } catch {
      toast.error('No se pudo cargar la grabación')
    }
  }

  const formatDuration = (start: string, end: string) => {
    const diff = new Date(end).getTime() - new Date(start).getTime()
    const mins = Math.floor(diff / 60000)
    const secs = Math.floor((diff % 60000) / 1000)
    return `${mins}:${String(secs).padStart(2, '0')}`
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '—'
    if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
    return `${(bytes / 1048576).toFixed(0)} MB`
  }

  const selectedLabel = selectedCameras.size === 0
    ? 'Seleccionar cámaras'
    : `${selectedCameras.size} cámara${selectedCameras.size > 1 ? 's' : ''} seleccionada${selectedCameras.size > 1 ? 's' : ''}`

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <h2 className="text-base font-semibold text-surface-100">Grabaciones</h2>

      {/* Filtros */}
      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">

          {/* Filtro NVR */}
          <div>
            <label className="label">NVR</label>
            <div className="relative">
              <select
                value={selectedNVR}
                onChange={(e) => setSelectedNVR(e.target.value)}
                className="input appearance-none pr-8"
              >
                <option value="all">Todos los NVRs</option>
                {nvrs.map((nvr) => (
                  <option key={nvr.id} value={nvr.id}>{nvr.name}</option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
            </div>
          </div>

          {/* Selector cámaras (dropdown con checkboxes) */}
          <div>
            <label className="label">Cámaras</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowCameraList(v => !v)}
                className="input text-left flex items-center justify-between w-full"
              >
                <span className={clsx('truncate', selectedCameras.size === 0 && 'text-surface-500')}>
                  {selectedLabel}
                </span>
                <ChevronDown size={12} className="text-surface-400 flex-shrink-0 ml-2" />
              </button>

              {showCameraList && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-surface-800 border border-surface-600 rounded-lg shadow-xl max-h-72 overflow-y-auto">
                  {/* Controles rápidos */}
                  <div className="sticky top-0 bg-surface-800 border-b border-surface-700 px-3 py-2 flex items-center gap-2">
                    <button onClick={selectAll} className="text-xs text-brand-400 hover:text-brand-300">
                      Seleccionar todo
                    </button>
                    <span className="text-surface-600">·</span>
                    <button onClick={clearAll} className="text-xs text-surface-400 hover:text-surface-200">
                      Limpiar
                    </button>
                    <span className="ml-auto text-xs text-surface-500">{selectedCameras.size} sel.</span>
                  </div>

                  {/* Lista por NVR */}
                  {[...camerasByNVR.entries()].map(([nvrId, { nvrName, cameras: cams }]) => {
                    const allSel = cams.every(c => selectedCameras.has(c.id))
                    const someSel = cams.some(c => selectedCameras.has(c.id))
                    return (
                      <div key={nvrId}>
                        {/* Header NVR */}
                        <button
                          onClick={() => toggleAllInNVR(nvrId)}
                          className="w-full flex items-center gap-2 px-3 py-2 bg-surface-750 hover:bg-surface-700 transition-colors text-left"
                        >
                          {allSel
                            ? <CheckSquare size={13} className="text-brand-400 flex-shrink-0" />
                            : someSel
                              ? <CheckSquare size={13} className="text-brand-400/50 flex-shrink-0" />
                              : <Square size={13} className="text-surface-500 flex-shrink-0" />
                          }
                          <span className="text-xs font-medium text-surface-200 uppercase tracking-wide">{nvrName}</span>
                          <span className="ml-auto text-xs text-surface-500">{cams.length}ch</span>
                        </button>
                        {/* Cámaras del NVR */}
                        {cams.map((cam) => (
                          <button
                            key={cam.id}
                            onClick={() => toggleCamera(cam.id)}
                            className="w-full flex items-center gap-2 pl-6 pr-3 py-1.5 hover:bg-surface-700/50 transition-colors text-left"
                          >
                            {selectedCameras.has(cam.id)
                              ? <CheckSquare size={12} className="text-brand-400 flex-shrink-0" />
                              : <Square size={12} className="text-surface-600 flex-shrink-0" />
                            }
                            <span className="text-xs text-surface-300 truncate">{cam.name}</span>
                            <span className={clsx(
                              'ml-auto text-xs flex-shrink-0',
                              cam.online ? 'text-green-500' : 'text-surface-600'
                            )}>
                              {cam.online ? '●' : '○'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Fecha inicio */}
          <div>
            <label className="label">Desde</label>
            <input
              type="datetime-local"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="input"
            />
          </div>

          {/* Fecha fin */}
          <div>
            <label className="label">Hasta</label>
            <input
              type="datetime-local"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="input"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Shortcuts de fechas */}
          <div className="flex gap-2 flex-wrap flex-1">
            {[
              { label: 'Última hora', fn: () => { setEndDate(format(new Date(), "yyyy-MM-dd'T'HH:mm")); setStartDate(format(subHours(new Date(), 1), "yyyy-MM-dd'T'HH:mm")) } },
              { label: 'Hoy', fn: () => { setEndDate(format(new Date(), "yyyy-MM-dd'T'HH:mm")); setStartDate(format(subHours(new Date(), 24), "yyyy-MM-dd'T'HH:mm")) } },
              { label: 'Ayer', fn: () => { setEndDate(format(subDays(new Date(), 1), "yyyy-MM-dd'T'HH:mm")); setStartDate(format(subDays(new Date(), 2), "yyyy-MM-dd'T'HH:mm")) } },
              { label: 'Últimos 7 días', fn: () => { setEndDate(format(new Date(), "yyyy-MM-dd'T'HH:mm")); setStartDate(format(subDays(new Date(), 7), "yyyy-MM-dd'T'HH:mm")) } },
            ].map(({ label, fn }) => (
              <button
                key={label}
                onClick={fn}
                className="text-xs px-2.5 py-1 rounded-md bg-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-600 transition-colors"
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={handleSearch}
            disabled={isSearching || selectedCameras.size === 0}
            className="btn-primary justify-center min-w-[120px]"
          >
            {isSearching ? <span className="animate-spin">⟳</span> : <Search size={14} />}
            {isSearching ? 'Buscando...' : 'Buscar'}
          </button>
        </div>
      </div>

      {/* Cerrar dropdown al hacer click fuera */}
      {showCameraList && (
        <div className="fixed inset-0 z-40" onClick={() => setShowCameraList(false)} />
      )}

      {/* Source banner */}
      {searchSource === 'nvr_isapi' && recordings.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-900/30 border border-brand-800/50 text-xs text-brand-300">
          <Server size={12} className="flex-shrink-0" />
          Resultados obtenidos directamente del NVR vía ISAPI
        </div>
      )}

      {/* ISAPI errors */}
      {isapiErrors.length > 0 && (
        <div className="space-y-1.5">
          {isapiErrors.map((err) => (
            <div key={err.cameraId} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-900/20 border border-amber-800/40 text-xs">
              <AlertTriangle size={12} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <span className="text-amber-300 font-medium">{err.cameraName}</span>
                {err.code === 'ISAPI_UNSUPPORTED' ? (
                  <span className="text-amber-500"> — NVR no soporta búsqueda ISAPI{err.nvrModel ? ` (${err.nvrModel})` : ''}</span>
                ) : err.code === 'NVR_AUTH_ERROR' ? (
                  <span className="text-amber-500"> — Error de autenticación con el NVR</span>
                ) : (
                  <span className="text-amber-500"> — No se pudo contactar el NVR</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Lista de grabaciones */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-600 flex items-center justify-between">
            <h3 className="text-sm font-medium text-surface-100">
              Resultados
              {recordings.length > 0 && (
                <span className="ml-2 text-xs text-surface-400">{recordings.length} grabaciones</span>
              )}
            </h3>
          </div>
          <div className="divide-y divide-surface-700 max-h-[500px] overflow-auto">
            {recordings.length === 0 ? (
              <div className="py-12 text-center">
                <Calendar size={24} className="text-surface-600 mx-auto mb-2" />
                <p className="text-sm text-surface-500">
                  {isSearching ? 'Buscando...' : 'Realiza una búsqueda para ver grabaciones'}
                </p>
              </div>
            ) : (
              recordings.map((rec) => (
                <div
                  key={`${rec.cameraId}-${rec.id}`}
                  className={clsx(
                    'px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-surface-700/50 transition-colors',
                    selectedRec?.id === rec.id && selectedRec?.cameraId === rec.cameraId && 'bg-surface-700/80'
                  )}
                  onClick={() => handlePlay(rec)}
                >
                  <div className="w-8 h-8 rounded-lg bg-brand-900/50 flex items-center justify-center flex-shrink-0">
                    <Play size={12} className="text-brand-400 fill-brand-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-xs text-surface-300 font-medium truncate">
                        {rec.nvrName} · {rec.cameraName}
                      </span>
                      {rec.type && rec.type !== 'video/mp4' && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-surface-700 text-surface-400 uppercase tracking-wide flex-shrink-0">
                          {rec.type.replace('video/', '').replace('//recordType.meta.std-cgi.com/', '')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-surface-100">
                      {format(new Date(rec.startTime), 'dd/MM/yyyy HH:mm:ss')}
                    </div>
                    <div className="text-xs text-surface-400 flex items-center gap-2 mt-0.5">
                      <span className="flex items-center gap-1">
                        <Clock size={10} /> {formatDuration(rec.startTime, rec.endTime)}
                      </span>
                      {rec.size > 0 && <span>{formatSize(rec.size)}</span>}
                    </div>
                  </div>
                  <button
                    className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-600 transition-colors flex-shrink-0"
                    title="Descargar"
                    onClick={(e) => { e.stopPropagation(); toast('Descarga no disponible en demo', { icon: 'ℹ️' }) }}
                  >
                    <Download size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Reproductor */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-600">
            <h3 className="text-sm font-medium text-surface-100">
              {selectedRec
                ? `${selectedRec.nvrName} · ${selectedRec.cameraName} — ${format(new Date(selectedRec.startTime), 'dd/MM HH:mm')}`
                : 'Reproductor'}
            </h3>
          </div>
          <div className="aspect-video bg-surface-900 flex items-center justify-center">
            {playbackUrl ? (
              <video
                key={playbackUrl}
                src={playbackUrl}
                controls
                autoPlay
                className="w-full h-full"
              />
            ) : (
              <div className="text-center">
                <Play size={32} className="text-surface-700 mx-auto mb-2" />
                <p className="text-xs text-surface-500">
                  {recordings.length > 0
                    ? 'Selecciona una grabación para reproducir'
                    : 'Busca grabaciones primero'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
