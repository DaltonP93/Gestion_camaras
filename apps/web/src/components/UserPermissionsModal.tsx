// src/components/UserPermissionsModal.tsx
import { useEffect, useState, useCallback } from 'react'
import {
  X, Check, Shield, Server, Video, Download, Zap,
  Radio, RefreshCw, Settings, Bell, Eye, Film, AlertTriangle,
  Database, Star, UserCheck, Monitor, Layout, ToggleLeft,
} from 'lucide-react'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'
import { apiGet, apiPut } from '@/lib/api'
import type {
  User, NVR, Camera,
  UserFeaturePermissions, NvrPermission, CameraPermission,
  UserPermissionData,
} from '@/types'

// ─── Feature permission definitions ──────────────────────────────────────────

type FeatKey = keyof UserFeaturePermissions

interface FeatDef { key: FeatKey; label: string; icon: React.ReactNode }

const FEATURE_DEFS: { section: string; items: FeatDef[] }[] = [
  {
    section: 'Módulos',
    items: [
      { key: 'canViewDashboard',    label: 'Ver Dashboard',          icon: <Layout size={12} /> },
      { key: 'canViewLive',         label: 'Ver en vivo',            icon: <Monitor size={12} /> },
      { key: 'canViewRecordings',   label: 'Ver grabaciones',        icon: <Film size={12} /> },
      { key: 'canViewAlerts',       label: 'Ver alertas',            icon: <AlertTriangle size={12} /> },
      { key: 'canViewDiagnostics',  label: 'Ver diagnósticos',       icon: <Database size={12} /> },
    ],
  },
  {
    section: 'Administración',
    items: [
      { key: 'canManageNVRs',       label: 'Administrar NVRs',       icon: <Server size={12} /> },
      { key: 'canManageCameras',    label: 'Administrar cámaras',    icon: <Video size={12} /> },
      { key: 'canManageUsers',      label: 'Administrar usuarios',   icon: <UserCheck size={12} /> },
      { key: 'canManageAppearance', label: 'Administrar apariencia', icon: <Star size={12} /> },
    ],
  },
  {
    section: 'Acciones',
    items: [
      { key: 'canResolveAlerts',    label: 'Resolver alertas',           icon: <Check size={12} /> },
      { key: 'canRestartStreams',    label: 'Reiniciar streams',          icon: <RefreshCw size={12} /> },
      { key: 'canTranscode',        label: 'Transcodificar',             icon: <Zap size={12} /> },
      { key: 'canDownloadRecordings', label: 'Descargar grabaciones',    icon: <Download size={12} /> },
      { key: 'canManageViews',      label: 'Gestionar vistas',           icon: <ToggleLeft size={12} /> },
      { key: 'canManageSettings',   label: 'Gestionar ajustes',          icon: <Settings size={12} /> },
    ],
  },
]

// ─── NVR permission field labels ──────────────────────────────────────────────

type NvrField = Exclude<keyof NvrPermission, 'id' | 'nvrId' | 'nvr'>

const NVR_FIELDS: { field: NvrField; label: string }[] = [
  { field: 'canView',           label: 'Ver NVR' },
  { field: 'canViewCameras',    label: 'Ver cámaras' },
  { field: 'canViewRecordings', label: 'Ver grabaciones' },
  { field: 'canManage',         label: 'Administrar' },
  { field: 'canEditVideoAudio', label: 'Editar video/audio' },
  { field: 'canSync',           label: 'Sincronizar' },
  { field: 'canRevalidate',     label: 'Revalidar' },
  { field: 'canRestart',        label: 'Reiniciar' },
]

// ─── Camera permission field labels ───────────────────────────────────────────

type CamField = Exclude<keyof CameraPermission, 'id' | 'cameraId' | 'camera'>

const CAM_FIELDS: { field: CamField; label: string }[] = [
  { field: 'canView',          label: 'Ver' },
  { field: 'canViewLive',      label: 'Ver live' },
  { field: 'canPlayback',      label: 'Grabaciones' },
  { field: 'canDownload',      label: 'Descargar' },
  { field: 'canHighQuality',   label: 'Alta calidad' },
  { field: 'canUseMainStream', label: 'Main stream' },
  { field: 'canUseTranscode',  label: 'Transcode' },
  { field: 'canAddToViews',    label: 'Agregar a vistas' },
  { field: 'canReceiveAlerts', label: 'Alertas' },
]

// ─── Default factories ────────────────────────────────────────────────────────

function defaultNvrPerm(nvrId: string): NvrPermission {
  return {
    nvrId, canView: false, canViewCameras: false, canViewRecordings: false,
    canManage: false, canEditVideoAudio: false, canSync: false,
    canRevalidate: false, canRestart: false,
  }
}

function defaultCamPerm(cameraId: string): CameraPermission {
  return {
    cameraId, canView: false, canViewLive: false, canPlayback: false,
    canDownload: false, canHighQuality: false, canUseMainStream: false,
    canUseTranscode: false, canAddToViews: false, canReceiveAlerts: false,
  }
}

function allTrueNvrPerm(nvrId: string): NvrPermission {
  return {
    nvrId, canView: true, canViewCameras: true, canViewRecordings: true,
    canManage: true, canEditVideoAudio: true, canSync: true,
    canRevalidate: true, canRestart: true,
  }
}

function allTrueCamPerm(cameraId: string): CameraPermission {
  return {
    cameraId, canView: true, canViewLive: true, canPlayback: true,
    canDownload: true, canHighQuality: true, canUseMainStream: true,
    canUseTranscode: true, canAddToViews: true, canReceiveAlerts: true,
  }
}

// ─── Toggle component ─────────────────────────────────────────────────────────

function Toggle({
  label, checked, onChange, disabled = false,
}: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <label className={clsx(
      'flex items-center gap-1.5 cursor-pointer select-none',
      disabled && 'opacity-40 cursor-not-allowed'
    )}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-brand-500"
        disabled={disabled}
      />
      <span className="text-xs text-surface-300">{label}</span>
    </label>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

type Tab = 'features' | 'nvrs' | 'cameras'

interface Props {
  user: User
  onClose: () => void
}

export function UserPermissionsModal({ user, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('features')
  const [nvrs, setNvrs]       = useState<NVR[]>([])
  const [cameras, setCameras] = useState<Camera[]>([])
  const [featurePerms, setFeaturePerms] = useState<Partial<UserFeaturePermissions>>({})
  const [nvrPerms, setNvrPerms]         = useState<NvrPermission[]>([])
  const [camPerms, setCamPerms]         = useState<CameraPermission[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving]   = useState(false)

  const isAdmin = user.role === 'ADMIN'

  useEffect(() => {
    setIsLoading(true)
    Promise.all([
      apiGet<NVR[]>('/nvrs'),
      apiGet<Camera[]>('/cameras'),
      apiGet<UserPermissionData>(`/users/${user.id}/permissions`),
    ]).then(([n, c, data]) => {
      setNvrs(n)
      setCameras(c)
      setFeaturePerms(data.featurePermissions ?? {})
      setNvrPerms(data.nvrPermissions ?? [])
      setCamPerms(data.cameraPermissions ?? [])
    }).catch(() => {
      toast.error('Error al cargar permisos')
    }).finally(() => setIsLoading(false))
  }, [user.id])

  // ─── NVR perm helpers ─────────────────────────────────────────

  const getNvrPerm = useCallback((nvrId: string): NvrPermission => {
    return nvrPerms.find((p) => p.nvrId === nvrId) ?? defaultNvrPerm(nvrId)
  }, [nvrPerms])

  const setNvrField = (nvrId: string, field: NvrField, value: boolean) => {
    setNvrPerms((prev) => {
      const idx = prev.findIndex((p) => p.nvrId === nvrId)
      const entry = idx >= 0 ? { ...prev[idx] } : defaultNvrPerm(nvrId)
      entry[field] = value
      if (idx >= 0) { const c = [...prev]; c[idx] = entry; return c }
      return [...prev, entry]
    })
  }

  const setNvrAll = (nvrId: string, allTrue: boolean) => {
    setNvrPerms((prev) => {
      const filtered = prev.filter((p) => p.nvrId !== nvrId)
      return [...filtered, allTrue ? allTrueNvrPerm(nvrId) : defaultNvrPerm(nvrId)]
    })
  }

  // ─── Camera perm helpers ──────────────────────────────────────

  const getCamPerm = useCallback((cameraId: string): CameraPermission => {
    return camPerms.find((p) => p.cameraId === cameraId) ?? defaultCamPerm(cameraId)
  }, [camPerms])

  const setCamField = (cameraId: string, field: CamField, value: boolean) => {
    setCamPerms((prev) => {
      const idx = prev.findIndex((p) => p.cameraId === cameraId)
      const entry = idx >= 0 ? { ...prev[idx] } : defaultCamPerm(cameraId)
      entry[field] = value
      if (idx >= 0) { const c = [...prev]; c[idx] = entry; return c }
      return [...prev, entry]
    })
  }

  const setCamAllForNvr = (nvrId: string, allTrue: boolean) => {
    const nvCams = cameras.filter((c) => c.nvrId === nvrId)
    setCamPerms((prev) => {
      const filtered = prev.filter((p) => !nvCams.some((c) => c.id === p.cameraId))
      const additions = nvCams.map((c) => allTrue ? allTrueCamPerm(c.id) : defaultCamPerm(c.id))
      return [...filtered, ...additions]
    })
  }

  // Inherit camera perms from NVR: copy NVR bool fields to camera
  const inheritFromNvr = (camera: Camera) => {
    const nvPerm = getNvrPerm(camera.nvrId)
    setCamPerms((prev) => {
      const filtered = prev.filter((p) => p.cameraId !== camera.id)
      const entry: CameraPermission = {
        cameraId:        camera.id,
        canView:         nvPerm.canView,
        canViewLive:     nvPerm.canViewCameras,
        canPlayback:     nvPerm.canViewRecordings,
        canDownload:     nvPerm.canViewRecordings,
        canHighQuality:  false,
        canUseMainStream: false,
        canUseTranscode:  false,
        canAddToViews:    nvPerm.canViewCameras,
        canReceiveAlerts: false,
      }
      return [...filtered, entry]
    })
  }

  // ─── Save ─────────────────────────────────────────────────────

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await apiPut(`/users/${user.id}/permissions`, {
        featurePermissions: featurePerms,
        nvrPermissions:     nvrPerms,
        cameraPermissions:  camPerms,
      })
      toast.success('Permisos guardados correctamente')
    } finally {
      setIsSaving(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface-800 border border-surface-700 rounded-xl max-w-3xl w-full mx-4 max-h-[90vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-surface-700 flex-shrink-0">
          <div className="w-8 h-8 rounded-full bg-brand-700 flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
            {user.fullName.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-surface-100">{user.fullName}</div>
            <div className="text-xs text-surface-500">{user.username} · Gestión de permisos granulares</div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Admin banner */}
        {isAdmin && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-brand-900/30 border border-brand-700/30 text-xs text-brand-300 flex items-center gap-2 flex-shrink-0">
            <Shield size={12} className="flex-shrink-0" />
            Los administradores tienen acceso completo a todas las funciones y recursos.
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3 flex-shrink-0">
          {([
            { id: 'features', label: 'Funcionalidades' },
            { id: 'nvrs',     label: 'NVRs' },
            { id: 'cameras',  label: 'Cámaras' },
          ] as { id: Tab; label: string }[]).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
                tab === id
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-600'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
          {isLoading ? (
            <div className="text-center py-16 text-surface-500 text-sm">Cargando permisos...</div>
          ) : (
            <>
              {/* ── Funcionalidades ── */}
              {tab === 'features' && (
                <div className="space-y-3">
                  {FEATURE_DEFS.map(({ section, items }) => (
                    <div key={section} className="border border-surface-700 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-surface-750 text-[10px] font-semibold text-surface-400 uppercase tracking-wider">
                        {section}
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-0 divide-y divide-surface-700/50">
                        {items.map(({ key, label, icon }) => (
                          <label
                            key={key}
                            className={clsx(
                              'flex items-center gap-2.5 px-3 py-2.5 hover:bg-surface-700/30 cursor-pointer transition-colors',
                              isAdmin && 'opacity-50 cursor-not-allowed'
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={isAdmin ? true : (featurePerms[key] ?? false)}
                              onChange={(e) => setFeaturePerms((prev) => ({ ...prev, [key]: e.target.checked }))}
                              className="accent-brand-500"
                              disabled={isAdmin}
                            />
                            <span className="text-surface-400 flex-shrink-0">{icon}</span>
                            <span className="text-xs text-surface-200">{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── NVRs ── */}
              {tab === 'nvrs' && (
                <div className="space-y-3">
                  {nvrs.length === 0 ? (
                    <div className="text-center py-12 text-surface-500 text-sm">No hay NVRs configurados</div>
                  ) : nvrs.map((nvr) => {
                    const perm = getNvrPerm(nvr.id)
                    return (
                      <div key={nvr.id} className="border border-surface-700 rounded-lg overflow-hidden">
                        {/* NVR header */}
                        <div className="flex items-center gap-2 px-3 py-2.5 bg-surface-750">
                          <Server size={13} className="text-surface-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium text-surface-100">{nvr.name}</span>
                            <span className="text-[10px] text-surface-500 ml-2">{nvr.model}</span>
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => setNvrAll(nvr.id, true)}
                              disabled={isAdmin}
                              className="px-2 py-0.5 text-[10px] rounded bg-brand-600/20 text-brand-400 hover:bg-brand-600/30 transition-colors disabled:opacity-40"
                            >
                              Permitir todo
                            </button>
                            <button
                              onClick={() => setNvrAll(nvr.id, false)}
                              disabled={isAdmin}
                              className="px-2 py-0.5 text-[10px] rounded bg-surface-700 text-surface-400 hover:bg-surface-600 transition-colors disabled:opacity-40"
                            >
                              Quitar todo
                            </button>
                          </div>
                        </div>

                        {/* NVR toggles */}
                        <div className="px-3 py-3 grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4">
                          {NVR_FIELDS.map(({ field, label }) => (
                            <Toggle
                              key={field}
                              label={label}
                              checked={isAdmin ? true : perm[field]}
                              onChange={(v) => setNvrField(nvr.id, field, v)}
                              disabled={isAdmin}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* ── Cámaras ── */}
              {tab === 'cameras' && (
                <div className="space-y-4">
                  {nvrs.length === 0 ? (
                    <div className="text-center py-12 text-surface-500 text-sm">No hay NVRs configurados</div>
                  ) : nvrs.map((nvr) => {
                    const nvCams = cameras.filter((c) => c.nvrId === nvr.id)
                    if (nvCams.length === 0) return null

                    return (
                      <div key={nvr.id}>
                        {/* NVR group header */}
                        <div className="flex items-center gap-2 mb-2">
                          <Server size={12} className="text-surface-400" />
                          <span className="text-xs font-semibold text-surface-300">{nvr.name}</span>
                          <div className="flex-1 h-px bg-surface-700" />
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => setCamAllForNvr(nvr.id, true)}
                              disabled={isAdmin}
                              className="px-2 py-0.5 text-[10px] rounded bg-brand-600/20 text-brand-400 hover:bg-brand-600/30 transition-colors disabled:opacity-40"
                            >
                              Permitir todo en este NVR
                            </button>
                            <button
                              onClick={() => setCamAllForNvr(nvr.id, false)}
                              disabled={isAdmin}
                              className="px-2 py-0.5 text-[10px] rounded bg-surface-700 text-surface-400 hover:bg-surface-600 transition-colors disabled:opacity-40"
                            >
                              Quitar todo en este NVR
                            </button>
                          </div>
                        </div>

                        {/* Camera rows */}
                        <div className="space-y-2">
                          {nvCams.map((cam) => {
                            const perm = getCamPerm(cam.id)
                            return (
                              <div key={cam.id} className="border border-surface-700 rounded-lg overflow-hidden">
                                {/* Camera header */}
                                <div className="flex items-center gap-2 px-3 py-2 bg-surface-750">
                                  <Radio size={11} className={clsx('flex-shrink-0', cam.online ? 'text-green-400' : 'text-surface-500')} />
                                  <span className="text-xs font-medium text-surface-200 flex-1 truncate">{cam.name}</span>
                                  <span className="text-[10px] text-surface-500">ch{cam.channel}</span>
                                  <button
                                    onClick={() => inheritFromNvr(cam)}
                                    disabled={isAdmin}
                                    className="px-2 py-0.5 text-[10px] rounded bg-surface-700 text-surface-400 hover:bg-surface-600 transition-colors disabled:opacity-40"
                                  >
                                    Heredar de NVR
                                  </button>
                                </div>

                                {/* Camera toggles */}
                                <div className="px-3 py-2.5 grid grid-cols-2 sm:grid-cols-3 gap-y-2 gap-x-4">
                                  {CAM_FIELDS.map(({ field, label }) => (
                                    <Toggle
                                      key={field}
                                      label={label}
                                      checked={isAdmin ? true : perm[field]}
                                      onChange={(v) => setCamField(cam.id, field, v)}
                                      disabled={isAdmin}
                                    />
                                  ))}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-700 flex items-center justify-between gap-2 flex-shrink-0">
          <span className="text-xs text-surface-500">
            {tab === 'features' && 'Controla acceso a módulos y acciones de la plataforma'}
            {tab === 'nvrs'     && `${nvrPerms.filter((p) => p.canView).length} NVRs con acceso`}
            {tab === 'cameras'  && `${camPerms.filter((p) => p.canView).length} cámaras con acceso`}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary" disabled={isSaving}>
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || isAdmin || isLoading}
              className="btn-primary"
            >
              {isSaving ? 'Guardando...' : <><Check size={13} /> Guardar cambios</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
