// src/pages/RecordingsPage.tsx
import { useEffect, useState } from 'react'
import { Search, Play, Download, Calendar, Clock, ChevronDown } from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiGet } from '@/lib/api'
import { format, subDays, startOfDay, endOfDay } from 'date-fns'
import { clsx } from 'clsx'
import type { Recording, Camera } from '@/types'
import toast from 'react-hot-toast'

export function RecordingsPage() {
  const { cameras, loadCameras } = useCameraStore()
  const [selectedCamera, setSelectedCamera] = useState<string>('')
  const [startDate, setStartDate] = useState(format(subDays(new Date(), 1), "yyyy-MM-dd'T'HH:mm"))
  const [endDate, setEndDate]     = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"))
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [selectedRec, setSelectedRec] = useState<Recording | null>(null)

  useEffect(() => {
    loadCameras()
  }, [])

  const handleSearch = async () => {
    if (!selectedCamera) { toast.error('Selecciona una cámara'); return }
    setIsSearching(true)
    setPlaybackUrl(null)
    try {
      const result = await apiGet<{ recordings: Recording[] }>('/recordings/search', {
        cameraId: selectedCamera,
        startTime: new Date(startDate).toISOString(),
        endTime: new Date(endDate).toISOString(),
      })
      setRecordings(result.recordings)
      if (result.recordings.length === 0) toast('Sin grabaciones en ese rango', { icon: 'ℹ️' })
    } finally {
      setIsSearching(false)
    }
  }

  const handlePlay = async (rec: Recording) => {
    setSelectedRec(rec)
    try {
      const result = await apiPost<{ url: string }>('/recordings/playback', {
        cameraId: selectedCamera,
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

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <h2 className="text-base font-semibold text-surface-100">Grabaciones</h2>

      {/* Filtros */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          {/* Cámara */}
          <div className="sm:col-span-1">
            <label className="label">Cámara</label>
            <div className="relative">
              <select
                value={selectedCamera}
                onChange={(e) => setSelectedCamera(e.target.value)}
                className="input appearance-none pr-8"
              >
                <option value="">Seleccionar cámara</option>
                {cameras.map((cam) => (
                  <option key={cam.id} value={cam.id}>
                    {cam.nvr?.name} — {cam.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
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

          {/* Botón buscar */}
          <div className="flex items-end">
            <button
              onClick={handleSearch}
              disabled={isSearching}
              className="btn-primary w-full justify-center"
            >
              {isSearching ? (
                <span className="animate-spin">⟳</span>
              ) : (
                <Search size={14} />
              )}
              {isSearching ? 'Buscando...' : 'Buscar'}
            </button>
          </div>
        </div>

        {/* Shortcuts de fechas */}
        <div className="flex gap-2 mt-3 flex-wrap">
          {[
            { label: 'Última hora', hours: 1 },
            { label: 'Hoy', hours: 24 },
            { label: 'Ayer', hours: 48 },
            { label: 'Últimos 7 días', hours: 168 },
          ].map(({ label, hours }) => (
            <button
              key={label}
              onClick={() => {
                setEndDate(format(new Date(), "yyyy-MM-dd'T'HH:mm"))
                setStartDate(format(subDays(new Date(), hours / 24), "yyyy-MM-dd'T'HH:mm"))
              }}
              className="text-xs px-2.5 py-1 rounded-md bg-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-600 transition-colors"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

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
          <div className="divide-y divide-surface-700 max-h-96 overflow-auto">
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
                  key={rec.id}
                  className={clsx(
                    'px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-surface-700/50 transition-colors',
                    selectedRec?.id === rec.id && 'bg-surface-700/80'
                  )}
                  onClick={() => handlePlay(rec)}
                >
                  <div className="w-8 h-8 rounded-lg bg-brand-900/50 flex items-center justify-center flex-shrink-0">
                    <Play size={12} className="text-brand-400 fill-brand-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-surface-100">
                      {format(new Date(rec.startTime), 'dd/MM/yyyy HH:mm:ss')}
                    </div>
                    <div className="text-xs text-surface-400 flex items-center gap-2 mt-0.5">
                      <span className="flex items-center gap-1">
                        <Clock size={10} /> {formatDuration(rec.startTime, rec.endTime)}
                      </span>
                      <span>{formatSize(rec.size)}</span>
                    </div>
                  </div>
                  <button
                    className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-600 transition-colors"
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
                ? `Reproduciendo: ${format(new Date(selectedRec.startTime), 'dd/MM HH:mm')}`
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
                    ? 'Selecciona una grabación'
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
