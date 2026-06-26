// apps/web/src/components/recordings/RecordingCameraTree.tsx
import { useState } from 'react'
import { clsx } from 'clsx'
import { Search, ChevronDown, ChevronRight, CheckSquare, Square } from 'lucide-react'
import type { NVR, Camera } from '@/types'
import type { NvrSearchError } from './types'

interface Props {
  nvrs: NVR[]
  cameras: Camera[]
  selectedCameras: Set<string>
  nvrErrors: NvrSearchError[]
  onToggleCamera: (cameraId: string) => void
  onToggleNVR: (nvrId: string) => void
  onSelectAll: () => void
  onClearAll: () => void
  onAssignCamera?: (cameraId: string) => void
}

export function RecordingCameraTree({
  nvrs, cameras, selectedCameras, nvrErrors,
  onToggleCamera, onToggleNVR, onSelectAll, onClearAll,
  onAssignCamera,
}: Props) {
  const [query, setQuery]             = useState('')
  const [collapsed, setCollapsed]     = useState<Set<string>>(new Set())

  const toggleCollapse = (nvrId: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(nvrId) ? next.delete(nvrId) : next.add(nvrId)
      return next
    })

  // Group cameras by NVR
  const groups = nvrs
    .map(nvr => ({
      nvr,
      cameras: cameras
        .filter(c => c.nvrId === nvr.id)
        .filter(c => !query || c.name.toLowerCase().includes(query.toLowerCase())),
      error: nvrErrors.find(e => e.nvrId === nvr.id),
    }))
    .filter(g => g.cameras.length > 0)

  const totalFiltered = groups.reduce((n, g) => n + g.cameras.length, 0)

  return (
    <div className="flex flex-col h-full min-h-0 text-sm">

      {/* Header */}
      <div className="px-3 py-2 border-b border-surface-700 flex-shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500 mb-1.5">Cámaras</p>
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-surface-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar cámara…"
            className="w-full pl-6 pr-2 py-1 text-xs bg-surface-800 border border-surface-700 rounded-md text-surface-200 placeholder-surface-600 focus:outline-none focus:border-brand-600"
          />
        </div>
      </div>

      {/* Sel. all / clear */}
      <div className="px-3 py-1.5 border-b border-surface-700 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onSelectAll}
          className="text-[10px] text-brand-400 hover:text-brand-300 transition-colors"
        >
          Sel. todas
        </button>
        <span className="text-surface-700">·</span>
        <button
          onClick={onClearAll}
          className="text-[10px] text-surface-500 hover:text-surface-300 transition-colors"
        >
          Limpiar
        </button>
        <span className="ml-auto text-[10px] text-surface-600 tabular-nums">
          {selectedCameras.size}/{totalFiltered}
        </span>
      </div>

      {/* Camera groups */}
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-[10px] text-surface-600">
              {query ? 'Sin coincidencias' : 'Sin cámaras disponibles'}
            </p>
          </div>
        ) : (
          groups.map(({ nvr, cameras: cams, error }) => {
            const allSel  = cams.every(c => selectedCameras.has(c.id))
            const someSel = !allSel && cams.some(c => selectedCameras.has(c.id))
            const isOpen  = !collapsed.has(nvr.id)

            return (
              <div key={nvr.id}>
                {/* NVR group header */}
                <button
                  onClick={() => toggleCollapse(nvr.id)}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-surface-800/60 hover:bg-surface-750 transition-colors text-left border-b border-surface-700/60"
                >
                  {isOpen
                    ? <ChevronDown size={11} className="text-surface-500 flex-shrink-0" />
                    : <ChevronRight size={11} className="text-surface-500 flex-shrink-0" />
                  }

                  {/* NVR checkbox (toggle all) */}
                  <span
                    onClick={e => { e.stopPropagation(); onToggleNVR(nvr.id) }}
                    className="flex-shrink-0"
                  >
                    {allSel
                      ? <CheckSquare size={12} className="text-brand-400" />
                      : someSel
                        ? <CheckSquare size={12} className="text-brand-400/50" />
                        : <Square size={12} className="text-surface-600" />
                    }
                  </span>

                  <span className="text-[10px] font-semibold text-surface-300 uppercase tracking-wide truncate">
                    {nvr.name}
                  </span>

                  {error?.code === 'ISAPI_UNSUPPORTED' && (
                    <span className="ml-1 flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-500">
                      sin ISAPI
                    </span>
                  )}

                  <span className="ml-auto text-[10px] text-surface-600 flex-shrink-0">
                    {cams.length}
                  </span>
                </button>

                {/* Camera items */}
                {isOpen && cams.map(cam => {
                  const selected = selectedCameras.has(cam.id)
                  return (
                    <button
                      key={cam.id}
                      onClick={() => { onToggleCamera(cam.id); onAssignCamera?.(cam.id) }}
                      title={onAssignCamera ? 'Clic para seleccionar y asignar al slot activo' : cam.name}
                      className={clsx(
                        'w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-left transition-colors border-b border-surface-800/40',
                        selected
                          ? 'bg-brand-900/20 hover:bg-brand-900/30'
                          : 'hover:bg-surface-700/30'
                      )}
                    >
                      {selected
                        ? <CheckSquare size={12} className="text-brand-400 flex-shrink-0" />
                        : <Square size={12} className="text-surface-600 flex-shrink-0" />
                      }
                      <span className={clsx(
                        'text-xs truncate flex-1',
                        selected ? 'text-surface-100' : 'text-surface-400'
                      )}>
                        {cam.name}
                      </span>
                      {/* Online indicator */}
                      <span className={clsx(
                        'flex-shrink-0 text-[10px]',
                        cam.online ? 'text-green-500' : 'text-surface-700'
                      )}>
                        ●
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
