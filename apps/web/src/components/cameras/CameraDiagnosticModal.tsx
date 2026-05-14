// src/components/cameras/CameraDiagnosticModal.tsx
import { useEffect, useState } from 'react'
import { X, Loader2, CheckCircle2, XCircle, AlertTriangle, Copy, RefreshCw } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import type { CameraDiagnostics } from '@/types'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'

interface Props {
  cameraId: string
  cameraName: string
  onClose: () => void
  onRestartStream?: () => void
}

type LayerStatus = 'ok' | 'error' | 'warn' | 'unknown'

interface Layer {
  label: string
  status: LayerStatus
  detail?: string
}

function LayerRow({ layer }: { layer: Layer }) {
  const icons = {
    ok:      <CheckCircle2 size={14} className="text-green-400 flex-shrink-0" />,
    error:   <XCircle size={14} className="text-red-400 flex-shrink-0" />,
    warn:    <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />,
    unknown: <div className="w-3.5 h-3.5 rounded-full border border-surface-600 flex-shrink-0" />,
  }

  return (
    <div className="flex items-start gap-2.5 py-2 border-b border-surface-700/50 last:border-0">
      {icons[layer.status]}
      <div className="flex-1 min-w-0">
        <div className={clsx('text-xs font-medium', {
          'text-green-300': layer.status === 'ok',
          'text-red-300': layer.status === 'error',
          'text-amber-300': layer.status === 'warn',
          'text-surface-400': layer.status === 'unknown',
        })}>
          {layer.label}
        </div>
        {layer.detail && (
          <div className="text-[10px] text-surface-500 mt-0.5 font-mono break-all">{layer.detail}</div>
        )}
      </div>
    </div>
  )
}

function buildLayers(diag: CameraDiagnostics): Layer[] {
  const layers: Layer[] = []

  // NVR HTTP
  layers.push({
    label: `NVR HTTP — ${diag.nvr.name} (${diag.camera.channelNumber ? `D${diag.camera.channelNumber}` : 'canal'})`,
    status: diag.nvr.onlineHttp ? 'ok' : 'error',
    detail: diag.nvr.onlineHttp ? undefined : `NVR no responde en HTTP. Última conexión: ${diag.nvr.lastSeen ? new Date(diag.nvr.lastSeen).toLocaleString('es-PY') : 'nunca'}`,
  })

  // Canal en NVR
  layers.push({
    label: `Canal detectado: ${diag.camera.name}`,
    status: diag.camera.onlineInNvr ? 'ok' : 'warn',
    detail: diag.camera.onlineInNvr ? `${diag.camera.preferredStream === 'main' ? 'Main stream' : 'Substream'} preferido` : 'Cámara figura offline en el NVR',
  })

  // RTSP main
  layers.push({
    label: `RTSP main — ${diag.rtsp.mainUrlMasked}`,
    status: diag.rtsp.mainOk ? 'ok' : 'error',
    detail: diag.rtsp.mainOk
      ? `${diag.rtsp.mainCodec?.toUpperCase() || '?'} ${diag.rtsp.mainResolution || ''} ${diag.rtsp.mainFps || ''}fps${diag.rtsp.mainLatencyMs ? ` · ${diag.rtsp.mainLatencyMs}ms` : ''}`
      : (diag.rtsp.mainError || 'Sin respuesta RTSP'),
  })

  // RTSP sub
  layers.push({
    label: `RTSP sub — ${diag.rtsp.subUrlMasked}`,
    status: diag.rtsp.subOk ? 'ok' : 'error',
    detail: diag.rtsp.subOk
      ? `${diag.rtsp.subCodec?.toUpperCase() || '?'} ${diag.rtsp.subResolution || ''} ${diag.rtsp.subFps || ''}fps${diag.rtsp.subLatencyMs ? ` · ${diag.rtsp.subLatencyMs}ms` : ''}`
      : (diag.rtsp.subError || 'Sin respuesta RTSP sub'),
  })

  // Codec check
  const codec = diag.rtsp.subOk ? diag.rtsp.subCodec : diag.rtsp.mainCodec
  if (codec) {
    const isHevc = codec.toLowerCase().includes('hevc') || codec.toLowerCase().includes('h265') || codec.toLowerCase() === 'h265'
    layers.push({
      label: `Codec: ${codec.toUpperCase()}`,
      status: isHevc ? 'warn' : 'ok',
      detail: isHevc ? 'H.265/HEVC no es compatible con HLS.js en browsers. Requiere transcodificación.' : undefined,
    })
  }

  // MediaMTX
  layers.push({
    label: `MediaMTX — ${diag.mediaServer.route}`,
    status: !diag.mediaServer.routeExists ? 'error' : diag.mediaServer.ready ? 'ok' : 'warn',
    detail: !diag.mediaServer.routeExists
      ? 'Ruta no existe en MediaMTX. Hacer sync del NVR.'
      : diag.mediaServer.ready
        ? `Activo · ${diag.mediaServer.readers} viewer(s)`
        : 'Ruta existe pero sin source activo (RTSP no conectado)',
  })

  // HLS URL
  layers.push({
    label: `HLS Playback`,
    status: diag.mediaServer.ready ? 'ok' : 'error',
    detail: diag.frontend.hlsUrl,
  })

  return layers
}

export function CameraDiagnosticModal({ cameraId, cameraName, onClose, onRestartStream }: Props) {
  const [loading, setLoading] = useState(true)
  const [diag, setDiag] = useState<CameraDiagnostics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  const run = async () => {
    setLoading(true)
    setError(null)
    setDiag(null)
    try {
      const result = await apiGet<CameraDiagnostics>(`/cameras/${cameraId}/diagnostics`)
      setDiag(result)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Error al obtener diagnóstico')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { run() }, [cameraId])

  const handleRestartStream = async () => {
    setRestarting(true)
    try {
      await apiPost(`/cameras/${cameraId}/restart-stream`, {})
      toast.success('Stream reiniciado')
      onRestartStream?.()
      setTimeout(() => run(), 2000)
    } catch {
      toast.error('Error al reiniciar stream')
    } finally {
      setRestarting(false)
    }
  }

  const handleCopy = () => {
    if (!diag) return
    const text = [
      `Diagnóstico: ${cameraName}`,
      `NVR: ${diag.nvr.name} (HTTP: ${diag.nvr.onlineHttp ? 'OK' : 'FAIL'})`,
      `Canal: ${diag.camera.name} — online: ${diag.camera.onlineInNvr}`,
      `RTSP main: ${diag.rtsp.mainOk ? 'OK' : 'FAIL'} ${diag.rtsp.mainError || ''}`,
      `RTSP sub: ${diag.rtsp.subOk ? 'OK' : 'FAIL'} ${diag.rtsp.subError || ''}`,
      `MediaMTX: ${diag.mediaServer.routeExists ? (diag.mediaServer.ready ? 'OK' : 'NO SOURCE') : 'NO ROUTE'}`,
      `HLS: ${diag.frontend.hlsUrl}`,
    ].join('\n')
    navigator.clipboard.writeText(text)
    toast.success('Diagnóstico copiado')
  }

  const layers = diag ? buildLayers(diag) : []
  const hasError = layers.some((l) => l.status === 'error')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="card w-full max-w-lg p-0 animate-slide-in shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <div>
            <div className="text-sm font-semibold text-surface-100">Diagnóstico de cámara</div>
            <div className="text-xs text-surface-400 mt-0.5">{cameraName}</div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={run} className="btn-ghost p-1.5" title="Volver a ejecutar">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={handleCopy} disabled={!diag} className="btn-ghost p-1.5" title="Copiar diagnóstico">
              <Copy size={13} />
            </button>
            <button onClick={onClose} className="btn-ghost p-1.5">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 max-h-[70vh] overflow-y-auto">
          {loading && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 size={24} className="text-brand-400 animate-spin" />
              <span className="text-xs text-surface-400">Probando capas de streaming...</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-900/20 rounded-lg text-red-400 text-xs">
              <XCircle size={14} />
              {error}
            </div>
          )}

          {diag && !loading && (
            <div className="space-y-1">
              {/* Resumen */}
              <div className={clsx(
                'flex items-center gap-2 px-3 py-2 rounded-lg mb-3 text-xs font-medium',
                hasError ? 'bg-red-900/20 text-red-300' : 'bg-green-900/20 text-green-300'
              )}>
                {hasError ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
                {hasError ? 'Se detectaron problemas en el pipeline de streaming' : 'Todas las capas funcionan correctamente'}
              </div>

              {/* Capas */}
              {layers.map((layer, i) => (
                <LayerRow key={i} layer={layer} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {diag && (
          <div className="px-4 py-3 border-t border-surface-700 flex gap-2 justify-end">
            <button
              onClick={handleRestartStream}
              disabled={restarting}
              className="btn-secondary text-xs"
            >
              {restarting ? <><RefreshCw size={11} className="animate-spin" /> Reiniciando...</> : <><RefreshCw size={11} /> Reiniciar stream</>}
            </button>
            <button onClick={onClose} className="btn-primary text-xs">Cerrar</button>
          </div>
        )}
      </div>
    </div>
  )
}
