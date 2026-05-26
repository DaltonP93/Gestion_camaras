// src/pages/NVRDetailPage.tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Power, Wifi, WifiOff,
  HardDrive, Camera, Users, Wrench, Activity,
  ChevronRight, AlertTriangle, CheckCircle2, XCircle,
  Loader2, Play, RotateCcw, Stethoscope, Plus, X,
} from 'lucide-react'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import type { NVR, Camera as CameraType, NvrHdd, IpCamera, CameraDiagnostics } from '@/types'
import { clsx } from 'clsx'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

type Tab = 'summary' | 'cameras' | 'storage' | 'users' | 'maintenance' | 'diagnostics'

export function NVRDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [tab, setTab] = useState<Tab>('summary')
  const [nvr, setNvr] = useState<NVR | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [rebooting, setRebooting] = useState(false)
  const [validatingHealth, setValidatingHealth] = useState(false)

  // Tabs data
  const [cameras, setCameras] = useState<{ fromNvr: IpCamera[]; fromDb: CameraType[] } | null>(null)
  const [loadingCameras, setLoadingCameras] = useState(false)
  const [hdds, setHdds] = useState<NvrHdd[]>([])
  const [loadingStorage, setLoadingStorage] = useState(false)
  const [nvrUsers, setNvrUsers] = useState<any[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [diagCamera, setDiagCamera] = useState<string>('')
  const [diagResult, setDiagResult] = useState<CameraDiagnostics | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)

  const isAdmin = user?.role === 'ADMIN'
  const isSupervisor = user?.role === 'SUPERVISOR' || isAdmin

  useEffect(() => {
    if (!id) return
    loadNvr()
  }, [id])

  useEffect(() => {
    if (!id || !nvr) return
    if (tab === 'cameras' && !cameras) loadCameras()
    if (tab === 'storage') loadStorage()
    if (tab === 'users' && nvrUsers.length === 0) loadUsers()
  }, [tab, nvr])

  const loadNvr = async () => {
    try {
      setLoading(true)
      const data = await apiGet<NVR>(`/nvrs/${id}`)
      setNvr(data)
    } catch {
      toast.error('No se pudo cargar el NVR')
      navigate('/nvrs')
    } finally {
      setLoading(false)
    }
  }

  const loadCameras = async () => {
    try {
      setLoadingCameras(true)
      const data = await apiGet<{ fromNvr: IpCamera[]; fromDb: CameraType[] }>(`/nvrs/${id}/cameras`)
      setCameras(data)
    } catch {
      toast.error('Error al cargar cámaras del NVR')
    } finally {
      setLoadingCameras(false)
    }
  }

  const loadStorage = async () => {
    try {
      setLoadingStorage(true)
      const data = await apiGet<{ disks: NvrHdd[] }>(`/nvrs/${id}/storage`)
      setHdds(data.disks)
    } catch {
      toast.error('Error al cargar almacenamiento')
    } finally {
      setLoadingStorage(false)
    }
  }

  const loadUsers = async () => {
    try {
      setLoadingUsers(true)
      const data = await apiGet<{ users: any[] }>(`/nvrs/${id}/users`)
      setNvrUsers(data.users)
    } catch {
      toast.error('Error al cargar usuarios del NVR')
    } finally {
      setLoadingUsers(false)
    }
  }

  const handleSync = async () => {
    if (!id) return
    try {
      setSyncing(true)
      const result = await apiPost<any>(`/nvrs/${id}/sync`)
      toast.success(`Sincronizado: ${result.cameras} cámaras, ${result.hdds} HDDs`)
      await loadNvr()
      setCameras(null)
    } catch {
      toast.error('Error en sincronización')
    } finally {
      setSyncing(false)
    }
  }

  const handleForceNamesSync = async () => {
    if (!id) return
    try {
      setSyncing(true)
      const result = await apiPost<{ log: any[]; synced: number; debug?: any }>(`/nvrs/${id}/force-names-sync`)
      const updated = result.synced ?? result.log?.length ?? 0
      const dbg = result.debug
      const debugSummary = dbg
        ? ` | InputProxy: ${dbg.inputProxy?.count ?? '?'}, VideoInput: ${dbg.videoInput?.count ?? '?'}, Streaming: ${dbg.streaming?.count ?? '?'}${dbg.streamingProxy ? `, StreamingProxy: ${dbg.streamingProxy.count}` : ''}`
        : ''
      toast.success(`Nombres sincronizados: ${updated} cámaras${debugSummary}`)
      if (dbg) console.info('[force-names-sync] debug:', JSON.stringify(dbg, null, 2))
      setCameras(null)
    } catch (e: any) {
      toast.error('Error al sincronizar nombres')
      console.error('[force-names-sync] error:', e)
    } finally {
      setSyncing(false)
    }
  }

  const handleReboot = async () => {
    if (!confirm('¿Confirmas reiniciar el NVR? El dispositivo quedará inaccesible por ~1 minuto.')) return
    try {
      setRebooting(true)
      await apiPost(`/nvrs/${id}/reboot`)
      toast.success('NVR reiniciando...')
    } catch {
      toast.error('No se pudo reiniciar el NVR')
    } finally {
      setRebooting(false)
    }
  }

  const handleValidateHealth = async () => {
    if (!id) return
    try {
      setValidatingHealth(true)
      const result = await apiPost<{ validating: number }>(`/nvrs/${id}/validate-health`)
      toast.success(`Validando ${result.validating} cámaras RTSP en segundo plano. Re-sincroniza en ~30s para ver resultados.`)
    } catch {
      toast.error('Error al lanzar validación de salud RTSP')
    } finally {
      setValidatingHealth(false)
    }
  }

  const handleRestartStream = async (cameraId: string, cameraName: string) => {
    try {
      await apiPost(`/cameras/${cameraId}/restart-stream`)
      toast.success(`Stream de "${cameraName}" reiniciado`)
    } catch {
      toast.error('Error al reiniciar stream')
    }
  }

  const handleDiagnostics = async (cameraId: string) => {
    if (!cameraId) return
    setDiagLoading(true)
    setDiagResult(null)
    try {
      const result = await apiGet<CameraDiagnostics>(`/cameras/${cameraId}/diagnostics`)
      setDiagResult(result)
    } catch {
      toast.error('Error al obtener diagnóstico')
    } finally {
      setDiagLoading(false)
    }
  }

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'summary',     label: 'Resumen',       icon: <Activity size={14} /> },
    { id: 'cameras',     label: 'Cámaras IP',    icon: <Camera size={14} /> },
    { id: 'storage',     label: 'Almacenamiento', icon: <HardDrive size={14} /> },
    { id: 'users',       label: 'Usuarios NVR',  icon: <Users size={14} /> },
    { id: 'maintenance', label: 'Mantenimiento', icon: <Wrench size={14} /> },
    { id: 'diagnostics', label: 'Diagnóstico',   icon: <Stethoscope size={14} /> },
  ]

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-surface-400" />
      </div>
    )
  }

  if (!nvr) return null

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/nvrs')} className="btn-ghost p-2">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={clsx('w-2.5 h-2.5 rounded-full flex-shrink-0', nvr.online ? 'bg-green-400' : 'bg-red-500')} />
            <h1 className="text-lg font-semibold text-surface-100 truncate">{nvr.name}</h1>
            <span className="text-xs text-surface-500">{nvr.model}</span>
          </div>
          <p className="text-xs text-surface-500 ml-4">{nvr.ipAddress}:{nvr.port} · {nvr.channels} canales · {nvr.location}</p>
        </div>
        <div className="flex items-center gap-2">
          {isSupervisor && (
            <>
              <button onClick={handleSync} disabled={syncing} className="btn-secondary text-xs">
                {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {syncing ? 'Sincronizando...' : 'Sincronizar'}
              </button>
              <button onClick={handleForceNamesSync} disabled={syncing} className="btn-ghost text-xs" title="Forzar resincronización de nombres reales desde el NVR">
                <RefreshCw size={11} />
                Nombres
              </button>
              <button onClick={handleValidateHealth} disabled={validatingHealth} className="btn-ghost text-xs" title="Validar salud RTSP de todas las cámaras (detecta HEVC, 404, offline)">
                {validatingHealth ? <Loader2 size={11} className="animate-spin" /> : <Activity size={11} />}
                Revalidar RTSP
              </button>
            </>
          )}
          {isAdmin && (
            <button onClick={handleReboot} disabled={rebooting} className="btn-ghost text-xs text-red-400 hover:text-red-300">
              {rebooting ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
              Reiniciar
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-surface-700 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap',
              tab === t.id
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-surface-400 hover:text-surface-200'
            )}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'summary' && <SummaryTab nvr={nvr} />}
      {tab === 'cameras' && (
        <CamerasTab
          nvrId={nvr.id}
          cameras={cameras}
          loading={loadingCameras}
          onRefresh={loadCameras}
          onRestartStream={handleRestartStream}
          onDiagnostics={(cam) => { setDiagCamera(cam.id); setTab('diagnostics'); handleDiagnostics(cam.id) }}
          isAdmin={isAdmin}
        />
      )}
      {tab === 'storage' && <StorageTab hdds={hdds} loading={loadingStorage} onRefresh={loadStorage} />}
      {tab === 'users'   && <UsersTab users={nvrUsers} loading={loadingUsers} onRefresh={loadUsers} />}
      {tab === 'maintenance' && <MaintenanceTab nvr={nvr} onSync={handleSync} onReboot={handleReboot} onValidateHealth={handleValidateHealth} syncing={syncing} rebooting={rebooting} validatingHealth={validatingHealth} isAdmin={isAdmin} isSupervisor={isSupervisor} />}
      {tab === 'diagnostics' && (
        <DiagnosticsTab
          dbCameras={cameras?.fromDb || []}
          selectedId={diagCamera}
          onSelect={(id) => { setDiagCamera(id); handleDiagnostics(id) }}
          result={diagResult}
          loading={diagLoading}
        />
      )}
    </div>
  )
}

// ─── Summary Tab ──────────────────────────────────────────────

function SummaryTab({ nvr }: { nvr: NVR }) {
  const fields = [
    ['Modelo',          nvr.model],
    ['Número de serie', nvr.serialNumber || '—'],
    ['Firmware',        nvr.firmware || '—'],
    ['Versión web',     nvr.webVersion || '—'],
    ['Versión encoding',nvr.encodingVersion || '—'],
    ['IP / Puerto HTTP',`${nvr.ipAddress}:${nvr.port}`],
    ['Puerto RTSP',     String(nvr.rtspPort)],
    ['Puerto SDK',      String(nvr.sdkPort || 8000)],
    ['Canales',         String(nvr.channels)],
    ['HDDs',            String(nvr.hddCount)],
    ['Ubicación',       nvr.location || '—'],
    ['Última conexión', nvr.lastSeen ? format(new Date(nvr.lastSeen), 'dd/MM/yyyy HH:mm:ss') : '—'],
    ['Última sync',     nvr.lastSyncAt ? format(new Date(nvr.lastSyncAt), 'dd/MM/yyyy HH:mm:ss') : '—'],
  ]

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="card p-4">
        <h3 className="text-sm font-medium text-surface-300 mb-3">Información del dispositivo</h3>
        <dl className="space-y-2">
          {fields.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <dt className="text-xs text-surface-500">{label}</dt>
              <dd className="text-xs text-surface-200 font-medium text-right truncate max-w-[60%]">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-medium text-surface-300 mb-3">Estado</h3>
        <div className="flex items-center gap-2 mb-4">
          {nvr.online
            ? <><CheckCircle2 size={16} className="text-green-400" /><span className="text-sm text-green-400 font-medium">Online</span></>
            : <><XCircle size={16} className="text-red-500" /><span className="text-sm text-red-400 font-medium">Offline</span></>
          }
        </div>
        {nvr.hdds && nvr.hdds.length > 0 && (
          <>
            <h4 className="text-xs text-surface-500 mb-2">HDDs</h4>
            {nvr.hdds.map(hdd => (
              <div key={hdd.diskNumber} className="mb-2">
                <div className="flex justify-between text-xs text-surface-400 mb-1">
                  <span>HDD {hdd.diskNumber}</span>
                  <span>{hdd.usedPercent?.toFixed(0) || 0}% usado</span>
                </div>
                <div className="h-1.5 bg-surface-700 rounded-full overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full', (hdd.usedPercent || 0) > 90 ? 'bg-red-500' : (hdd.usedPercent || 0) > 75 ? 'bg-yellow-500' : 'bg-green-500')}
                    style={{ width: `${hdd.usedPercent || 0}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-surface-600 mt-0.5">
                  <span>{hdd.freeGb?.toFixed(0)} GB libres</span>
                  <span>{hdd.capacityGb?.toFixed(0)} GB total</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Camera status helper ─────────────────────────────────────

function camStatusDisplay(cam: CameraType): { color: string; dot: string; label: string } {
  const hs = cam.streamHealthStatus
  if (hs === 'CODEC_UNSUPPORTED_HEVC')
    return cam.rtspMainOk
      ? { color: 'text-amber-400', dot: 'bg-amber-400', label: 'HEVC / sub no disponible' }
      : { color: 'text-amber-400', dot: 'bg-amber-400', label: 'HEVC no compatible' }
  if (hs === 'RTSP_SUB_NOT_FOUND') {
    const mainIsHevc = (cam.mainCodec || '').toLowerCase().match(/hevc|h\.?265/)
    return mainIsHevc
      ? { color: 'text-amber-400', dot: 'bg-amber-400', label: 'Main HEVC / Sub no disp.' }
      : { color: 'text-orange-400', dot: 'bg-orange-400', label: 'Sub no encontrado' }
  }
  if (hs === 'AUTH_FAILED')     return { color: 'text-red-400',     dot: 'bg-red-500',     label: 'Auth fallida' }
  if (hs === 'OFFLINE')         return { color: 'text-red-400',     dot: 'bg-red-500',     label: 'Offline' }
  if (hs === 'STREAM_UNSTABLE') return { color: 'text-amber-400',   dot: 'bg-amber-400',   label: 'Inestable' }
  if (hs === 'HEALTHY' || hs === 'USING_MAIN_STREAM')
    return { color: 'text-green-400', dot: 'bg-green-400', label: 'Online' }
  // No health status yet — fall back to raw RTSP / online fields
  if (cam.rtspMainOk || cam.rtspSubOk) return { color: 'text-green-400', dot: 'bg-green-400', label: 'Online' }
  if (cam.mainCodec || cam.subCodec)   return { color: 'text-amber-400', dot: 'bg-amber-400', label: 'Detectado' }
  if (cam.online)                      return { color: 'text-green-400', dot: 'bg-green-400', label: 'Online' }
  return { color: 'text-surface-500', dot: 'bg-surface-600', label: 'Offline' }
}

// ─── Cameras Tab ──────────────────────────────────────────────

function CamerasTab({
  cameras, loading, onRefresh, onRestartStream, onDiagnostics, isAdmin, nvrId,
}: {
  cameras: { fromNvr: IpCamera[]; fromDb: CameraType[] } | null
  loading: boolean
  onRefresh: () => void
  onRestartStream: (id: string, name: string) => void
  onDiagnostics: (cam: CameraType) => void
  isAdmin: boolean
  nvrId: string
}) {
  const [showAdopt, setShowAdopt] = useState(false)

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  const list = cameras?.fromDb || []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-surface-400">{list.length} cámaras en base de datos · {cameras?.fromNvr.length || 0} detectadas en NVR</span>
        <div className="flex gap-2">
          {isAdmin && (
            <button onClick={() => setShowAdopt(true)} className="btn-primary text-xs">
              <Plus size={12} /> Adoptar cámara
            </button>
          )}
          <button onClick={onRefresh} className="btn-ghost text-xs"><RefreshCw size={12} /> Actualizar</button>
        </div>
      </div>

      {showAdopt && isAdmin && (
        <AdoptCameraModal
          nvrId={nvrId}
          onClose={() => setShowAdopt(false)}
          onSuccess={() => { setShowAdopt(false); onRefresh() }}
        />
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-surface-700 bg-surface-800/50">
              {['Canal', 'Código', 'Nombre', 'IP Cámara', 'Protocolo', 'Puerto', 'Seguridad', 'Estado', 'Codec', 'Resolución', 'Acciones'].map(h => (
                <th key={h} className="text-left px-3 py-2 text-surface-400 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-700/50">
            {list.map(cam => {
              const fromNvr = cameras?.fromNvr.find(n => n.channel === cam.channel)
              return (
                <tr key={cam.id} className="hover:bg-surface-700/30 transition-colors">
                  <td className="px-3 py-2 text-surface-300">{cam.channel}</td>
                  <td className="px-3 py-2 text-surface-400">{cam.channelCode || `D${cam.channel}`}</td>
                  <td className="px-3 py-2 text-surface-100 font-medium max-w-[120px] truncate">{cam.name}</td>
                  <td className="px-3 py-2 text-surface-400">{cam.ipAddress || fromNvr?.ipAddress || '—'}</td>
                  <td className="px-3 py-2 text-surface-400">{cam.protocol || fromNvr?.protocol || '—'}</td>
                  <td className="px-3 py-2 text-surface-400">{cam.managementPort || fromNvr?.managementPort || '—'}</td>
                  <td className="px-3 py-2 text-surface-400">{cam.securityStatus || fromNvr?.securityStatus || '—'}</td>
                  <td className="px-3 py-2">
                    {(() => { const s = camStatusDisplay(cam); return (
                      <span className={clsx('inline-flex items-center gap-1.5 text-xs', s.color)}>
                        <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', s.dot)} />
                        {s.label}
                      </span>
                    )})()}
                  </td>
                  <td className="px-3 py-2 text-surface-400">{cam.subCodec || cam.mainCodec || '—'}</td>
                  <td className="px-3 py-2 text-surface-400">{cam.subResolution || cam.mainResolution || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onDiagnostics(cam)}
                        className="p-1 rounded text-surface-400 hover:text-brand-400 hover:bg-surface-700 transition-colors"
                        title="Diagnóstico"
                      >
                        <Stethoscope size={11} />
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => onRestartStream(cam.id, cam.name)}
                          className="p-1 rounded text-surface-400 hover:text-yellow-400 hover:bg-surface-700 transition-colors"
                          title="Reiniciar stream"
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}
                      <Link
                        to={`/live?nvr=${cam.nvrId}`}
                        className="p-1 rounded text-surface-400 hover:text-green-400 hover:bg-surface-700 transition-colors"
                        title="Ver en vivo"
                      >
                        <Play size={11} />
                      </Link>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {list.length === 0 && (
          <div className="py-10 text-center text-surface-500 text-sm">
            Sin cámaras — Usa "Sincronizar" para importar desde el NVR
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Storage Tab ──────────────────────────────────────────────

function StorageTab({ hdds, loading, onRefresh }: { hdds: NvrHdd[]; loading: boolean; onRefresh: () => void }) {
  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={onRefresh} className="btn-ghost text-xs"><RefreshCw size={12} /> Actualizar</button>
      </div>

      {hdds.length === 0
        ? <div className="card p-8 text-center text-surface-500 text-sm">Sin datos de almacenamiento — Actualiza para obtener datos del NVR</div>
        : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {hdds.map(hdd => (
              <div key={hdd.diskNumber} className="card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <HardDrive size={16} className="text-surface-400" />
                    <span className="text-sm font-medium text-surface-200">HDD {hdd.diskNumber}</span>
                  </div>
                  <span className={clsx(
                    'text-xs px-2 py-0.5 rounded-full',
                    hdd.status?.toLowerCase().includes('normal') || hdd.status?.toLowerCase().includes('grabac')
                      ? 'bg-green-900/40 text-green-400'
                      : 'bg-surface-700 text-surface-400'
                  )}>
                    {hdd.status || 'Desconocido'}
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-surface-400">
                    <span>Uso</span>
                    <span className={clsx((hdd.usedPercent || 0) > 90 ? 'text-red-400' : (hdd.usedPercent || 0) > 75 ? 'text-yellow-400' : 'text-green-400')}>
                      {hdd.usedPercent?.toFixed(1) || 0}%
                    </span>
                  </div>
                  <div className="h-2 bg-surface-700 rounded-full overflow-hidden">
                    <div
                      className={clsx('h-full rounded-full transition-all', (hdd.usedPercent || 0) > 90 ? 'bg-red-500' : (hdd.usedPercent || 0) > 75 ? 'bg-yellow-500' : 'bg-green-500')}
                      style={{ width: `${hdd.usedPercent || 0}%` }}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {[
                      ['Capacidad', `${hdd.capacityGb?.toFixed(2) || 0} GB`],
                      ['Libre',     `${hdd.freeGb?.toFixed(2) || 0} GB`],
                      ['Tipo',      hdd.type || '—'],
                      ['Propiedad', hdd.property || '—'],
                      ['Proceso',   hdd.process || '—'],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <div className="text-xs text-surface-500">{k}</div>
                        <div className="text-xs text-surface-300">{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      }
    </div>
  )
}

// ─── Users Tab ────────────────────────────────────────────────

function UsersTab({ users, loading, onRefresh }: { users: any[]; loading: boolean; onRefresh: () => void }) {
  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  const levelLabel = (l: string) => {
    if (!l) return '—'
    if (l.toLowerCase().includes('admin')) return 'Administrador'
    if (l.toLowerCase().includes('oper')) return 'Operador'
    return l
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={onRefresh} className="btn-ghost text-xs"><RefreshCw size={12} /> Actualizar</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-surface-700 bg-surface-800/50">
              {['#', 'Usuario', 'Nivel', 'Estado'].map(h => (
                <th key={h} className="text-left px-4 py-2 text-surface-400 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-700/50">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-surface-700/30 transition-colors">
                <td className="px-4 py-2 text-surface-500">{u.id}</td>
                <td className="px-4 py-2 text-surface-100 font-medium">{u.name}</td>
                <td className="px-4 py-2 text-surface-400">{levelLabel(u.userLevel)}</td>
                <td className="px-4 py-2">
                  <span className="text-green-400 text-xs">● Activo</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="py-10 text-center text-surface-500 text-sm">Sin usuarios o el NVR no soporta este endpoint</div>
        )}
      </div>
    </div>
  )
}

// ─── Maintenance Tab ──────────────────────────────────────────

function MaintenanceTab({
  nvr, onSync, onReboot, onValidateHealth, syncing, rebooting, validatingHealth, isAdmin, isSupervisor,
}: {
  nvr: NVR
  onSync: () => void
  onReboot: () => void
  onValidateHealth: () => void
  syncing: boolean
  rebooting: boolean
  validatingHealth: boolean
  isAdmin: boolean
  isSupervisor: boolean
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="card p-4 space-y-3">
        <h3 className="text-sm font-medium text-surface-300">Sincronización</h3>
        <p className="text-xs text-surface-500">
          Obtiene nombres reales de cámaras, estado de HDDs, firmware y registra todos los streams en MediaMTX.
        </p>
        <button onClick={onSync} disabled={syncing} className="btn-primary w-full justify-center">
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Sincronizando...' : 'Sincronizar NVR completo'}
        </button>
        {nvr.lastSyncAt && (
          <p className="text-xs text-surface-500 text-center">
            Última sync: {format(new Date(nvr.lastSyncAt), 'dd/MM/yyyy HH:mm')}
          </p>
        )}
      </div>

      {isSupervisor && (
        <div className="card p-4 space-y-3">
          <h3 className="text-sm font-medium text-surface-300">Salud RTSP</h3>
          <p className="text-xs text-surface-500">
            Prueba la conexión RTSP de cada cámara y actualiza su estado de salud (detecta HEVC, substream 404, offline, credenciales inválidas).
          </p>
          <button onClick={onValidateHealth} disabled={validatingHealth} className="btn-secondary w-full justify-center">
            {validatingHealth ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
            {validatingHealth ? 'Lanzando validación...' : 'Revalidar RTSP de todas las cámaras'}
          </button>
          <p className="text-xs text-surface-500 text-center">
            La validación se ejecuta en segundo plano. Re-sincroniza en ~30s para ver resultados.
          </p>
        </div>
      )}

      {isAdmin && (
        <div className="card p-4 space-y-3 border border-red-900/30">
          <h3 className="text-sm font-medium text-red-400">Zona de peligro</h3>
          <p className="text-xs text-surface-500">
            El reinicio dejará el NVR inaccesible por aproximadamente 1 minuto. Todas las grabaciones en curso se interrumpirán.
          </p>
          <button
            onClick={onReboot}
            disabled={rebooting}
            className="w-full px-4 py-2 rounded-lg bg-red-900/30 border border-red-800/50 text-red-400 hover:bg-red-900/50 text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {rebooting ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {rebooting ? 'Reiniciando...' : 'Reiniciar dispositivo'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Diagnostics Tab ──────────────────────────────────────────

function DiagnosticsTab({
  dbCameras, selectedId, onSelect, result, loading,
}: {
  dbCameras: CameraType[]
  selectedId: string
  onSelect: (id: string) => void
  result: CameraDiagnostics | null
  loading: boolean
}) {
  const Check = ({ ok, label, detail }: { ok: boolean | null | 'warn'; label: string; detail?: string }) => (
    <div className="flex items-start gap-2 py-1.5">
      {ok === null
        ? <Loader2 size={14} className="animate-spin text-surface-400 mt-0.5 flex-shrink-0" />
        : ok === 'warn'
          ? <AlertTriangle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
          : ok
            ? <CheckCircle2 size={14} className="text-green-400 mt-0.5 flex-shrink-0" />
            : <XCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
      }
      <div>
        <span className={clsx('text-sm',
          ok === true    ? 'text-surface-200' :
          ok === 'warn'  ? 'text-amber-200'   :
          ok === null    ? 'text-surface-400'  : 'text-red-300'
        )}>{label}</span>
        {detail && <p className="text-xs text-surface-500 mt-0.5">{detail}</p>}
      </div>
    </div>
  )

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Selector de cámara */}
      <div className="card p-4">
        <h3 className="text-sm font-medium text-surface-300 mb-3">Seleccionar cámara</h3>
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {dbCameras.map(cam => (
            <button
              key={cam.id}
              onClick={() => onSelect(cam.id)}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg text-xs transition-colors',
                selectedId === cam.id ? 'bg-brand-900/40 border border-brand-700/50 text-brand-300' : 'hover:bg-surface-700/50 text-surface-300'
              )}
            >
              <div className="flex items-center gap-2">
                <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', cam.online ? 'bg-green-400' : 'bg-surface-600')} />
                <span className="font-medium truncate">{cam.name}</span>
                <span className="text-surface-500 ml-auto flex-shrink-0">{cam.channelCode || `D${cam.channel}`}</span>
              </div>
            </button>
          ))}
          {dbCameras.length === 0 && (
            <p className="text-xs text-surface-500 text-center py-4">Sincroniza el NVR primero</p>
          )}
        </div>
      </div>

      {/* Resultado */}
      <div className="lg:col-span-2 card p-4">
        {loading && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 size={24} className="animate-spin text-brand-400" />
            <p className="text-sm text-surface-400">Probando RTSP... puede tardar hasta 15s</p>
          </div>
        )}

        {!loading && !result && (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-surface-500">
            <Stethoscope size={32} className="text-surface-700" />
            <p className="text-sm">Selecciona una cámara para ver el diagnóstico</p>
          </div>
        )}

        {!loading && result && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-surface-100">{result.cameraName}</h3>
                <p className="text-xs text-surface-500">{result.channelCode} · {result.nvr.name}</p>
              </div>
            </div>

            <div className="space-y-1 divide-y divide-surface-700/30">
              <Check ok={result.nvr.onlineHttp} label="NVR HTTP conectado" detail={`Última conexión: ${result.nvr.lastSeen ? format(new Date(result.nvr.lastSeen), 'dd/MM HH:mm') : '—'}`} />
              <Check ok={result.camera.onlineInNvr} label={`Canal ${result.channelCode} online en NVR`} detail={result.camera.ipAddress ? `IP: ${result.camera.ipAddress} · ${result.camera.protocol}` : undefined} />
              <Check
                ok={result.rtsp.subOk}
                label="RTSP substream (sub)"
                detail={result.rtsp.subOk
                  ? `${result.rtsp.subCodec?.toUpperCase() || '?'} · ${result.rtsp.subResolution || '?'} · ${result.rtsp.subFps || '?'}fps · ${result.rtsp.subLatencyMs}ms`
                  : result.rtsp.subError || undefined
                }
              />
              <Check
                ok={result.rtsp.mainOk}
                label="RTSP main stream"
                detail={result.rtsp.mainOk
                  ? `${result.rtsp.mainCodec?.toUpperCase() || '?'} · ${result.rtsp.mainResolution || '?'} · ${result.rtsp.mainFps || '?'}fps`
                  : result.rtsp.mainError || undefined
                }
              />
              {(() => {
                const sc = (result.rtsp.subCodec || '').toLowerCase()
                const mc = (result.rtsp.mainCodec || '').toLowerCase()
                const subHevc = sc.includes('hevc') || sc.includes('h265') || sc.includes('h.265')
                const mainHevc = mc.includes('hevc') || mc.includes('h265') || mc.includes('h.265')
                if (result.rtsp.subOk && !subHevc)
                  return <Check ok={true} label="Codec compatible web" detail={`Sub H.264: ${result.rtsp.subCodec?.toUpperCase() || '?'} · ${result.rtsp.subResolution || '?'}`} />
                if (result.rtsp.mainOk && !mainHevc)
                  return <Check ok={true} label="Codec compatible web" detail={`Main H.264: ${result.rtsp.mainCodec?.toUpperCase() || '?'} · ${result.rtsp.mainResolution || '?'}`} />
                if (result.rtsp.mainOk && mainHevc)
                  return <Check ok={'warn'} label="Codec no compatible web (HEVC)" detail={`Main: ${result.rtsp.mainCodec?.toUpperCase() || 'HEVC'} — HLS/WebRTC solo soporta H.264`} />
                if (result.rtsp.subOk && subHevc)
                  return <Check ok={'warn'} label="Codec no compatible web (HEVC)" detail={`Sub: ${result.rtsp.subCodec?.toUpperCase() || 'HEVC'} — configura substream en H.264 en el NVR`} />
                return null
              })()}
              <Check
                ok={result.mediaServer.routeExists}
                label="MediaMTX route registrada"
                detail={`Route: ${result.mediaServer.route}`}
              />
              <Check
                ok={result.mediaServer.ready ? true : (result.mediaServer.routeExists ? 'warn' : false)}
                label="Stream activo en MediaMTX"
                detail={result.mediaServer.ready
                  ? `${result.mediaServer.readers} lectores activos`
                  : 'Sin lectores — se activa al reproducir (sourceOnDemand)'
                }
              />
              <Check ok={true} label="URL HLS generada" detail={result.frontend.hlsUrl} />
            </div>

            <div className="mt-4 pt-3 border-t border-surface-700/30">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-surface-500">Sub URL</span>
                  <p className="text-surface-400 font-mono truncate">{result.rtsp.subUrlMasked}</p>
                </div>
                <div>
                  <span className="text-surface-500">HLS playback</span>
                  <p className="text-surface-400 font-mono truncate">{result.frontend.hlsUrl}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Adopt Camera Modal ────────────────────────────────────────

function AdoptCameraModal({ nvrId, onClose, onSuccess }: { nvrId: string; onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({
    channel: 1, name: '', ipAddress: '', port: 8000,
    username: 'admin', password: '', protocol: 'HIKVISION',
  })
  const [freeChannels, setFreeChannels] = useState<number[]>([])
  const [loadingCh, setLoadingCh] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoadingCh(true)
    apiGet<{ freeChannels: number[] }>(`/nvrs/${nvrId}/free-channels`)
      .then(r => {
        setFreeChannels(r.freeChannels)
        if (r.freeChannels.length > 0) setForm(f => ({ ...f, channel: r.freeChannels[0] }))
      })
      .catch(() => {})
      .finally(() => setLoadingCh(false))
  }, [nvrId])

  const handleSave = async () => {
    if (!form.name || !form.ipAddress || !form.password) {
      toast.error('Nombre, IP y contraseña son obligatorios')
      return
    }
    setSaving(true)
    try {
      await apiPost(`/nvrs/${nvrId}/cameras/adopt`, form)
      toast.success(`Cámara "${form.name}" adoptada en canal ${form.channel}`)
      onSuccess()
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Error al adoptar la cámara')
    } finally {
      setSaving(false)
    }
  }

  const f = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = (e.target as HTMLInputElement).type === 'number' ? Number(e.target.value) : e.target.value
    setForm(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="card w-full max-w-md p-6 animate-slide-in shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold text-surface-100">Adoptar cámara IP</h3>
          <button onClick={onClose} className="btn-ghost p-1"><X size={14} /></button>
        </div>

        {loadingCh ? (
          <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-surface-400" /></div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="label">Canal destino en NVR</label>
              <select className="input w-full" value={form.channel} onChange={f('channel')}>
                {freeChannels.length === 0
                  ? <option value="">Sin canales libres</option>
                  : freeChannels.map(ch => <option key={ch} value={ch}>Canal {ch}</option>)
                }
              </select>
              {freeChannels.length === 0 && (
                <p className="text-xs text-amber-400 mt-1">Todos los canales están ocupados</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Nombre de cámara *</label>
                <input className="input" placeholder="Cámara Entrada" value={form.name} onChange={f('name')} />
              </div>
              <div>
                <label className="label">Protocolo</label>
                <select className="input w-full" value={form.protocol} onChange={f('protocol')}>
                  {['HIKVISION', 'ONVIF', 'DAHUA', 'AXIS', 'RTSP', 'OTHER'].map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="label">IP de la cámara *</label>
                <input className="input font-mono" placeholder="192.168.1.50" value={form.ipAddress} onChange={f('ipAddress')} />
              </div>
              <div>
                <label className="label">Puerto</label>
                <input className="input" type="number" value={form.port} onChange={f('port')} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Usuario</label>
                <input className="input" placeholder="admin" value={form.username} onChange={f('username')} />
              </div>
              <div>
                <label className="label">Contraseña *</label>
                <input className="input" type="password" placeholder="••••••••" value={form.password} onChange={f('password')} />
              </div>
            </div>
            <div className="flex gap-2 mt-5 justify-end">
              <button onClick={onClose} className="btn-secondary text-xs">Cancelar</button>
              <button onClick={handleSave} disabled={saving || freeChannels.length === 0} className="btn-primary text-xs">
                {saving ? <><Loader2 size={12} className="animate-spin" /> Adoptando...</> : <><Plus size={12} /> Adoptar cámara</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
