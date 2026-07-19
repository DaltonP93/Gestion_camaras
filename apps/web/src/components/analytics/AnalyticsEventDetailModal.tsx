// AnalyticsEventDetailModal — visor ampliado de un evento de analítica, reutilizable
// en Eventos, Snapshots y Forense. Muestra la imagen grande + metadatos completos
// (cámara, NVR, tipo, clase, confianza, zona/línea, dirección, trackId, incidentId,
// fecha local y UTC), con descargar snapshot, abrir grabación y navegación
// anterior/siguiente. Cierra con Escape o clic fuera.
import { useEffect, useRef, useState } from 'react'
import { X, Download, Film, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, Minimize2 } from 'lucide-react'

export interface AnalyticsEventLike {
  id: string
  cameraId: string
  cameraName: string
  nvrName: string
  type: string
  className: string
  confidence: number
  zoneName: string | null
  direction: string | null
  trackId?: number | null
  incidentId?: string | null
  snapshotUrl: string | null
  occurredAt: string
}

interface Props {
  event: AnalyticsEventLike
  typeLabels: Record<string, string>
  classLabels: Record<string, string>
  resolveAssetUrl: (url: string | null | undefined) => string | null
  onClose: () => void
  onOpenRecording: (ev: AnalyticsEventLike) => void
  onPrev?: () => void   // undefined = sin anterior
  onNext?: () => void   // undefined = sin siguiente
}

export function AnalyticsEventDetailModal({
  event, typeLabels, classLabels, resolveAssetUrl, onClose, onOpenRecording, onPrev, onNext,
}: Props) {
  // Teclado: Escape cierra, ← → navegan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && onPrev) onPrev()
      else if (e.key === 'ArrowRight' && onNext) onNext()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  // Zoom / pan / pantalla completa de la imagen.
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  // Reiniciar el zoom al cambiar de evento (prev/next).
  useEffect(() => { setScale(1); setPan({ x: 0, y: 0 }) }, [event.id])
  const zoomBy = (f: number) => setScale(s => Math.min(6, Math.max(1, +(s * f).toFixed(2))))
  const resetZoom = () => { setScale(1); setPan({ x: 0, y: 0 }) }

  const img = resolveAssetUrl(event.snapshotUrl)
  const occurred = new Date(event.occurredAt)

  const meta: Array<[string, string | number | null | undefined]> = [
    ['Tipo', typeLabels[event.type] ?? event.type],
    ['Clase', classLabels[event.className] ?? event.className],
    ['Confianza', `${Math.round((event.confidence ?? 0) * 100)}%`],
    [event.type === 'line_crossing' ? 'Línea' : 'Zona', event.zoneName],
    ['Dirección', event.direction ? (event.direction === 'in' ? 'entrada' : 'salida') : null],
    ['Track', event.trackId ?? null],
    ['Incidente', event.incidentId ?? null],
    ['Cámara', event.cameraName],
    ['NVR', event.nvrName],
    ['Local', occurred.toLocaleString('es')],
    ['UTC', occurred.toISOString()],
  ]

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`bg-surface-900 border border-surface-700 rounded-xl w-full overflow-hidden ${fullscreen ? 'max-w-[98vw]' : 'max-w-4xl'}`} onClick={e => e.stopPropagation()}>
        {/* Encabezado */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-800">
          <span className="text-sm text-surface-200 font-medium truncate">{event.cameraName}</span>
          <span className="text-xs text-surface-500 truncate">{event.nvrName}</span>
          <div className="flex-1" />
          {img && <>
            <button onClick={() => zoomBy(1 / 1.4)} title="Alejar" className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-800"><ZoomOut size={15} /></button>
            <span className="text-[10px] text-surface-500 w-8 text-center">{Math.round(scale * 100)}%</span>
            <button onClick={() => zoomBy(1.4)} title="Acercar" className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-800"><ZoomIn size={15} /></button>
            <button onClick={() => setFullscreen(f => !f)} title="Pantalla completa" className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-800">{fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          </>}
          {onPrev && (
            <button onClick={onPrev} title="Anterior (←)" className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-800"><ChevronLeft size={16} /></button>
          )}
          {onNext && (
            <button onClick={onNext} title="Siguiente (→)" className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-800"><ChevronRight size={16} /></button>
          )}
          <button onClick={onClose} title="Cerrar (Esc)" className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-800"><X size={16} /></button>
        </div>

        {/* Imagen con zoom/pan (rueda = zoom; arrastrar = paneo cuando hay zoom) */}
        {img
          ? <div
              className={`w-full bg-black overflow-hidden ${fullscreen ? 'max-h-[80vh]' : 'max-h-[55vh]'} ${scale > 1 ? 'cursor-grab' : ''}`}
              style={{ height: fullscreen ? '80vh' : '55vh' }}
              onWheel={(e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15) }}
              onDoubleClick={resetZoom}
              onMouseDown={(e) => { if (scale > 1) dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y } }}
              onMouseMove={(e) => { if (dragRef.current) setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y }) }}
              onMouseUp={() => { dragRef.current = null }}
              onMouseLeave={() => { dragRef.current = null }}
            >
              <img src={img} alt="" draggable={false}
                className="w-full h-full object-contain select-none"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transition: dragRef.current ? 'none' : 'transform 0.05s' }} />
            </div>
          : <div className="w-full h-64 bg-black flex items-center justify-center text-xs text-surface-600">Sin imagen para este evento</div>}

        {/* Metadatos */}
        <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
          {meta.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([label, value]) => (
            <div key={label} className="min-w-0">
              <span className="text-surface-500">{label}: </span>
              <span className="text-surface-200 break-words">{String(value)}</span>
            </div>
          ))}
        </div>

        {/* Acciones */}
        <div className="px-4 py-2.5 border-t border-surface-800 flex items-center gap-4 text-xs">
          {img && (
            <a href={img} download className="flex items-center gap-1 text-brand-300 hover:text-brand-200"><Download size={13} /> Descargar snapshot</a>
          )}
          <button onClick={() => onOpenRecording(event)} className="flex items-center gap-1 text-brand-300 hover:text-brand-200"><Film size={13} /> Ver grabación</button>
        </div>
      </div>
    </div>
  )
}
