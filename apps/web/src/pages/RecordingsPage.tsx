// src/pages/RecordingsPage.tsx
import { useEffect, useState, useMemo, useRef } from 'react'
import {
  Search, Play, Download, Calendar, Clock,
  ChevronDown, CheckSquare, Square, AlertTriangle, Server, Info,
} from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost } from '@/lib/api'
import { format, subDays, subHours, startOfDay, endOfDay } from 'date-fns'
import { clsx } from 'clsx'
import type { Recording, Camera } from '@/types'
import toast from 'react-hot-toast'

interface RecordingWithCamera extends Recording {
  cameraId: string
  cameraName: string
  nvrName: string
}

interface NVRErrorGroup {
  nvrId: string
  nvrName: string
  nvrModel?: string
  code: string
  cameraCount: number
  cameraNames: string[]
}

function toLocalDatetimeString(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm")
}

export function RecordingsPage() {
  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()
  const [selectedNVR, setSelectedNVR] = useState<string>('all')
  const [selectedCameras, setSelectedCameras] = useState<Set<string>>(new Set())
  const [startDate, setStartDate] = useState(toLocalDatetimeString(subHours(new Date(), 1)))
  const [endDate, setEndDate]     = useState(toLocalDatetimeString(new Date()))
  const [recordings, setRecordings] = useState<RecordingWithCamera[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [selectedRec, setSelectedRec] = useState<RecordingWithCamera | null>(null)
  const [showCameraList, setShowCameraList] = useState(false)
  const [nvrErrors, setNvrErrors] = useState<NVRErrorGroup[]>([])
  const [searchSource, setSearchSource] = useState<string | null>(null)
  // NVRs known to not support ISAPI search — skip in future searches
  const [unsupportedNVRs] = useState<Set<string>>(new Set())

  const startInputRef = useRef<HTMLInputElement>(null)
  const endInputRef   = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadNVRs()
    loadCameras()
  }, [])

  const filteredCameras = useMemo(() =>
    cameras.filter(c => selectedNVR === 'all' ? true : c.nvrId === selectedNVR),
    [cameras, selectedNVR]
  )

  const camerasByNVR = useMemo(() => {
    const map = new Map<string, { nvrName: string; cameras: Camera[] }>()
    filteredCameras.forEach((cam) => {
      const nvrName = cam.nvr?.name || 'Sin NVR'
      if (!map.has(cam.nvrId)) map.set(cam.nvrId, { nvrName, cameras: [] })
      map.get(cam.nvrId)!.cameras.push(cam)
    })
    return map
  }, [filteredCameras])

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

  const setQuick = (from: Date, to: Date) => {
    setStartDate(toLocalDatetimeString(from))
    setEndDate(toLocalDatetimeString(to))
  }

  const handleSearch = async () => {
    if (selectedCameras.size === 0) { toast.error('Selecciona al menos una cámara'); return }
    const start = new Date(startDate)
    const end   = new Date(endDate)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) { toast.error('Fechas inválidas'); return }
    if (start >= end) { toast.error('La fecha Desde debe ser anterior a Hasta'); return }

    setIsSearching(true)
    setPlaybackUrl(null)
    setRecordings([])
    setNvrErrors([])
    setSearchSource(null)

    // Group selected cameras by NVR, skipping known-unsupported NVRs
    const byNvr = new Map<string, string[]>()
    for (const cid of selectedCameras) {
      const cam = cameras.find(c => c.id === cid)
      if (!cam || unsupportedNVRs.has(cam.nvrId)) continue
      if (!byNvr.has(cam.nvrId)) byNvr.set(cam.nvrId, [])
      byNvr.get(cam.nvrId)!.push(cid)
    }

    const errByNvr = new Map<string, NVRErrorGroup>()
    const allRecordings: RecordingWithCamera[] = []
    let foundSource: string | null = null

    await Promise.all(
      [...byNvr.entries()].map(async ([nvrId, cameraIds]) => {
        const fallbackNvrName = cameras.find(c => c.nvrId === nvrId)?.nvr?.name ?? 'NVR desconocido'
        try {
          const res = await apiPost<{
            results: Array<{ cameraId: string; cameraName: string; channel: number; recordings: Recording[] }>
            unsupportedNvr: boolean
            authError?: boolean
            nvrModel?: string
            nvrName?: string
            errors: Array<{ code: string; message: string; cameraId?: string }>
            cameraCount: number
          }>('/recordings/batch-search', {
            nvrId,
            cameraIds,
            from: start.toISOString(),
            to:   end.toISOString(),
          })

          const nvrName  = res.nvrName  ?? fallbackNvrName
          const nvrModel = res.nvrModel

          if (res.unsupportedNvr) {
            unsupportedNVRs.add(nvrId)
            errByNvr.set(`${nvrId}_ISAPI_UNSUPPORTED`, {
              nvrId, nvrName, nvrModel,
              code: 'ISAPI_UNSUPPORTED',
              cameraCount: res.cameraCount,
              cameraNames: res.results.map(r => r.cameraName).slice(0, 3),
            })
            return
          }

          if (res.authError) {
            errByNvr.set(`${nvrId}_NVR_AUTH_ERROR`, {
              nvrId, nvrName, nvrModel,
              code: 'NVR_AUTH_ERROR',
              cameraCount: res.cameraCount,
              cameraNames: [],
            })
            return
          }

          for (const camResult of res.results) {
            if (camResult.recordings.length > 0) foundSource = 'nvr_isapi'
            for (const rec of camResult.recordings) {
              allRecordings.push({
                ...rec,
                cameraId:   camResult.cameraId,
                cameraName: camResult.cameraName,
                nvrName,
              })
            }
          }
        } catch (err: any) {
          const code    = err?.response?.data?.code ?? 'NVR_ERROR'
          const nvrName = err?.response?.data?.nvrName ?? fallbackNvrName
          if (code === 'ISAPI_UNSUPPORTED') unsupportedNVRs.add(nvrId)
          errByNvr.set(`${nvrId}_${code}`, {
            nvrId, nvrName,
            nvrModel: err?.response?.data?.nvrModel,
            code,
            cameraCount: cameraIds.length,
            cameraNames: cameraIds
              .map(cid => cameras.find(c => c.id === cid)?.name ?? 'Desconocida')
              .slice(0, 3),
          })
        }
      })
    )

    const sorted = allRecordings.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
    setRecordings(sorted)
    setNvrErrors([...errByNvr.values()])
    if (foundSource) setSearchSource(foundSource)
    if (sorted.length === 0 && errByNvr.size === 0) toast('Sin grabaciones en ese rango', { icon: 'ℹ️' })
    setIsSearching(false)
  }

  const handlePlay = async (rec: RecordingWithCamera) => {
    setSelectedRec(rec)
    try {
      const result = await apiPost<{ url: string }>('/recordings/playback', {
        cameraId:  rec.cameraId,
        startTime: rec.startTime,
        endTime:   rec.endTime,
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

  const triggerDatePicker = (ref: React.RefObject<HTMLInputElement | null>) => {
    const el = ref.current
    if (!el) return
    try { (el as any).showPicker?.() } catch { el.focus() }
  }

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <h2 className="text-base font-semibold text-surface-100">Grabaciones</h2>

      {/* Filtros */}
      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">

          {/* NVR */}
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

          {/* Cámaras */}
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
                  <div className="sticky top-0 bg-surface-800 border-b border-surface-700 px-3 py-2 flex items-center gap-2">
                    <button onClick={selectAll} className="text-xs text-brand-400 hover:text-brand-300">Seleccionar todo</button>
                    <span className="text-surface-600">·</span>
                    <button onClick={clearAll} className="text-xs text-surface-400 hover:text-surface-200">Limpiar</button>
                    <span className="ml-auto text-xs text-surface-500">{selectedCameras.size} sel.</span>
                  </div>

                  {[...camerasByNVR.entries()].map(([nvrId, { nvrName, cameras: cams }]) => {
                    const allSel  = cams.every(c => selectedCameras.has(c.id))
                    const someSel = cams.some(c => selectedCameras.has(c.id))
                    const isUnsupported = unsupportedNVRs.has(nvrId)
                    return (
                      <div key={nvrId}>
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
                          {isUnsupported && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-500 ml-1">sin ISAPI</span>
                          )}
                          <span className="ml-auto text-xs text-surface-500">{cams.length}ch</span>
                        </button>
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
                            <span className={clsx('ml-auto text-xs flex-shrink-0', cam.online ? 'text-green-500' : 'text-surface-600')}>
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
            <div
              className="flex items-center gap-1 input cursor-pointer p-0 overflow-hidden"
              onClick={() => triggerDatePicker(startInputRef)}
            >
              <input
                ref={startInputRef}
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 min-w-0 bg-transparent border-0 outline-none px-3 py-2 text-sm text-surface-100 cursor-pointer"
                style={{ colorScheme: 'dark' }}
              />
              <span className="pr-2 text-surface-400 flex-shrink-0 pointer-events-none">
                <Calendar size={13} />
              </span>
            </div>
          </div>

          {/* Fecha fin */}
          <div>
            <label className="label">Hasta</label>
            <div
              className="flex items-center gap-1 input cursor-pointer p-0 overflow-hidden"
              onClick={() => triggerDatePicker(endInputRef)}
            >
              <input
                ref={endInputRef}
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 min-w-0 bg-transparent border-0 outline-none px-3 py-2 text-sm text-surface-100 cursor-pointer"
                style={{ colorScheme: 'dark' }}
              />
              <span className="pr-2 text-surface-400 flex-shrink-0 pointer-events-none">
                <Calendar size={13} />
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Accesos rápidos */}
          <div className="flex gap-2 flex-wrap flex-1">
            {[
              { label: 'Última hora', fn: () => setQuick(subHours(new Date(), 1), new Date()) },
              { label: 'Hoy',         fn: () => setQuick(startOfDay(new Date()), new Date()) },
              { label: 'Ayer',        fn: () => setQuick(startOfDay(subDays(new Date(), 1)), endOfDay(subDays(new Date(), 1))) },
              { label: 'Últimos 7d',  fn: () => setQuick(startOfDay(subDays(new Date(), 7)), new Date()) },
            ].map(({ label, fn }) => (
              <button key={label} onClick={fn}
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

      {showCameraList && <div className="fixed inset-0 z-40" onClick={() => setShowCameraList(false)} />}

      {/* Source banner */}
      {searchSource === 'nvr_isapi' && recordings.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-900/30 border border-brand-800/50 text-xs text-brand-300">
          <Server size={12} className="flex-shrink-0" />
          Resultados obtenidos directamente del NVR vía ISAPI
        </div>
      )}

      {/* Error agrupado por NVR — un banner por NVR, no uno por cámara */}
      {nvrErrors.length > 0 && (
        <div className="space-y-1.5">
          {nvrErrors.map((grp) => (
            <div key={`${grp.nvrId}_${grp.code}`}
              className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-900/20 border border-amber-800/40 text-xs"
            >
              {grp.code === 'ISAPI_UNSUPPORTED'
                ? <Info size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
                : <AlertTriangle size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
              }
              <div className="flex-1 min-w-0">
                <span className="text-amber-300 font-medium">{grp.nvrName}</span>
                {grp.nvrModel && <span className="text-amber-500 ml-1">({grp.nvrModel})</span>}
                {grp.code === 'ISAPI_UNSUPPORTED' ? (
                  <p className="text-amber-500 mt-0.5">
                    Este NVR no soporta búsqueda de grabaciones vía ISAPI
                    {grp.cameraCount > 1 && ` · ${grp.cameraCount} cámaras omitidas`}
                    . Se requiere SDK o acceso local al NVR.
                  </p>
                ) : grp.code === 'NVR_AUTH_ERROR' ? (
                  <p className="text-amber-500 mt-0.5">Error de autenticación — verifica usuario/contraseña del NVR.</p>
                ) : (
                  <p className="text-amber-500 mt-0.5">
                    No se pudo contactar el NVR
                    {grp.cameraCount > 1 && ` (${grp.cameraCount} cámaras afectadas)`}.
                  </p>
                )}
                {grp.cameraNames.length > 0 && (
                  <p className="text-amber-700 mt-0.5 truncate">
                    {grp.cameraNames.join(', ')}{grp.cameraCount > grp.cameraNames.length ? ` +${grp.cameraCount - grp.cameraNames.length} más` : ''}
                  </p>
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
            <h3 className="text-sm font-medium text-surface-100 truncate">
              {selectedRec
                ? `${selectedRec.nvrName} · ${selectedRec.cameraName} — ${format(new Date(selectedRec.startTime), 'dd/MM HH:mm')}`
                : 'Reproductor'}
            </h3>
          </div>
          <div className="aspect-video bg-surface-900 flex items-center justify-center">
            {playbackUrl ? (
              <video key={playbackUrl} src={playbackUrl} controls autoPlay className="w-full h-full" />
            ) : (
              <div className="text-center">
                <Play size={32} className="text-surface-700 mx-auto mb-2" />
                <p className="text-xs text-surface-500">
                  {recordings.length > 0 ? 'Selecciona una grabación para reproducir' : 'Busca grabaciones primero'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
