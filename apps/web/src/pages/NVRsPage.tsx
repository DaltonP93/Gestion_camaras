// src/pages/NVRsPage.tsx
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, RefreshCw, Server, Wifi, WifiOff, Zap, Search, CheckCircle2, XCircle } from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiPut, apiDelete, apiGet } from '@/lib/api'
import { clsx } from 'clsx'
import type { NVR } from '@/types'
import toast from 'react-hot-toast'
import { format } from 'date-fns'

interface NVRFormData {
  name: string; model: string; ipAddress: string; port: number; rtspPort: number
  username: string; password: string; channels: number; hddCount: number; location: string
}
const EMPTY: NVRFormData = {
  name: '', model: '', ipAddress: '', port: 80, rtspPort: 554,
  username: 'admin', password: '', channels: 16, hddCount: 1, location: '',
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail'

export function NVRsPage() {
  const { nvrs, nvrStatuses, loadNVRs, loadNVRStatus } = useCameraStore()
  const [showModal, setShowModal] = useState(false)
  const [editingNVR, setEditingNVR] = useState<NVR | null>(null)
  const [form, setForm] = useState<NVRFormData>(EMPTY)
  const [isSaving, setIsSaving] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => { loadNVRs() }, [])
  useEffect(() => { nvrs.forEach((n) => loadNVRStatus(n.id)) }, [nvrs.length])

  const openCreate = () => {
    setEditingNVR(null)
    setForm(EMPTY)
    setTestStatus('idle')
    setTestMsg('')
    setShowModal(true)
  }
  const openEdit = (nvr: NVR) => {
    setEditingNVR(nvr)
    setForm({
      name: nvr.name, model: nvr.model, ipAddress: nvr.ipAddress, port: nvr.port,
      rtspPort: nvr.rtspPort, username: nvr.username || 'admin', password: '',
      channels: nvr.channels, hddCount: nvr.hddCount, location: nvr.location || '',
    })
    setTestStatus('idle')
    setTestMsg('')
    setShowModal(true)
  }

  const handleTestConnection = async () => {
    if (!form.ipAddress || !form.username || !form.password) {
      toast.error('Ingresa IP, usuario y contraseña para probar')
      return
    }
    setTestStatus('testing')
    setTestMsg('')
    try {
      const res = await apiPost<{ success: boolean; firmware?: string }>('/nvrs/test-connection', {
        ipAddress: form.ipAddress,
        port: form.port,
        username: form.username,
        password: form.password,
      })
      if (res.success) {
        setTestStatus('ok')
        setTestMsg(res.firmware ? `Conectado — Firmware: ${res.firmware}` : 'Conexión exitosa')
      } else {
        setTestStatus('fail')
        setTestMsg('Sin respuesta del NVR')
      }
    } catch {
      setTestStatus('fail')
      setTestMsg('No se pudo conectar. Verifica IP, puerto y credenciales.')
    }
  }

  const handleAutoDetect = async () => {
    if (!form.ipAddress || !form.username || !form.password) {
      toast.error('Ingresa IP, usuario y contraseña para detectar')
      return
    }
    setDetecting(true)
    try {
      const res = await apiPost<{
        success: boolean; model?: string; serialNumber?: string
        firmware?: string; channels?: number
      }>('/nvrs/detect', {
        ipAddress: form.ipAddress,
        port: form.port,
        username: form.username,
        password: form.password,
      })
      if (res.success) {
        setForm((prev) => ({
          ...prev,
          model: res.model || prev.model,
          channels: res.channels || prev.channels,
        }))
        toast.success(`Detectado: ${res.model || 'NVR'} · ${res.channels || '?'} canales`)
        setTestStatus('ok')
        setTestMsg(res.firmware ? `Firmware: ${res.firmware}` : 'Conectado')
      } else {
        toast.error('No se pudo detectar el NVR')
      }
    } catch {
      toast.error('Error al intentar detectar el NVR')
    } finally {
      setDetecting(false)
    }
  }

  const handleSave = async () => {
    if (!form.ipAddress || !form.username) {
      toast.error('IP y usuario son obligatorios')
      return
    }
    if (!form.name) {
      toast.error('El nombre es obligatorio')
      return
    }
    if (!editingNVR && !form.password) {
      toast.error('La contraseña es obligatoria al crear el NVR')
      return
    }
    setIsSaving(true)
    try {
      if (editingNVR) {
        const payload: Partial<NVRFormData> = { ...form }
        if (!payload.password) delete payload.password
        await apiPut(`/nvrs/${editingNVR.id}`, payload)
        toast.success('NVR actualizado')
      } else {
        await apiPost('/nvrs', form)
        toast.success('NVR agregado correctamente')
      }
      setShowModal(false)
      loadNVRs()
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (nvr: NVR) => {
    if (!confirm(`¿Eliminar NVR "${nvr.name}" y todas sus cámaras?`)) return
    try {
      await apiDelete(`/nvrs/${nvr.id}`)
      toast.success('NVR eliminado')
      loadNVRs()
    } catch {}
  }

  const handleRefreshStatus = async (nvrId: string) => {
    setRefreshing(nvrId)
    await loadNVRStatus(nvrId)
    setRefreshing(null)
  }

  const f = (key: keyof NVRFormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setTestStatus('idle')
    setForm({ ...form, [key]: e.target.type === 'number' ? Number(e.target.value) : e.target.value })
  }

  const filtered = nvrs.filter((nvr) => {
    if (!search) return true
    const s = search.toLowerCase()
    return nvr.name.toLowerCase().includes(s) ||
      nvr.model.toLowerCase().includes(s) ||
      nvr.ipAddress.includes(s) ||
      nvr.location?.toLowerCase().includes(s)
  })

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Gestión de NVRs</h2>
          <p className="text-xs text-surface-400 mt-0.5">{nvrs.length} dispositivos</p>
        </div>
        <button onClick={openCreate} className="btn-primary"><Plus size={14} /> Agregar NVR</button>
      </div>

      {/* Búsqueda */}
      <div className="relative max-w-xs">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
        <input
          className="input pl-9 text-xs"
          placeholder="Buscar por nombre, modelo, IP..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {filtered.map((nvr) => {
          const status = nvrStatuses[nvr.id]
          return (
            <div key={nvr.id} className="card p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className={clsx(
                    'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                    status?.online ? 'bg-green-900/40' : 'bg-surface-700'
                  )}>
                    <Server size={16} className={status?.online ? 'text-green-400' : 'text-surface-500'} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-surface-100">{nvr.name}</div>
                    <div className="text-xs text-surface-400">{nvr.model}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleRefreshStatus(nvr.id)}
                    className={clsx('btn-ghost p-1.5', refreshing === nvr.id && 'animate-spin')}
                    title="Actualizar estado"
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button onClick={() => openEdit(nvr)} className="btn-ghost p-1.5" title="Editar"><Pencil size={12} /></button>
                  <button onClick={() => handleDelete(nvr)} className="btn-ghost p-1.5 hover:text-red-400" title="Eliminar"><Trash2 size={12} /></button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mb-3">
                {[
                  { label: 'IP', value: `${nvr.ipAddress}:${nvr.port}` },
                  { label: 'Canales', value: nvr.channels },
                  { label: 'HDDs', value: nvr.hddCount },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-surface-900 rounded-lg p-2">
                    <div className="text-xs text-surface-500">{label}</div>
                    <div className="text-xs font-medium text-surface-200 mt-0.5 truncate">{value}</div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {status?.online
                    ? <><Wifi size={12} className="text-green-400" /><span className="text-xs text-green-400">Online</span></>
                    : <><WifiOff size={12} className="text-surface-500" /><span className="text-xs text-surface-500">Offline</span></>
                  }
                </div>
                {status && (
                  <div className="flex items-center gap-3 text-xs text-surface-500">
                    <span className={clsx(status.diskUsage > 85 ? 'text-red-400' : status.diskUsage > 70 ? 'text-amber-400' : '')}>
                      HDD {status.diskUsage}%
                    </span>
                    <span>{status.firmware}</span>
                  </div>
                )}
              </div>

              {nvr.lastSeen && (
                <div className="text-xs text-surface-600 mt-1.5">
                  Última conexión: {format(new Date(nvr.lastSeen), 'dd/MM HH:mm')}
                </div>
              )}
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="col-span-2 py-12 text-center">
            <Server size={24} className="text-surface-700 mx-auto mb-2" />
            <p className="text-sm text-surface-500">{search ? 'Sin resultados para la búsqueda' : 'No hay NVRs configurados'}</p>
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-lg p-6 animate-slide-in shadow-2xl max-h-[90vh] overflow-auto">
            <h3 className="text-sm font-semibold text-surface-100 mb-5">
              {editingNVR ? `Editar: ${editingNVR.name}` : 'Agregar NVR Hikvision'}
            </h3>

            <div className="space-y-3">
              {/* Conexión — campos obligatorios */}
              <div className="p-3 bg-surface-900 rounded-lg space-y-3">
                <p className="text-xs font-medium text-surface-400 uppercase tracking-wider">Conexión *</p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="label">Dirección IP *</label>
                    <input className="input" placeholder="192.168.1.100" value={form.ipAddress} onChange={f('ipAddress')} />
                  </div>
                  <div>
                    <label className="label">Puerto HTTP</label>
                    <input className="input" type="number" value={form.port} onChange={f('port')} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Usuario *</label>
                    <input className="input" placeholder="admin" value={form.username} onChange={f('username')} />
                  </div>
                  <div>
                    <label className="label">{editingNVR ? 'Contraseña (vacío = no cambiar)' : 'Contraseña *'}</label>
                    <input className="input" type="password" placeholder="••••••••" value={form.password} onChange={f('password')} />
                  </div>
                </div>

                {/* Botones probar/detectar */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testStatus === 'testing'}
                    className="btn-secondary text-xs flex items-center gap-1.5"
                  >
                    {testStatus === 'testing' ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <Wifi size={12} />
                    )}
                    Probar conexión
                  </button>
                  <button
                    type="button"
                    onClick={handleAutoDetect}
                    disabled={detecting}
                    className="btn-secondary text-xs flex items-center gap-1.5"
                    title="Detecta modelo, canales y firmware automáticamente"
                  >
                    {detecting ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <Zap size={12} />
                    )}
                    Auto-detectar info
                  </button>
                </div>

                {/* Resultado test */}
                {testStatus !== 'idle' && (
                  <div className={clsx(
                    'flex items-center gap-2 text-xs px-3 py-2 rounded-lg',
                    testStatus === 'ok' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'
                  )}>
                    {testStatus === 'ok' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    {testStatus === 'testing' ? 'Probando conexión...' : testMsg}
                  </div>
                )}
              </div>

              {/* Información del NVR */}
              <div className="p-3 bg-surface-900 rounded-lg space-y-3">
                <p className="text-xs font-medium text-surface-400 uppercase tracking-wider">Información del dispositivo</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Nombre *</label>
                    <input className="input" placeholder="NVR Piso 1" value={form.name} onChange={f('name')} />
                  </div>
                  <div>
                    <label className="label">Modelo</label>
                    <input className="input" placeholder="DS-7616NI-K2" value={form.model} onChange={f('model')} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="label">Canales</label>
                    <input className="input" type="number" min="1" max="128" value={form.channels} onChange={f('channels')} />
                  </div>
                  <div>
                    <label className="label">HDDs</label>
                    <input className="input" type="number" min="1" max="16" value={form.hddCount} onChange={f('hddCount')} />
                  </div>
                  <div>
                    <label className="label">Puerto RTSP</label>
                    <input className="input" type="number" value={form.rtspPort} onChange={f('rtspPort')} />
                  </div>
                </div>
                <div>
                  <label className="label">Ubicación</label>
                  <input className="input" placeholder="Edificio A, Piso 2..." value={form.location} onChange={f('location')} />
                </div>
              </div>
            </div>

            <div className="flex gap-2 mt-6 justify-end">
              <button onClick={() => setShowModal(false)} className="btn-secondary">Cancelar</button>
              <button onClick={handleSave} disabled={isSaving} className="btn-primary">
                {isSaving ? 'Guardando...' : editingNVR ? 'Actualizar' : 'Agregar NVR'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
