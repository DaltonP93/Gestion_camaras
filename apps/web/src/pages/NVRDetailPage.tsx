// src/pages/NVRDetailPage.tsx
import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Power, Wifi, WifiOff,
  HardDrive, Camera, Users, Wrench, Activity,
  ChevronRight, AlertTriangle, CheckCircle2, XCircle, Lock,
  Loader2, Play, RotateCcw, Stethoscope, Plus, X, Search, Check,
  Pencil, Trash2, KeyRound, UserPlus, ShieldCheck, ShieldOff,
  Copy, Download, ChevronDown, Zap, Video as VideoIcon, Film, ExternalLink,
} from 'lucide-react'
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import type { NVR, Camera as CameraType, NvrHdd, IpCamera, CameraDiagnostics, ChannelVideoConfig, RecordingCapabilities } from '@/types'
import { clsx } from 'clsx'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

type Tab = 'summary' | 'cameras' | 'video' | 'recordings' | 'storage' | 'users' | 'maintenance' | 'diagnostics'

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
  const [lastSyncResult, setLastSyncResult] = useState<{
    nameSource?: 'real' | 'none'; nameReason?: string; sourceUsed?: string
    nameCandidates?: number; nameUpdated?: number; warning?: string
  } | null>(null)
  const [onboarding, setOnboarding] = useState(false)
  const [lastSyncStats, setLastSyncStats] = useState<{
    sourceUsed?: string; nameUpdated?: number; ipUpdated?: number
    portUpdated?: number; statusUpdated?: number; total?: number; synced?: number
  } | null>(null)
  const [isapDebugModal, setIsapDebugModal] = useState(false)
  const [isapDebugData, setIsapDebugData] = useState<any>(null)
  const [loadingIsapDebug, setLoadingIsapDebug] = useState(false)
  const [bgSyncing, setBgSyncing] = useState(false)
  const [bgSyncResult, setBgSyncResult] = useState<{ sourceUsed?: string; syncedAt?: string } | null>(null)

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
  const [recordingCaps, setRecordingCaps] = useState<RecordingCapabilities | null>(null)
  const [loadingRecordingCaps, setLoadingRecordingCaps] = useState(false)
  const [checkingRecordingCaps, setCheckingRecordingCaps] = useState(false)

  // Video/Audio tab
  const [videoConfigs, setVideoConfigs] = useState<ChannelVideoConfig[]>([])
  const [loadingVideo, setLoadingVideo] = useState(false)

  const isAdmin = user?.role === 'ADMIN'
  const isSupervisor = user?.role === 'SUPERVISOR' || isAdmin

  useEffect(() => {
    if (!id) return
    loadNvr()
  }, [id])

  useEffect(() => {
    if (!id || !nvr) return
    if (tab === 'cameras' && !cameras) loadCameras()
    if (tab === 'video') loadVideoConfigs()
    if (tab === 'recordings') loadRecordingCaps()
    if (tab === 'storage') loadStorage()
    if (tab === 'users') loadUsers()
    if (tab === 'recordings') loadRecordingCaps()
  }, [tab, nvr])

  // Auto-sync camera metadata in background when NVR detail loads
  // and lastSyncAt is older than 2 minutes. Does not block the UI.
  useEffect(() => {
    if (!nvr || !id || !isSupervisor) return
    const lastSync = (nvr as any).lastSyncAt ? new Date((nvr as any).lastSyncAt).getTime() : 0
    const ageMs = Date.now() - lastSync
    if (ageMs < 2 * 60 * 1000) return  // fresh enough
    setBgSyncing(true)
    apiPost<any>(`/nvrs/${id}/sync-cameras`, {})
      .then((res) => setBgSyncResult({ sourceUsed: res.sourceUsed, syncedAt: res.syncedAt }))
      .catch(() => {})
      .finally(() => {
        setBgSyncing(false)
        // Reload cameras list if the tab is open
        if (tab === 'cameras') loadCameras()
      })
  }, [nvr?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const loadVideoConfigs = async () => {
    try {
      setLoadingVideo(true)
      const data = await apiGet<ChannelVideoConfig[]>(`/nvrs/${id}/video-audio`)
      setVideoConfigs(data)
    } catch {
      toast.error('Error al cargar configuración de video')
    } finally {
      setLoadingVideo(false)
    }
  }

  const loadRecordingCaps = async () => {
    try {
      setLoadingRecordingCaps(true)
      const data = await apiGet<RecordingCapabilities>(`/nvrs/${id}/recording-capabilities`)
      setRecordingCaps(data)
    } catch {
      // Endpoint may not exist yet — ignore
    } finally {
      setLoadingRecordingCaps(false)
    }
  }

  const checkRecordingCaps = async () => {
    try {
      setCheckingRecordingCaps(true)
      const data = await apiPost<RecordingCapabilities>(`/nvrs/${id}/recording-capabilities/check`, {})
      setRecordingCaps(data)
      toast.success(data.supportsIsapiRecording ? 'ISAPI soportado' : 'ISAPI no soportado')
    } catch {
      toast.error('Error al verificar compatibilidad')
    } finally {
      setCheckingRecordingCaps(false)
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

  const handleOnboard = async () => {
    if (!id) return
    try {
      setOnboarding(true)
      const res = await apiPost<any>(`/nvrs/${id}/onboard`)
      const sc = res.syncCameras || {}
      toast.success(
        `Onboarding completado: ${sc.synced ?? 0} cámaras` +
        (sc.nameUpdated ? ` · ${sc.nameUpdated} nombres` : '') +
        (sc.ipUpdated ? ` · ${sc.ipUpdated} IPs` : '') +
        ` [${sc.sourceUsed ?? '?'}]`
      )
      setLastSyncStats({ sourceUsed: sc.sourceUsed, nameUpdated: sc.nameUpdated, ipUpdated: sc.ipUpdated, portUpdated: sc.portUpdated, total: sc.total, synced: sc.synced })
      await loadNvr()
      setCameras(null)
    } catch (e: any) {
      const msg = e?.response?.data?.message || 'Error en onboarding'
      toast.error(msg)
    } finally {
      setOnboarding(false)
    }
  }

  const handleIsapDebug = async () => {
    if (!id) return
    setIsapDebugModal(true)
    if (isapDebugData) return  // already loaded
    try {
      setLoadingIsapDebug(true)
      const res = await apiGet<any>(`/nvrs/${id}/ip-camera-sources-debug`)
      setIsapDebugData(res)
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Error al cargar diagnóstico ISAPI')
    } finally {
      setLoadingIsapDebug(false)
    }
  }

  const handleSyncCameras = async () => {
    if (!id) return
    try {
      setSyncingCameras(true)
      const res = await apiPost<{
        synced: number; total: number; ipUpdated?: number; portUpdated?: number; nameUpdated?: number
        nameCandidates?: number; skippedNameBecauseEmpty?: number; statusUpdated?: number
        sourceUsed?: string; warning?: string; nameSource?: 'real' | 'none'; nameReason?: string
      }>(`/nvrs/${id}/sync-cameras`)
      if (res.warning) {
        toast.error(res.warning)
      } else {
        const parts = [`${res.total} detectadas`]
        if ((res.ipUpdated ?? 0) > 0)     parts.push(`${res.ipUpdated} con IP`)
        if ((res.statusUpdated ?? 0) > 0) parts.push(`${res.statusUpdated} con estado`)
        if (res.nameSource === 'none') {
          toast.success(`Sincronizadas: ${parts.join(' · ')} [${res.sourceUsed ?? '?'}] · Nombres: no disponibles por ISAPI`)
        } else {
          if ((res.nameUpdated ?? 0) > 0) parts.push(`${res.nameUpdated} con nombre`)
          toast.success(`Cámaras IP sincronizadas: ${parts.join(' · ')} [${res.sourceUsed ?? '?'}]`)
        }
      }
      await loadNvr()
      await loadCameras()
      // Set AFTER cameras reload so hasRealCameraNames evaluates against fresh data
      setLastSyncResult(res)
      setLastSyncStats({ sourceUsed: res.sourceUsed, nameUpdated: res.nameUpdated, ipUpdated: res.ipUpdated, portUpdated: res.portUpdated, statusUpdated: res.statusUpdated, total: res.total, synced: res.synced })
    } catch (e: any) {
      const msg = e?.response?.data?.message || 'Error al sincronizar cámaras IP'
      toast.error(msg)
    } finally {
      setSyncingCameras(false)
    }
  }

  const handleForceSyncNames = async () => {
    if (!id) return
    if (!confirm('¿Reemplazar todos los nombres con los del NVR, incluso si ya tienes nombres personalizados?')) return
    try {
      setSyncingCameras(true)
      const res = await apiPost<{
        synced: number; total: number; sourceUsed?: string; warning?: string
        nameUpdated?: number; nameCandidates?: number; skippedNameBecauseEmpty?: number; skippedNameBecauseNotPlaceholder?: number
        ipUpdated?: number; portUpdated?: number; nameSource?: 'real' | 'none'; nameReason?: string
      }>(`/nvrs/${id}/sync-cameras?forceNames=true`)
      if (res.warning) {
        toast.error(res.warning)
      } else if ((res.nameUpdated ?? 0) === 0) {
        const empty = res.skippedNameBecauseEmpty ?? 0
        const notPH = res.skippedNameBecauseNotPlaceholder ?? 0
        toast.error(
          `Sin nombres actualizados — fuente: ${res.sourceUsed ?? '?'}` +
          (empty > 0 ? ` | ${empty} cámaras sin nombre en ISAPI` : '') +
          (notPH > 0 ? ` | ${notPH} ya con nombre real` : '')
        )
      } else {
        toast.success(
          `${res.nameUpdated} de ${res.total} nombres actualizados desde NVR [${res.sourceUsed ?? '?'}]` +
          (res.ipUpdated ? ` · ${res.ipUpdated} IPs` : '')
        )
      }
      await loadNvr()
      await loadCameras()
      // Set AFTER cameras reload so hasRealCameraNames evaluates against fresh data
      setLastSyncResult(res)
      if (!res.warning && (res.nameUpdated ?? 0) > 0) {
        setLastSyncStats({ sourceUsed: res.sourceUsed, nameUpdated: res.nameUpdated, ipUpdated: res.ipUpdated, portUpdated: res.portUpdated, total: res.total, synced: res.synced })
      }
    } catch (e: any) {
      const msg = e?.response?.data?.message || 'Error al forzar nombres desde NVR'
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
    { id: 'summary',     label: 'Resumen',        icon: <Activity size={14} /> },
    { id: 'cameras',     label: 'Cámaras IP',     icon: <Camera size={14} /> },
    { id: 'video',       label: 'Video y audio',  icon: <VideoIcon size={14} /> },
    { id: 'recordings',  label: 'Grabaciones',    icon: <Film size={14} /> },
    { id: 'storage',     label: 'Almacenamiento', icon: <HardDrive size={14} /> },
    { id: 'users',       label: 'Usuarios NVR',   icon: <Users size={14} /> },
    { id: 'maintenance', label: 'Mantenimiento',  icon: <Wrench size={14} /> },
    { id: 'diagnostics', label: 'Diagnóstico',    icon: <Stethoscope size={14} /> },
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
              <button onClick={handleOnboard} disabled={onboarding || syncing} className="btn-secondary text-xs" title="Detectar + sincronizar cámaras + validar RTSP">
                {onboarding ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                {onboarding ? 'Onboarding...' : 'Onboarding'}
              </button>
              <button onClick={handleSync} disabled={syncing || onboarding} className="btn-ghost text-xs">
                {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {syncing ? 'Sincronizando...' : 'Sincronizar'}
              </button>
              <button onClick={handleIsapDebug} className="btn-ghost text-xs" title="Ver diagnóstico de endpoints ISAPI">
                <Stethoscope size={11} />
                Endpoints ISAPI
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

      {/* Sync stats banner */}
      {lastSyncStats && (
        <div className="flex items-center gap-3 px-3 py-1.5 bg-surface-800 border border-surface-700 rounded-lg text-xs text-surface-400">
          <span className="font-medium text-surface-300">Último sync:</span>
          {lastSyncStats.sourceUsed && <span className="font-mono text-brand-400">{lastSyncStats.sourceUsed}</span>}
          {lastSyncStats.total != null && <span>{lastSyncStats.total} detectadas</span>}
          {(lastSyncStats.nameUpdated ?? 0) > 0 && <span className="text-green-400">{lastSyncStats.nameUpdated} nombres</span>}
          {(lastSyncStats.ipUpdated ?? 0) > 0 && <span className="text-green-400">{lastSyncStats.ipUpdated} IPs</span>}
          {(lastSyncStats.portUpdated ?? 0) > 0 && <span>{lastSyncStats.portUpdated} puertos</span>}
          {(lastSyncStats.statusUpdated ?? 0) > 0 && <span>{lastSyncStats.statusUpdated} estados</span>}
          <button onClick={() => setLastSyncStats(null)} className="ml-auto text-surface-600 hover:text-surface-400">
            <X size={10} />
          </button>
        </div>
      )}

      {/* Tab Content */}
      {tab === 'summary' && <SummaryTab nvr={nvr} />}
      {tab === 'cameras' && (
        <CamerasTab
          nvrId={nvr.id}
          cameras={cameras}
          loading={loadingCameras}
          onRefresh={loadCameras}
          onSyncCameras={handleSyncCameras}
          onForceSyncNames={handleForceSyncNames}
          syncingCameras={syncingCameras}
          onRestartStream={handleRestartStream}
          onDiagnostics={(cam) => { setDiagCamera(cam.id); setTab('diagnostics'); handleDiagnostics(cam.id) }}
          isAdmin={isAdmin}
          isapIStatus={nvr.isapIStatus}
          lastSyncResult={lastSyncResult}
          onValidateHealth={handleValidateHealth}
          validatingHealth={validatingHealth}
          bgSyncing={bgSyncing}
          bgSyncResult={bgSyncResult}
        />
      )}
      {tab === 'video' && (
        <VideoAudioTab
          nvrId={nvr.id}
          configs={videoConfigs}
          loading={loadingVideo}
          onRefresh={loadVideoConfigs}
          isAdmin={isAdmin}
        />
      )}
      {tab === 'recordings' && (
        <RecordingsCapTab
          caps={recordingCaps}
          loading={loadingRecordingCaps}
          checking={checkingRecordingCaps}
          onRefresh={loadRecordingCaps}
          onCheck={checkRecordingCaps}
          isAdmin={isAdmin}
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

      {/* Modal ISAPI Debug */}
      {isapDebugModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-3xl p-6 animate-slide-in shadow-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-surface-100">Diagnóstico de Endpoints ISAPI</h3>
              <button onClick={() => setIsapDebugModal(false)} className="btn-ghost p-1"><X size={14} /></button>
            </div>
            {loadingIsapDebug ? (
              <div className="flex-1 flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-surface-400" />
                <span className="ml-2 text-sm text-surface-400">Probando endpoints...</span>
              </div>
            ) : isapDebugData ? (
              <div className="overflow-auto flex-1 space-y-3">
                <p className="text-xs text-surface-500">
                  NVR: <span className="text-surface-300 font-mono">{isapDebugData.nvr?.ipAddress}:{isapDebugData.nvr?.port}</span>
                </p>
                {(isapDebugData.endpoints || []).map((ep: any, i: number) => (
                  <div key={i} className={clsx(
                    'rounded-lg p-3 border text-xs',
                    ep.status === 200 ? 'border-green-800/50 bg-green-900/10' :
                    ep.status === 401 || ep.status === 403 ? 'border-amber-800/50 bg-amber-900/10' :
                    'border-surface-700 bg-surface-800/50'
                  )}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={clsx(
                        'font-mono font-medium',
                        ep.status === 200 ? 'text-green-400' : ep.status === 401 || ep.status === 403 ? 'text-amber-400' : 'text-red-400'
                      )}>HTTP {ep.status ?? 'ERR'}</span>
                      <span className="text-surface-300 font-mono truncate flex-1">{ep.endpoint}</span>
                      {ep.count != null && <span className="text-surface-400">{ep.count} canales</span>}
                    </div>
                    {ep.conclusion && <p className="text-surface-400 mt-0.5">{ep.conclusion}</p>}
                    {ep.error && <p className="text-red-400 mt-0.5">{ep.error}</p>}
                    {ep.fields && ep.fields.length > 0 && (
                      <p className="text-surface-500 mt-0.5">Campos: {ep.fields.join(', ')}</p>
                    )}
                    {ep.sample && (
                      <p className="text-surface-500 mt-0.5 font-mono text-[10px] truncate">Muestra: {ep.sample}</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-surface-500 py-8 text-center">No se pudo cargar el diagnóstico</p>
            )}
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => { setIsapDebugData(null); handleIsapDebug() }}
                className="btn-secondary text-xs mr-2"
              >
                <RefreshCw size={11} /> Re-probar
              </button>
              <button onClick={() => setIsapDebugModal(false)} className="btn-ghost text-xs">Cerrar</button>
            </div>
          </div>
        </div>
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

// ─── ISAPI Debug Modal ────────────────────────────────────────

const IMPORTANT_TAGS = ['ipAddress', 'managePortNo', 'proxyProtocol', 'name', 'customName', 'online', 'chanDetectResult', 'sourceInputPortDescriptor', 'channelName', 'PasswordStatus', 'securityStatus']

function IsapDebugModal({ loading, error, data, onRetest, onClose }: {
  loading: boolean
  error: string | null
  data: any[] | null
  onRetest: () => void
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyAll = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    toast.success('JSON copiado al portapapeles')
  }

  const downloadAll = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `isapi-debug-${Date.now()}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const copyRow = (ep: any) => {
    navigator.clipboard.writeText(ep.fullBody || ep.snippet || '')
    toast.success(`Respuesta de ${ep.endpoint} copiada`)
  }

  // Summary derivation
  const hasIpSource  = data?.some((ep: any) => ep.ok && (ep.hasFields?.ipAddress || ep.hasFields?.managePortNo))
  const hasNameSource = data?.some((ep: any) => ep.ok && (ep.hasFields?.customName || ep.hasFields?.name) && !ep.endpoint.includes('/Streaming/'))
  const hasStatus    = data?.some((ep: any) => ep.ok && ep.hasFields?.online)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card flex flex-col w-full max-w-[min(95vw,1200px)] max-h-[85vh] shadow-2xl">
        {/* Sticky header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-700 flex-shrink-0">
          <h3 className="text-sm font-semibold text-surface-100 flex items-center gap-2">
            <Stethoscope size={15} /> Diagnóstico de endpoints ISAPI
          </h3>
          <div className="flex items-center gap-2">
            <button onClick={onRetest} disabled={loading} className="btn-ghost text-xs">
              {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Retestar
            </button>
            {data && data.length > 0 && (
              <>
                <button onClick={copyAll} className="btn-ghost text-xs"><Copy size={11} /> Copiar JSON</button>
                <button onClick={downloadAll} className="btn-ghost text-xs"><Download size={11} /> Descargar</button>
              </>
            )}
            <button onClick={onClose} className="p-1.5 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors" title="Cerrar (Esc)">
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <p className="text-xs text-surface-500">
            Prueba todos los endpoints ISAPI del NVR con autenticación Digest.
            Identifica cuál endpoint contiene IP, puerto, nombre y estado real de la cámara.
          </p>

          {/* Summary badges */}
          {data && data.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium', hasIpSource ? 'bg-green-900/30 text-green-400 border border-green-900/50' : 'bg-surface-700/50 text-surface-500 border border-surface-600/50')}>
                {hasIpSource ? <CheckCircle2 size={11} /> : <XCircle size={11} />} IP / Puerto
              </span>
              <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium', hasNameSource ? 'bg-green-900/30 text-green-400 border border-green-900/50' : 'bg-amber-900/20 text-amber-500/80 border border-amber-900/30')}>
                {hasNameSource ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} Nombres reales
              </span>
              <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium', hasStatus ? 'bg-green-900/30 text-green-400 border border-green-900/50' : 'bg-surface-700/50 text-surface-500 border border-surface-600/50')}>
                {hasStatus ? <CheckCircle2 size={11} /> : <XCircle size={11} />} Estado online/offline
              </span>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-3 py-6 text-surface-400">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Probando endpoints ISAPI... puede tardar hasta 30 segundos</span>
            </div>
          )}
          {!loading && error && (
            <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-900/40 rounded-lg text-xs text-red-400">
              <XCircle size={13} className="flex-shrink-0 mt-0.5" /> {error}
            </div>
          )}
          {!loading && !error && data && data.length === 0 && (
            <p className="text-xs text-surface-500 py-4 text-center">Sin resultados (respuesta vacía del servidor).</p>
          )}

          {!loading && data && data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] min-w-[900px]">
                <thead>
                  <tr className="border-b border-surface-700 text-surface-400">
                    <th className="text-left px-3 py-2 font-medium w-56">Endpoint</th>
                    <th className="text-left px-3 py-2 font-medium w-24">HTTP / Tipo</th>
                    <th className="text-left px-3 py-2 font-medium w-20">Bytes</th>
                    <th className="text-left px-3 py-2 font-medium">Campos detectados</th>
                    <th className="text-left px-3 py-2 font-medium w-48">Conclusión</th>
                    <th className="text-left px-3 py-2 font-medium w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-700/40">
                  {data.map((ep: any, i: number) => {
                    const hf: Record<string, boolean> = ep.hasFields || {}
                    const bodyType = (ep.fullBody || ep.snippet)?.trimStart().startsWith('<') ? 'XML' : (ep.fullBody || ep.snippet)?.trimStart().startsWith('{') ? 'JSON' : 'raw'
                    const isExpanded = expanded === i
                    const foundTags = IMPORTANT_TAGS.filter(t => hf[t])
                    const otherFields = (ep.detectedFields || []).filter((f: string) => !IMPORTANT_TAGS.includes(f))
                    return (
                      <>
                        <tr key={i} className={clsx('align-top', ep.ok ? 'hover:bg-surface-700/20' : 'opacity-60 hover:opacity-80')}>
                          <td className="px-3 py-2">
                            <span className="font-mono text-surface-300 break-all">{ep.endpoint}</span>
                            {ep.note && <div className="text-[10px] text-surface-500 font-sans mt-0.5">{ep.note}</div>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={clsx('font-semibold', ep.ok ? 'text-green-400' : 'text-red-400')}>{ep.status ?? 'ERR'}</span>
                            {ep.ok && <div className="text-[10px] text-surface-500">{bodyType}</div>}
                            {ep.error && <div className="text-[10px] text-red-400/70">{ep.error}</div>}
                          </td>
                          <td className="px-3 py-2 text-surface-500">{ep.byteLength > 0 ? ep.byteLength.toLocaleString() : '—'}</td>
                          <td className="px-3 py-2">
                            {foundTags.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {foundTags.map(t => (
                                  <span key={t} className="px-1.5 py-0.5 rounded text-[10px] bg-green-900/40 text-green-400 font-medium">{t}</span>
                                ))}
                              </div>
                            ) : ep.ok ? (
                              <span className="text-surface-600">Sin campos relevantes</span>
                            ) : null}
                            {otherFields.length > 0 && (
                              <div className="mt-1 text-[10px] text-surface-600">{otherFields.slice(0, 8).join(' · ')}</div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={clsx('text-[10px]', ep.ok && (ep.conclusion?.includes('✓') || ep.conclusion?.includes('activa')) ? 'text-green-400/80' : ep.ok ? 'text-surface-400' : 'text-surface-600')}>
                              {ep.conclusion || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex gap-1">
                              {(ep.fullBody || ep.snippet) && (
                                <button onClick={() => copyRow(ep)} className="p-1 rounded text-surface-500 hover:text-surface-300 hover:bg-surface-700" title="Copiar respuesta completa">
                                  <Copy size={10} />
                                </button>
                              )}
                              {(ep.fullBody || ep.snippet) && (
                                <button onClick={() => setExpanded(isExpanded ? null : i)} className="p-1 rounded text-surface-500 hover:text-surface-300 hover:bg-surface-700" title="Ver snippet">
                                  <ChevronDown size={10} className={clsx('transition-transform', isExpanded && 'rotate-180')} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${i}-exp`} className="bg-surface-900/50">
                            <td colSpan={6} className="px-3 pb-3 pt-1">
                              <pre className="font-mono text-[10px] text-surface-400 whitespace-pre-wrap break-all bg-surface-950/50 rounded p-3 max-h-64 overflow-auto border border-surface-700/50">
                                {(ep.fullBody || ep.snippet || '').slice(0, 8000)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Cameras Tab ──────────────────────────────────────────────

function hasRealCameraNames(cameras: CameraType[]): boolean {
  return cameras.some(c => {
    if (!c.name?.trim()) return false
    const n = c.name.trim()
    return !(
      /^canal\s+\d+$/i.test(n) ||
      /^c[aá]mara\s+\d+$/i.test(n) ||
      /^camera\s*\d*$/i.test(n) ||
      /^ipcamera\s*\d*$/i.test(n) ||
      /^d\d+$/i.test(n) ||
      /^channel\s+\d+$/i.test(n) ||
      /^\d{3,4}$/.test(n)
    )
  })
}

function isapIStatusCell(isapIStatus: string | undefined, camOnlineInNvr: boolean | null | undefined, camOnline?: boolean): React.ReactNode {
  if (isapIStatus === 'no_permission') {
    return <span className="text-amber-500/70 text-[11px]">Sin permiso</span>
  }
  if (isapIStatus === 'unsupported') {
    return <span className="text-surface-600 text-[11px]">No soportado</span>
  }
  if (isapIStatus === 'available') {
    if (camOnlineInNvr === true)  return <span className="text-green-400/70 text-[11px]">Online NVR</span>
    if (camOnlineInNvr === false) {
      // Distinguish: if the RTSP health check says online, show "No verificado" rather than "Offline NVR"
      if (camOnline) return <span className="text-surface-500 text-[11px]">No sincronizado</span>
      return <span className="text-surface-500 text-[11px]">Offline NVR</span>
    }
    // null = unknown — use RTSP health as proxy
    if (camOnline === true) return <span className="text-green-400/70 text-[11px]">Online (RTSP)</span>
    return <span className="text-surface-600 text-[11px]">No verificado</span>
  }
  // No ISAPI data — use DB health status as proxy
  if (camOnline === true)  return <span className="text-green-400/70 text-[11px]">Online</span>
  if (camOnline === false) return <span className="text-surface-500 text-[11px]">Offline</span>
  return <span className="text-surface-600 text-[11px]">No verificado</span>
}

// Highlight matching substring in text
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-brand-500/30 text-brand-200 rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

function CamerasTab({
  cameras, loading, onRefresh, onSyncCameras, onForceSyncNames, syncingCameras, onRestartStream, onDiagnostics, isAdmin, nvrId, isapIStatus, lastSyncResult, onValidateHealth, validatingHealth, bgSyncing, bgSyncResult,
}: {
  cameras: { fromNvr: IpCamera[]; fromDb: CameraType[] } | null
  loading: boolean
  onRefresh: () => void
  onSyncCameras: () => void
  onForceSyncNames: () => void
  syncingCameras: boolean
  onRestartStream: (id: string, name: string) => void
  onDiagnostics: (cam: CameraType) => void
  isAdmin: boolean
  nvrId: string
  isapIStatus?: string
  lastSyncResult?: { nameSource?: 'real' | 'none'; nameReason?: string; sourceUsed?: string; nameCandidates?: number; nameUpdated?: number; warning?: string } | null
  onValidateHealth: () => void
  validatingHealth?: boolean
  bgSyncing?: boolean
  bgSyncResult?: { sourceUsed?: string; syncedAt?: string } | null
}) {
  const [showAdopt, setShowAdopt] = useState(false)
  const [isapDebug, setIsapDebug] = useState<any[] | null>(null)
  const [isapDebugLoading, setIsapDebugLoading] = useState(false)
  const [isapDebugError, setIsapDebugError] = useState<string | null>(null)
  const [showDebug, setShowDebug] = useState(false)
  const [cameraSearch, setCameraSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  // Inline name editing
  const [editingNameId, setEditingNameId] = useState<string | null>(null)
  const [editingNameValue, setEditingNameValue] = useState('')
  const [savingNameId, setSavingNameId] = useState<string | null>(null)
  const editNameRef = useRef<HTMLInputElement>(null)

  const startEditName = (cam: CameraType) => {
    setEditingNameId(cam.id)
    setEditingNameValue(cam.name)
    setTimeout(() => editNameRef.current?.select(), 30)
  }

  const cancelEditName = () => {
    setEditingNameId(null)
    setEditingNameValue('')
  }

  const handleSaveName = async (camId: string) => {
    const trimmed = editingNameValue.trim()
    if (!trimmed) return cancelEditName()
    setSavingNameId(camId)
    try {
      const updated = await apiPatch<CameraType>(`/cameras/${camId}/name`, { name: trimmed })
      // Update local list without re-fetching
      if (cameras) {
        const newDb = cameras.fromDb.map((c) => c.id === camId ? { ...c, name: updated.name } : c)
        // cameras is prop-passed so we can't mutate; parent re-fetch on next interaction
        // For immediate UI update we track renames locally
      }
      toast.success('Nombre actualizado')
      onRefresh()
    } catch {
      // error handled by api lib
    } finally {
      setSavingNameId(null)
      setEditingNameId(null)
    }
  }

  const handleIsapDebug = async () => {
    setShowDebug(true)
    setIsapDebug(null)
    setIsapDebugError(null)
    setIsapDebugLoading(true)
    try {
      // Backend returns { nvr: {...}, endpoints: [...] }
      const res = await apiGet<{ nvr: any; endpoints: any[] }>(`/nvrs/${nvrId}/ip-camera-sources-debug`)
      setIsapDebug(res.endpoints ?? [])
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Error al obtener diagnóstico ISAPI'
      setIsapDebugError(msg)
    } finally {
      setIsapDebugLoading(false)
    }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  const allCameras = cameras?.fromDb || []
  const q = cameraSearch.trim().toLowerCase()
  const list = allCameras.filter((cam) => {
    if (statusFilter === 'online' && !cam.online) return false
    if (statusFilter === 'offline' && cam.online) return false
    if (!q) return true
    const codec = (cam.subCodec || cam.mainCodec || '').toLowerCase()
    const resolution = (cam.subResolution || cam.mainResolution || '').toLowerCase()
    return (
      cam.name.toLowerCase().includes(q) ||
      (cam.channelCode || `D${cam.channel}`).toLowerCase().includes(q) ||
      (cam.ipAddress || '').toLowerCase().includes(q) ||
      (cam.location || '').toLowerCase().includes(q) ||
      codec.includes(q) ||
      resolution.includes(q)
    )
  })

  return (
    <div className="space-y-3">
      {/* Search + filters bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Buscar por nombre, canal, IP, codec..."
            value={cameraSearch}
            onChange={(e) => setCameraSearch(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 rounded-lg bg-surface-900 border border-surface-600 text-surface-100 text-xs placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
          />
          {cameraSearch && (
            <button
              onClick={() => setCameraSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-200"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'online' | 'offline')}
          className="input text-xs py-1.5 w-28"
        >
          <option value="all">Todos</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </select>
        <span className="text-xs text-surface-500 ml-1">
          {q || statusFilter !== 'all'
            ? <><span className="text-brand-400 font-medium">{list.length}</span> de {allCameras.length}</>
            : <>{allCameras.length} cámaras en BD · {cameras?.fromNvr.length || 0} en NVR</>}
        </span>
        {bgSyncing && (
          <span className="flex items-center gap-1 text-[10px] text-brand-400 ml-2">
            <Loader2 size={10} className="animate-spin" /> Sincronizando en segundo plano...
          </span>
        )}
        {!bgSyncing && bgSyncResult && (
          <span className="text-[10px] text-surface-500 ml-2">
            Auto-sync: {bgSyncResult.sourceUsed ?? '?'}
          </span>
        )}
        <div className="flex-1" />
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
          <button onClick={onForceSyncNames} disabled={syncingCameras} className="btn-ghost text-xs" title="Reemplaza nombres con los del NVR aunque ya existan nombres personalizados">
            <RefreshCw size={12} /> Forzar nombres NVR
          </button>
          <button onClick={onValidateHealth} disabled={validatingHealth} className="btn-ghost text-xs" title="Re-probe RTSP por cámara: actualiza mainCodec, subCodec, resolución, compatibilidad H.264/H.265">
            {validatingHealth ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
            Revalidar RTSP
          </button>
          {isAdmin && (
            <button onClick={handleIsapDebug} className="btn-ghost text-xs" title="Probar todos los endpoints ISAPI para identificar cuál tiene nombre/IP/puerto real">
              <Stethoscope size={12} /> Endpoints ISAPI
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
                  <td className="px-3 py-2 text-surface-300 font-mono">
                    <Highlight text={cam.channelCode || `D${cam.channel}`} query={q} />
                  </td>
                  <td className="px-3 py-2 max-w-[160px]">
                    {editingNameId === cam.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          ref={editNameRef}
                          value={editingNameValue}
                          onChange={(e) => setEditingNameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')  handleSaveName(cam.id)
                            if (e.key === 'Escape') cancelEditName()
                          }}
                          className="flex-1 min-w-0 bg-surface-900 border border-brand-500 rounded px-1.5 py-0.5 text-xs text-surface-100 outline-none"
                          disabled={savingNameId === cam.id}
                          autoFocus
                        />
                        {savingNameId === cam.id
                          ? <Loader2 size={11} className="animate-spin text-surface-400 flex-shrink-0" />
                          : (
                            <>
                              <button onClick={() => handleSaveName(cam.id)} className="p-0.5 text-green-400 hover:text-green-300" title="Guardar (Enter)">
                                <Check size={11} />
                              </button>
                              <button onClick={cancelEditName} className="p-0.5 text-surface-500 hover:text-surface-300" title="Cancelar (Esc)">
                                <X size={11} />
                              </button>
                            </>
                          )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 group/name">
                        <span className="text-surface-100 font-medium truncate" title={cam.name}>
                          <Highlight text={cam.name} query={q} />
                        </span>
                        {isAdmin && (
                          <button
                            onClick={() => startEditName(cam)}
                            className="opacity-0 group-hover/name:opacity-100 p-0.5 rounded text-surface-500 hover:text-surface-200 transition-all flex-shrink-0"
                            title="Editar nombre"
                          >
                            <Pencil size={10} />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-surface-400 whitespace-nowrap">
                    {(cam.ipAddress || fromNvr?.ipAddress) ? (
                      <span>
                        <Highlight text={cam.ipAddress || fromNvr?.ipAddress || ''} query={q} />
                        <span className="text-surface-600">:{cam.managementPort || fromNvr?.managementPort || '—'}</span>
                      </span>
                    ) : <span className="text-surface-600 text-[11px]">No leído</span>}
                  </td>
                  <td className="px-3 py-2 text-surface-400">{cam.protocol || fromNvr?.protocol || <span className="text-surface-600 text-[11px]">No leído</span>}</td>
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
                    {isapIStatusCell(isapIStatus, (cam as any).onlineInNvr, cam.online)}
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
            {q || statusFilter !== 'all'
              ? 'Sin cámaras que coincidan con la búsqueda'
              : 'Sin cámaras — Usa "Sincronizar" para importar desde el NVR'}
          </div>
        )}
      </div>

      {/* nameSource notice — shown after a sync that found no real names AND cameras don't already have real names */}
      {lastSyncResult?.nameSource === 'none' &&
       (lastSyncResult?.nameCandidates ?? 0) === 0 &&
       !hasRealCameraNames(list) &&
       lastSyncResult?.sourceUsed !== 'inputproxy_channels_secure' &&
       lastSyncResult?.sourceUsed !== 'inputproxy_channels' && (
        <div className="flex items-start gap-2 px-3 py-2 text-xs text-amber-500/80 bg-amber-900/10 border border-amber-900/20 rounded-lg">
          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
          <span>
            <span className="font-medium">Nombres no disponibles por ISAPI.</span>{' '}
            {lastSyncResult.nameReason || 'Este modelo no expone nombres reales de cámara por los endpoints disponibles — se conservan los nombres locales existentes.'}
          </span>
        </div>
      )}

      {/* ISAPI debug modal */}
      {isAdmin && showDebug && (
        <IsapDebugModal
          loading={isapDebugLoading}
          error={isapDebugError}
          data={isapDebug}
          onRetest={handleIsapDebug}
          onClose={() => setShowDebug(false)}
        />
      )}
    </div>
  )
}

// ─── Video / Audio Tab ────────────────────────────────────────

function VideoAudioTab({ nvrId, configs, loading, onRefresh, isAdmin }: {
  nvrId: string
  configs: ChannelVideoConfig[]
  loading: boolean
  onRefresh: () => void
  isAdmin: boolean
}) {
  const [search, setSearch] = useState('')
  const [filterCodec, setFilterCodec] = useState<'all' | 'h264' | 'h265' | 'nodata'>('all')
  const [selectedChannel, setSelectedChannel] = useState<number | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editForm, setEditForm] = useState<Partial<{ mainFps: number; mainBitrate: number; subFps: number; subBitrate: number }>>({})
  const [saving, setSaving] = useState(false)

  const filtered = configs.filter(c => {
    const nameMatch = !search || c.cameraName.toLowerCase().includes(search.toLowerCase()) || String(c.channel).includes(search)
    if (!nameMatch) return false
    if (filterCodec === 'h264') return (c.main?.codec ?? '').toLowerCase().includes('h.264') || (c.main?.codec ?? '').toLowerCase().includes('h264')
    if (filterCodec === 'h265') return (c.main?.codec ?? '').toLowerCase().includes('h.265') || (c.main?.codec ?? '').toLowerCase().includes('hevc') || (c.main?.codec ?? '').toLowerCase().includes('h265')
    if (filterCodec === 'nodata') return !c.main && !c.sub
    return true
  })

  const selected = configs.find(c => c.channel === selectedChannel)

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)
    try {
      await apiPut(`/nvrs/${nvrId}/video-audio/${selected.channel}`, editForm)
      toast.success('Configuración guardada')
      setEditMode(false)
      onRefresh()
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-500" />
          <input
            className="input pl-7 text-xs"
            placeholder="Buscar canal..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          {[
            { key: 'all', label: 'Todos' },
            { key: 'h264', label: 'H.264' },
            { key: 'h265', label: 'H.265' },
            { key: 'nodata', label: 'Sin datos' },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilterCodec(f.key as typeof filterCodec)}
              className={clsx('text-xs px-2 py-1 rounded transition-colors',
                filterCodec === f.key ? 'bg-brand-600/30 text-brand-400' : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-surface-500 ml-auto">{configs.length} canales</span>
        <button onClick={onRefresh} disabled={loading} className="btn-ghost text-xs">
          <RefreshCw size={12} /> Recargar
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Channel list */}
        <div className="lg:col-span-1 card overflow-hidden">
          <div className="divide-y divide-surface-700/50 max-h-[600px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-surface-500 text-xs">Sin canales</div>
            ) : filtered.map(c => (
              <button
                key={c.channel}
                onClick={() => { setSelectedChannel(c.channel); setEditMode(false) }}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-700/50 transition-colors text-xs',
                  selectedChannel === c.channel && 'bg-surface-700/80'
                )}
              >
                <span className="text-surface-500 font-mono w-7 flex-shrink-0">
                  {c.channelCode ?? `D${c.channel}`}
                </span>
                <span className="flex-1 truncate text-surface-300">{c.cameraName}</span>
                {c.error ? (
                  <AlertTriangle size={10} className="text-amber-400 flex-shrink-0" />
                ) : c.main ? (
                  <span className={clsx('text-[9px] px-1 rounded flex-shrink-0',
                    /hevc|h\.265|h265/i.test(c.main.codec) ? 'bg-amber-900/30 text-amber-400' : 'bg-green-900/30 text-green-400'
                  )}>
                    {/hevc|h\.265|h265/i.test(c.main.codec) ? 'H.265' : 'H.264'}
                  </span>
                ) : (
                  <span className="text-[9px] text-surface-600">—</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-2">
          {!selected ? (
            <div className="card p-8 text-center text-surface-500 text-sm">
              Selecciona un canal para ver o editar su configuración
            </div>
          ) : (
            <div className="card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-surface-200">
                    {selected.channelCode ?? `D${selected.channel}`} — {selected.cameraName}
                  </div>
                  <div className="text-xs text-surface-500 mt-0.5">
                    Última lectura: {selected.fetchedAt ? format(new Date(selected.fetchedAt), 'dd/MM/yyyy HH:mm') : '—'}
                  </div>
                </div>
                {isAdmin && !selected.error && (
                  <button
                    onClick={() => {
                      setEditMode(!editMode)
                      if (!editMode) {
                        setEditForm({
                          mainFps: selected.main?.fps,
                          mainBitrate: selected.main?.bitrate,
                          subFps: selected.sub?.fps,
                          subBitrate: selected.sub?.bitrate,
                        })
                      }
                    }}
                    className="btn-secondary text-xs"
                  >
                    <Pencil size={11} /> {editMode ? 'Cancelar' : 'Editar'}
                  </button>
                )}
              </div>

              {selected.error ? (
                <div className="flex items-center gap-2 p-2 bg-amber-900/15 border border-amber-700/30 rounded text-xs text-amber-400">
                  <AlertTriangle size={12} />
                  <span>{selected.error}</span>
                </div>
              ) : (
                <>
                  {/* Warning for ADMIN edit */}
                  {editMode && (
                    <div className="flex items-start gap-2 p-2 bg-amber-900/15 border border-amber-700/30 rounded text-xs text-amber-400">
                      <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                      <span>Esto modifica la configuración real del NVR. Se guardará backup automático antes de aplicar.</span>
                    </div>
                  )}

                  {/* Main stream */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-surface-400 uppercase tracking-wide">Stream Principal</div>
                    {selected.main ? (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {[
                          ['Codec', selected.main.codec],
                          ['Resolución', selected.main.resolution],
                          ['FPS', editMode ? null : String(selected.main.fps)],
                          ['Bitrate', editMode ? null : `${selected.main.bitrate} kbps`],
                        ].map(([k, v]) => v !== null ? (
                          <div key={k as string}>
                            <div className="text-[10px] text-surface-500">{k}</div>
                            <div className="text-xs text-surface-200">{v}</div>
                          </div>
                        ) : null)}
                        {editMode && (
                          <>
                            <div>
                              <label className="text-[10px] text-surface-500">FPS</label>
                              <input className="input text-xs mt-0.5" type="number" min="1" max="30"
                                value={editForm.mainFps ?? ''} onChange={e => setEditForm(f => ({ ...f, mainFps: Number(e.target.value) }))} />
                            </div>
                            <div>
                              <label className="text-[10px] text-surface-500">Bitrate (kbps)</label>
                              <input className="input text-xs mt-0.5" type="number" min="128" max="16384"
                                value={editForm.mainBitrate ?? ''} onChange={e => setEditForm(f => ({ ...f, mainBitrate: Number(e.target.value) }))} />
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-surface-500">Sin datos de stream principal</div>
                    )}
                  </div>

                  {/* Sub stream */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-surface-400 uppercase tracking-wide">Sub-stream</div>
                    {selected.sub ? (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {[
                          ['Codec', selected.sub.codec],
                          ['Resolución', selected.sub.resolution],
                          ['FPS', editMode ? null : String(selected.sub.fps)],
                          ['Bitrate', editMode ? null : `${selected.sub.bitrate} kbps`],
                        ].map(([k, v]) => v !== null ? (
                          <div key={k as string}>
                            <div className="text-[10px] text-surface-500">{k}</div>
                            <div className="text-xs text-surface-200">{v}</div>
                          </div>
                        ) : null)}
                        {editMode && (
                          <>
                            <div>
                              <label className="text-[10px] text-surface-500">FPS</label>
                              <input className="input text-xs mt-0.5" type="number" min="1" max="15"
                                value={editForm.subFps ?? ''} onChange={e => setEditForm(f => ({ ...f, subFps: Number(e.target.value) }))} />
                            </div>
                            <div>
                              <label className="text-[10px] text-surface-500">Bitrate (kbps)</label>
                              <input className="input text-xs mt-0.5" type="number" min="64" max="4096"
                                value={editForm.subBitrate ?? ''} onChange={e => setEditForm(f => ({ ...f, subBitrate: Number(e.target.value) }))} />
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-surface-500">Sin datos de sub-stream</div>
                    )}
                  </div>

                  {editMode && (
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditMode(false)} className="btn-secondary text-xs">Cancelar</button>
                      <button onClick={handleSave} disabled={saving} className="btn-primary text-xs">
                        {saving ? <Loader2 size={11} className="animate-spin" /> : null}
                        {saving ? 'Guardando...' : 'Guardar cambios'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Recordings Capabilities Tab ──────────────────────────────

function RecordingsCapTab({ caps, loading, checking, onRefresh, onCheck, isAdmin }: {
  caps: RecordingCapabilities | null
  loading: boolean
  checking: boolean
  onRefresh: () => void
  onCheck: () => void
  isAdmin: boolean
}) {
  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-surface-400" /></div>

  const providerLabel: Record<string, string> = {
    ISAPI: 'ISAPI (nativo)',
    HIKVISION_SDK: 'Hikvision SDK',
    MEDIAMTX_LOCAL: 'MediaMTX local',
    MANUAL_NVR: 'Web del NVR (manual)',
    UNSUPPORTED: 'No soportado',
  }

  const providerColor: Record<string, string> = {
    ISAPI: 'text-green-400',
    HIKVISION_SDK: 'text-blue-400',
    MEDIAMTX_LOCAL: 'text-purple-400',
    MANUAL_NVR: 'text-amber-400',
    UNSUPPORTED: 'text-red-400',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 justify-end">
        <button onClick={onRefresh} disabled={loading} className="btn-ghost text-xs">
          <RefreshCw size={12} /> Actualizar
        </button>
        {isAdmin && (
          <button onClick={onCheck} disabled={checking} className="btn-secondary text-xs">
            {checking ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
            {checking ? 'Verificando...' : 'Revalidar compatibilidad'}
          </button>
        )}
      </div>

      {!caps ? (
        <div className="card p-8 text-center space-y-2">
          <Film size={20} className="mx-auto text-surface-500" />
          <p className="text-sm text-surface-400">Sin datos de capacidades — haz clic en "Revalidar compatibilidad"</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-medium text-surface-200 flex items-center gap-2">
              <Film size={14} className="text-surface-400" />
              Proveedor de grabaciones
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-surface-500 mb-1">Proveedor activo</div>
                <span className={clsx('text-sm font-medium', providerColor[caps.recordingProvider] ?? 'text-surface-300')}>
                  {providerLabel[caps.recordingProvider] ?? caps.recordingProvider}
                </span>
              </div>
              <div>
                <div className="text-xs text-surface-500 mb-1">ISAPI de búsqueda</div>
                <span className={clsx('text-sm font-medium flex items-center gap-1',
                  caps.supportsIsapiRecording ? 'text-green-400'
                    : caps.recordingCapabilityErrorCode === 'AUTH_FAILED' ? 'text-amber-400'
                    : caps.recordingCapabilityErrorCode === 'INVALID_REQUEST' ? 'text-yellow-400'
                    : caps.supportsIsapiRecording === false ? 'text-red-400'
                    : 'text-surface-400'
                )}>
                  {caps.supportsIsapiRecording === true && <><CheckCircle2 size={12} /> Soportado</>}
                  {caps.supportsIsapiRecording === false && caps.recordingCapabilityErrorCode === 'AUTH_FAILED' && <><Lock size={12} /> Error de autenticación</>}
                  {caps.supportsIsapiRecording === null && caps.recordingCapabilityErrorCode === 'INVALID_REQUEST' && <><AlertTriangle size={12} /> XML rechazado (400)</>}
                  {caps.supportsIsapiRecording === false && caps.recordingCapabilityErrorCode === 'INVALID_REQUEST' && <><AlertTriangle size={12} /> XML rechazado (400)</>}
                  {caps.supportsIsapiRecording === false && caps.recordingCapabilityErrorCode !== 'AUTH_FAILED' && caps.recordingCapabilityErrorCode !== 'INVALID_REQUEST' && <><XCircle size={12} /> No soportado</>}
                  {caps.supportsIsapiRecording === null && !caps.recordingCapabilityErrorCode && '—'}
                </span>
              </div>
              <div>
                <div className="text-xs text-surface-500 mb-1">Última verificación</div>
                <span className="text-xs text-surface-400">
                  {caps.recordingCapabilityAt ? format(new Date(caps.recordingCapabilityAt), 'dd/MM/yyyy HH:mm') : '—'}
                </span>
              </div>
            </div>

            {caps.recordingCapabilityError && (
              <div className="flex items-start gap-2 p-2 bg-red-900/20 border border-red-700/40 rounded text-xs text-red-400">
                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                <span>{caps.recordingCapabilityError}</span>
              </div>
            )}
          </div>

          {caps.playbackWebUrl && (
            <div className="card p-4 space-y-2">
              <h3 className="text-sm font-medium text-surface-200 flex items-center gap-2">
                <ExternalLink size={14} className="text-surface-400" />
                Reproducción web
              </h3>
              <a
                href={caps.playbackWebUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary text-xs inline-flex items-center gap-1.5"
              >
                <ExternalLink size={12} /> Abrir reproducción web del NVR
              </a>
            </div>
          )}

          {caps.recordingProvider === 'MANUAL_NVR' && !caps.playbackWebUrl && (
            <div className="card p-4 bg-amber-900/10 border-amber-700/30">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-400">Reproducción manual requerida</p>
                  <p className="text-xs text-surface-400 mt-1">
                    ISAPI no está soportado. Configura la URL de reproducción web del NVR para que los usuarios puedan acceder a las grabaciones.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
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
