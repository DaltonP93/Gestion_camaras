// src/pages/NVRDetailPage.tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Power, Wifi, WifiOff,
  HardDrive, Camera, Users, Wrench, Activity,
  ChevronRight, AlertTriangle, CheckCircle2, XCircle,
  Loader2, Play, RotateCcw, Stethoscope, Plus, X,
  Pencil, Trash2, KeyRound, UserPlus, ShieldCheck, ShieldOff,
} from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
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
  const [syncingCameras, setSyncingCameras] = useState(false)

  // Tabs data
  const [cameras, setCameras] = useState<{ fromNvr: IpCamera[]; fromDb: CameraType[] } | null>(null)
  const [loadingCameras, setLoadingCameras] = useState(false)
  const [hdds, setHdds] = useState<NvrHdd[]>([])
  const [loadingStorage, setLoadingStorage] = useState(false)
  const [storageSupported, setStorageSupported] = useState<boolean | null>(null)
  const [storageUnsupportedReason, setStorageUnsupportedReason] = useState('')
  const [nvrUsers, setNvrUsers] = useState<any[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [usersSupported, setUsersSupported] = useState<boolean | null>(null)
  const [usersUnsupportedReason, setUsersUnsupportedReason] = useState('')
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
    if (tab === 'users') loadUsers()
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
      const data = await apiGet<{ disks: NvrHdd[]; supported?: boolean; reason?: string }>(`/nvrs/${id}/storage`)
      setHdds(data.disks)
      const sup = data.supported !== false
      setStorageSupported(sup)
      if (!sup) setStorageUnsupportedReason(data.reason || 'No soportado por este modelo/firmware')
    } catch {
      toast.error('Error al cargar almacenamiento')
      setStorageSupported(null)
    } finally {
      setLoadingStorage(false)
    }
  }

  const loadUsers = async () => {
    try {
      setLoadingUsers(true)
      const data = await apiGet<{ users: any[]; supported?: boolean; reason?: string }>(`/nvrs/${id}/users`)
      setNvrUsers(data.users)
      const sup = data.supported !== false
      setUsersSupported(sup)
      if (!sup) setUsersUnsupportedReason(data.reason || 'No soportado por este modelo/firmware')
    } catch {
      toast.error('Error al cargar usuarios del NVR')
      setUsersSupported(null)
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

  const handleSyncCameras = async () => {
    if (!id) return
    try {
      setSyncingCameras(true)
      const res = await apiPost<{ synced: number; total: number }>(`/nvrs/${id}/sync-cameras`)
      toast.success(`Cámaras IP sincronizadas: ${res.synced} actualizadas de ${res.total} detectadas`)
      setCameras(null)
    } catch (e: any) {
      const msg = e?.response?.data?.message || 'Error al sincronizar cámaras IP'
      toast.error(msg)
    } finally {
      setSyncingCameras(false)
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
          onSyncCameras={handleSyncCameras}
          syncingCameras={syncingCameras}
          onRestartStream={handleRestartStream}
          onDiagnostics={(cam) => { setDiagCamera(cam.id); setTab('diagnostics'); handleDiagnostics(cam.id) }}
          isAdmin={isAdmin}
          isapIStatus={nvr.isapIStatus}
        />
      )}
      {tab === 'storage' && <StorageTab hdds={hdds} loading={loadingStorage} supported={storageSupported} unsupportedReason={storageUnsupportedReason} onRefresh={loadStorage} />}
      {tab === 'users'   && <UsersTab nvrId={nvr.id} users={nvrUsers} loading={loadingUsers} supported={usersSupported} unsupportedReason={usersUnsupportedReason} onRefresh={loadUsers} isAdmin={isAdmin} />}
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
  // Per user spec: camera is effectively online if health confirmed OR any RTSP stream responded
  const effectiveOnline =
    hs === 'HEALTHY' || hs === 'USING_MAIN_STREAM' ||
    cam.rtspSubOk === true || cam.rtspMainOk === true

  if (hs === 'AUTH_FAILED') return { color: 'text-red-400', dot: 'bg-red-500', label: 'Auth fallida' }

  if (hs === 'CODEC_UNSUPPORTED_HEVC')
    return cam.rtspMainOk
      ? { color: 'text-amber-400', dot: 'bg-amber-400', label: 'Main HEVC (sin sub)' }
      : { color: 'text-amber-400', dot: 'bg-amber-400', label: 'HEVC no compatible' }

  if (hs === 'RTSP_SUB_NOT_FOUND') {
    const mainIsHevc = (cam.mainCodec || '').toLowerCase().match(/hevc|h\.?265/)
    return mainIsHevc
      ? { color: 'text-amber-400', dot: 'bg-amber-400', label: 'Main HEVC / Sin sub' }
      : { color: 'text-orange-400', dot: 'bg-orange-400', label: 'RTSP no encontrado' }
  }

  if (hs === 'OFFLINE')         return { color: 'text-red-400',    dot: 'bg-red-500',    label: 'Sin señal' }
  if (hs === 'STREAM_UNSTABLE') return { color: 'text-amber-400',  dot: 'bg-amber-400',  label: 'Inestable' }
  if (hs === 'HEALTHY')         return { color: 'text-green-400',  dot: 'bg-green-400',  label: 'Online' }
  if (hs === 'USING_MAIN_STREAM') return { color: 'text-green-400', dot: 'bg-green-400', label: 'Online (Main)' }

  // For UNKNOWN/no-status: check effectiveOnline before declaring offline
  if (effectiveOnline) return { color: 'text-green-400',   dot: 'bg-green-400',   label: 'Online' }
  if (cam.online)      return { color: 'text-green-400',   dot: 'bg-green-400',   label: 'Online' }
  if (cam.mainCodec || cam.subCodec) return { color: 'text-amber-400', dot: 'bg-amber-400', label: 'Detectado' }
  return { color: 'text-surface-500', dot: 'bg-surface-600', label: 'Offline' }
}

// ─── Cameras Tab ──────────────────────────────────────────────

function isapIStatusCell(isapIStatus: string | undefined, camOnlineInNvr: boolean | null | undefined): React.ReactNode {
  // NVR-level ISAPI status takes precedence when endpoint is unavailable
  if (isapIStatus === 'no_permission') {
    return <span className="text-amber-500/70 text-[11px]">Sin permiso</span>
  }
  if (isapIStatus === 'unsupported') {
    return <span className="text-surface-600 text-[11px]">No soportado</span>
  }
  // When ISAPI is available or status is unknown, show per-camera value
  if (camOnlineInNvr === true)  return <span className="text-green-400/70 text-[11px]">Online</span>
  if (camOnlineInNvr === false) return <span className="text-surface-500 text-[11px]">Offline</span>
  return <span className="text-surface-600 text-[11px]">No leído</span>
}

function CamerasTab({
  cameras, loading, onRefresh, onSyncCameras, syncingCameras, onRestartStream, onDiagnostics, isAdmin, nvrId, isapIStatus,
}: {
  cameras: { fromNvr: IpCamera[]; fromDb: CameraType[] } | null
  loading: boolean
  onRefresh: () => void
  onSyncCameras: () => void
  syncingCameras: boolean
  onRestartStream: (id: string, name: string) => void
  onDiagnostics: (cam: CameraType) => void
  isAdmin: boolean
  nvrId: string
  isapIStatus?: string
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
          <button onClick={onSyncCameras} disabled={syncingCameras} className="btn-secondary text-xs" title="Sincroniza nombre, IP, puerto, protocolo y estado desde el NVR via ISAPI">
            {syncingCameras ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Sincronizar cámaras IP
          </button>
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

      <div className="card overflow-x-auto">
        <table className="w-full text-xs min-w-[900px]">
          <thead>
            <tr className="border-b border-surface-700 bg-surface-800/50">
              {['Canal', 'Nombre', 'IP / Puerto', 'Protocolo', 'Estado', 'NVR/ISAPI', 'Codec', 'Resolución', 'Última validación', 'Acciones'].map(h => (
                <th key={h} className="text-left px-3 py-2 text-surface-400 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-700/50">
            {list.map(cam => {
              const fromNvr = cameras?.fromNvr.find(n => n.channel === cam.channel)
              const status  = camStatusDisplay(cam)
              const useSub  = cam.preferredStream !== 'main'
              const codec   = useSub ? (cam.subCodec || cam.mainCodec) : (cam.mainCodec || cam.subCodec)
              const isHevc  = (codec || '').toLowerCase().match(/hevc|h\.?265/)
              const isMain  = !useSub && !!cam.mainCodec
              const resolution = cam.preferredStream !== 'main'
                ? (cam.subResolution || cam.mainResolution || '—')
                : (cam.mainResolution || cam.subResolution || '—')
              const lastCheck = (cam as any).lastRtspCheckAt
                ? format(new Date((cam as any).lastRtspCheckAt), 'dd/MM HH:mm')
                : '—'
              const lastError = (cam as any).lastRtspError || ''
              return (
                <tr key={cam.id} className="hover:bg-surface-700/30 transition-colors">
                  <td className="px-3 py-2 text-surface-300 font-mono">{cam.channelCode || `D${cam.channel}`}</td>
                  <td className="px-3 py-2 text-surface-100 font-medium max-w-[140px] truncate" title={cam.name}>{cam.name}</td>
                  <td className="px-3 py-2 text-surface-400 whitespace-nowrap">
                    {(cam.ipAddress || fromNvr?.ipAddress) ? (
                      <span>{cam.ipAddress || fromNvr?.ipAddress}<span className="text-surface-600">:{cam.managementPort || fromNvr?.managementPort || '—'}</span></span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-surface-400">{cam.protocol || fromNvr?.protocol || '—'}</td>
                  <td className="px-3 py-2">
                    <span
                      className={clsx('inline-flex items-center gap-1.5', status.color)}
                      title={lastError || undefined}
                    >
                      <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', status.dot)} />
                      {status.label}
                      {lastError && <span title={lastError}><AlertTriangle size={9} className="text-amber-500 ml-0.5" /></span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {isapIStatusCell(isapIStatus, (cam as any).onlineInNvr)}
                  </td>
                  <td className="px-3 py-2">
                    {codec ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-surface-400">{codec.toUpperCase()}</span>
                        {isMain && <span className="text-[10px] px-1 rounded bg-blue-900/40 text-blue-400">Main</span>}
                        {isHevc && <span className="text-[10px] px-1 rounded bg-red-900/40 text-red-400">HEVC</span>}
                      </span>
                    ) : <span className="text-surface-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-surface-400 whitespace-nowrap">{resolution}</td>
                  <td className="px-3 py-2 text-surface-500 whitespace-nowrap" title={lastError || undefined}>{lastCheck}</td>
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

function StorageTab({ hdds, loading, supported, unsupportedReason, onRefresh }: {
  hdds: NvrHdd[]
  loading: boolean
  supported: boolean | null
  unsupportedReason?: string
  onRefresh: () => void
}) {
  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  if (supported === false) {
    const isPermission = unsupportedReason?.includes('permiso') || unsupportedReason?.includes('HTTP 401') || unsupportedReason?.includes('HTTP 403')
    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <button onClick={onRefresh} className="btn-ghost text-xs"><RefreshCw size={12} /> Actualizar</button>
        </div>
        <div className="card p-8 text-center space-y-2">
          <HardDrive size={20} className="mx-auto text-surface-500" />
          <p className="text-sm text-surface-400 font-medium">
            {isPermission ? 'Sin permiso para leer almacenamiento' : 'No soportado por este modelo/firmware'}
          </p>
          {unsupportedReason && <p className="text-xs text-surface-500">{unsupportedReason}</p>}
          {!isPermission && <p className="text-xs text-surface-600">El NVR no expone la API ISAPI de almacenamiento.</p>}
        </div>
      </div>
    )
  }

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

const LEVEL_OPTIONS = ['Administrator', 'Operator', 'User'] as const
type NVRUserLevel = typeof LEVEL_OPTIONS[number]

function levelLabel(l: string) {
  if (!l) return '—'
  if (l.toLowerCase().includes('admin')) return 'Administrador'
  if (l.toLowerCase().includes('oper')) return 'Operador'
  if (l.toLowerCase().includes('user')) return 'Usuario'
  return l
}

function levelColor(l: string) {
  if (l.toLowerCase().includes('admin')) return 'text-red-400'
  if (l.toLowerCase().includes('oper')) return 'text-amber-400'
  return 'text-surface-400'
}

function UsersTab({
  nvrId, users, loading, supported, unsupportedReason, onRefresh, isAdmin,
}: {
  nvrId: string
  users: any[]
  loading: boolean
  supported: boolean | null
  unsupportedReason?: string
  onRefresh: () => void
  isAdmin: boolean
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [editTarget, setEditTarget]   = useState<any | null>(null)
  const [pwdTarget, setPwdTarget]     = useState<any | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)
  const [deleting, setDeleting]       = useState(false)

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await apiDelete(`/nvrs/${nvrId}/users/${deleteTarget.id}`)
      toast.success(`Usuario "${deleteTarget.name}" eliminado del NVR`)
      setDeleteTarget(null)
      onRefresh()
    } catch (err: any) {
      const body = err?.response?.data
      const msg: string = body?.message || 'Error al eliminar usuario'
      const unsupported: boolean = body?.unsupported ?? false
      toast.error(unsupported ? `NVR no soporta eliminación: ${msg}` : msg)
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  if (supported === false) {
    const isPermission = unsupportedReason?.includes('permiso') || unsupportedReason?.includes('HTTP 401') || unsupportedReason?.includes('HTTP 403')
    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <button onClick={onRefresh} className="btn-ghost text-xs"><RefreshCw size={12} /> Actualizar</button>
        </div>
        <div className="card p-8 text-center space-y-2">
          <Users size={20} className="mx-auto text-surface-500" />
          <p className="text-sm text-surface-400 font-medium">
            {isPermission ? 'Sin permiso para gestión de usuarios' : 'No soportado por este modelo/firmware'}
          </p>
          {unsupportedReason && <p className="text-xs text-surface-500">{unsupportedReason}</p>}
          {!isPermission && <p className="text-xs text-surface-600">El NVR no expone la API ISAPI de usuarios.</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-surface-400">{users.length} usuarios en el NVR</span>
        <div className="flex gap-2">
          {isAdmin && (
            <button onClick={() => setShowCreate(true)} className="btn-primary text-xs">
              <UserPlus size={12} /> Nuevo usuario
            </button>
          )}
          <button onClick={onRefresh} className="btn-ghost text-xs"><RefreshCw size={12} /> Actualizar</button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-surface-700 bg-surface-800/50">
              {['ID', 'Usuario', 'Nivel', 'Estado', ...(isAdmin ? ['Acciones'] : [])].map(h => (
                <th key={h} className="text-left px-4 py-2 text-surface-400 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-700/50">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-surface-700/30 transition-colors">
                <td className="px-4 py-2 text-surface-500">{u.id}</td>
                <td className="px-4 py-2 text-surface-100 font-medium">{u.name}</td>
                <td className={clsx('px-4 py-2 font-medium', levelColor(u.userLevel))}>{levelLabel(u.userLevel)}</td>
                <td className="px-4 py-2">
                  {u.enabled === false
                    ? <span className="text-surface-500 flex items-center gap-1"><ShieldOff size={11} /> Inactivo</span>
                    : <span className="text-green-400 flex items-center gap-1"><ShieldCheck size={11} /> Activo</span>
                  }
                </td>
                {isAdmin && (
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditTarget(u)}
                        className="p-1 rounded text-surface-400 hover:text-brand-400 hover:bg-surface-700 transition-colors"
                        title="Editar usuario"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => setPwdTarget(u)}
                        className="p-1 rounded text-surface-400 hover:text-amber-400 hover:bg-surface-700 transition-colors"
                        title="Cambiar contraseña"
                      >
                        <KeyRound size={11} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(u)}
                        className="p-1 rounded text-surface-400 hover:text-red-400 hover:bg-surface-700 transition-colors"
                        title="Eliminar usuario"
                        disabled={u.userLevel?.toLowerCase().includes('admin') && users.filter(x => x.userLevel?.toLowerCase().includes('admin')).length <= 1}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="py-10 text-center text-surface-500 text-sm">Sin usuarios o el NVR no soporta este endpoint</div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <NVRUserCreateModal
          nvrId={nvrId}
          onClose={() => setShowCreate(false)}
          onSuccess={() => { setShowCreate(false); onRefresh() }}
        />
      )}

      {/* Edit modal */}
      {editTarget && (
        <NVRUserEditModal
          nvrId={nvrId}
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => { setEditTarget(null); onRefresh() }}
        />
      )}

      {/* Change password modal */}
      {pwdTarget && (
        <NVRUserPasswordModal
          nvrId={nvrId}
          user={pwdTarget}
          onClose={() => setPwdTarget(null)}
          onSuccess={() => setPwdTarget(null)}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="card w-full max-w-sm p-6 animate-slide-in shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-red-900/40 flex items-center justify-center flex-shrink-0">
                <Trash2 size={16} className="text-red-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-surface-100">Eliminar usuario NVR</h3>
                <p className="text-xs text-surface-400">Esta acción es irreversible en el NVR.</p>
              </div>
            </div>
            <p className="text-xs text-surface-300">
              ¿Eliminar al usuario <span className="font-semibold text-surface-100">"{deleteTarget.name}"</span> ({levelLabel(deleteTarget.userLevel)}) del NVR?
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} className="btn-secondary text-xs" disabled={deleting}>Cancelar</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 rounded-lg bg-red-900/40 border border-red-800/50 text-red-400 hover:bg-red-900/60 text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {deleting ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── NVR User Create Modal ─────────────────────────────────────

function NVRUserCreateModal({ nvrId, onClose, onSuccess }: { nvrId: string; onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({ name: '', password: '', confirm: '', userLevel: 'Operator' as NVRUserLevel })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const f = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.value }))

  const handleSave = async () => {
    if (!form.name.trim()) { setError('El nombre de usuario es obligatorio'); return }
    if (form.password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return }
    if (form.password !== form.confirm) { setError('Las contraseñas no coinciden'); return }
    setError('')
    setSaving(true)
    try {
      await apiPost(`/nvrs/${nvrId}/users`, { name: form.name, password: form.password, userLevel: form.userLevel })
      toast.success(`Usuario "${form.name}" creado en el NVR`)
      onSuccess()
    } catch (err: any) {
      const body = err?.response?.data
      const msg: string = body?.message || 'Error al crear usuario'
      setError(body?.unsupported ? `NVR no soporta creación de usuarios: ${msg}` : msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="card w-full max-w-md p-6 animate-slide-in shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold text-surface-100">Nuevo usuario NVR</h3>
          <button onClick={onClose} className="btn-ghost p-1"><X size={14} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Nombre de usuario *</label>
            <input className="input" placeholder="operador1" value={form.name} onChange={f('name')} autoFocus />
            <p className="text-[10px] text-surface-500 mt-1">Solo letras, números y _ @ . -</p>
          </div>
          <div>
            <label className="label">Nivel / Rol</label>
            <select className="input w-full" value={form.userLevel} onChange={f('userLevel')}>
              {LEVEL_OPTIONS.map(l => <option key={l} value={l}>{levelLabel(l)}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Contraseña *</label>
            <input className="input" type="password" placeholder="Mín. 8 caracteres" value={form.password} onChange={f('password')} />
          </div>
          <div>
            <label className="label">Confirmar contraseña *</label>
            <input className="input" type="password" placeholder="Repetir contraseña" value={form.confirm} onChange={f('confirm')} />
          </div>
          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2">{error}</p>}
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} className="btn-secondary text-xs" disabled={saving}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary text-xs">
            {saving ? <><Loader2 size={12} className="animate-spin" /> Creando...</> : <><UserPlus size={12} /> Crear usuario</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── NVR User Edit Modal ───────────────────────────────────────

function NVRUserEditModal({
  nvrId, user, onClose, onSuccess,
}: { nvrId: string; user: any; onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({
    name:      user.name as string,
    userLevel: (user.userLevel || 'Operator') as NVRUserLevel,
    enabled:   user.enabled !== false,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!form.name.trim()) { setError('El nombre no puede estar vacío'); return }
    setError('')
    setSaving(true)
    try {
      await apiPut(`/nvrs/${nvrId}/users/${user.id}`, form)
      toast.success(`Usuario "${form.name}" actualizado`)
      onSuccess()
    } catch (err: any) {
      const body = err?.response?.data
      const msg: string = body?.message || 'Error al actualizar usuario'
      setError(body?.unsupported ? `NVR no soporta edición de usuarios: ${msg}` : msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="card w-full max-w-md p-6 animate-slide-in shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold text-surface-100">Editar usuario NVR</h3>
          <button onClick={onClose} className="btn-ghost p-1"><X size={14} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Nombre de usuario</label>
            <input
              className="input"
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Nivel / Rol</label>
            <select
              className="input w-full"
              value={form.userLevel}
              onChange={e => setForm(p => ({ ...p, userLevel: e.target.value as NVRUserLevel }))}
            >
              {LEVEL_OPTIONS.map(l => <option key={l} value={l}>{levelLabel(l)}</option>)}
            </select>
          </div>
          {user.enabled !== undefined && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))}
                className="w-4 h-4 rounded border-surface-600 bg-surface-800 text-brand-500"
              />
              <span className="text-xs text-surface-300">Usuario habilitado</span>
            </label>
          )}
          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2">{error}</p>}
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} className="btn-secondary text-xs" disabled={saving}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary text-xs">
            {saving ? <><Loader2 size={12} className="animate-spin" /> Guardando...</> : <><Pencil size={12} /> Guardar cambios</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── NVR User Password Modal ───────────────────────────────────

function NVRUserPasswordModal({
  nvrId, user, onClose, onSuccess,
}: { nvrId: string; user: any; onClose: () => void; onSuccess: () => void }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm]         = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const handleSave = async () => {
    if (newPassword.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return }
    if (newPassword !== confirm) { setError('Las contraseñas no coinciden'); return }
    setError('')
    setSaving(true)
    try {
      await apiPost(`/nvrs/${nvrId}/users/${user.id}/change-password`, {
        newPassword,
        userName: user.name,
      })
      toast.success(`Contraseña de "${user.name}" actualizada`)
      onSuccess()
    } catch (err: any) {
      const body = err?.response?.data
      const msg: string = body?.message || 'Error al cambiar contraseña'
      setError(body?.unsupported ? `NVR no soporta cambio de contraseña: ${msg}` : msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="card w-full max-w-sm p-6 animate-slide-in shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-sm font-semibold text-surface-100">Cambiar contraseña</h3>
            <p className="text-xs text-surface-500 mt-0.5">Usuario: <span className="text-surface-300 font-medium">{user.name}</span></p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1"><X size={14} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Nueva contraseña *</label>
            <input
              className="input"
              type="password"
              placeholder="Mín. 8 caracteres"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Confirmar contraseña *</label>
            <input
              className="input"
              type="password"
              placeholder="Repetir contraseña"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2">{error}</p>}
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} className="btn-secondary text-xs" disabled={saving}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary text-xs">
            {saving ? <><Loader2 size={12} className="animate-spin" /> Guardando...</> : <><KeyRound size={12} /> Cambiar contraseña</>}
          </button>
        </div>
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
              <Check ok={result.camera.onlineInNvr} label={`Canal ${result.channelCode} ${result.camera.onlineInNvr ? 'online' : 'offline'} en NVR`} detail={result.camera.ipAddress ? `IP: ${result.camera.ipAddress} · ${result.camera.protocol}` : undefined} />
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
                const preferred = result.rtsp.preferred || result.camera.preferredStream || 'sub'
                const chosenCodec = preferred === 'main'
                  ? (result.rtsp.mainCodec || result.rtsp.subCodec || '?')
                  : (result.rtsp.subCodec || result.rtsp.mainCodec || '?')
                const chosenRes = preferred === 'main' ? result.rtsp.mainResolution : result.rtsp.subResolution
                const chosenIsHevc = preferred === 'main' ? mainHevc : subHevc
                return <>
                  <Check
                    ok={!chosenIsHevc}
                    label={`Stream elegido: ${preferred.toUpperCase()} · ${chosenCodec.toUpperCase()}`}
                    detail={chosenRes ? `Resolución: ${chosenRes}` : undefined}
                  />
                  {(subHevc || mainHevc) && (
                    <div className="py-1.5 pl-6 text-xs text-amber-300 bg-amber-900/20 rounded px-3 my-1">
                      Recomendación HEVC: En el NVR, configura el subflujo en H.264, desactiva H.264+ y desactiva B-frames.
                    </div>
                  )}
                  {result.rtsp.subOk && !subHevc
                    ? <Check ok={true} label="Codec compatible web (sub)" detail={`${result.rtsp.subCodec?.toUpperCase() || '?'} · ${result.rtsp.subResolution || '?'}`} />
                    : result.rtsp.mainOk && !mainHevc
                      ? <Check ok={true} label="Codec compatible web (main)" detail={`${result.rtsp.mainCodec?.toUpperCase() || '?'} · ${result.rtsp.mainResolution || '?'}`} />
                      : result.rtsp.mainOk && mainHevc
                        ? <Check ok={'warn'} label="Codec no compatible web (HEVC)" detail={`Main: ${result.rtsp.mainCodec?.toUpperCase() || 'HEVC'} — HLS/WebRTC solo soporta H.264`} />
                        : result.rtsp.subOk && subHevc
                          ? <Check ok={'warn'} label="Codec no compatible web (HEVC)" detail={`Sub: ${result.rtsp.subCodec?.toUpperCase() || 'HEVC'} — configura substream en H.264 en el NVR`} />
                          : null
                  }
                </>
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
                  ? `${result.mediaServer.readers} lector(es) activo(s)`
                  : 'Sin lectores — se activa al reproducir (sourceOnDemand)'
                }
              />
              {result.mediaServer.sourceType && (
                <Check ok={true} label={`Tipo de fuente: ${result.mediaServer.sourceType}`} detail={result.mediaServer.sourceMasked} />
              )}
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
