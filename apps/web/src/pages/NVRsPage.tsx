// src/pages/NVRsPage.tsx
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, RefreshCw, Server, Wifi, WifiOff } from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiPut, apiDelete } from '@/lib/api'
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

export function NVRsPage() {
  const { nvrs, nvrStatuses, loadNVRs, loadNVRStatus } = useCameraStore()
  const [showModal, setShowModal] = useState(false)
  const [editingNVR, setEditingNVR] = useState<NVR | null>(null)
  const [form, setForm] = useState<NVRFormData>(EMPTY)
  const [isSaving, setIsSaving] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)

  useEffect(() => { loadNVRs() }, [])
  useEffect(() => { nvrs.forEach((n) => loadNVRStatus(n.id)) }, [nvrs.length])

  const openCreate = () => { setEditingNVR(null); setForm(EMPTY); setShowModal(true) }
  const openEdit   = (nvr: NVR) => {
    setEditingNVR(nvr)
    setForm({ name: nvr.name, model: nvr.model, ipAddress: nvr.ipAddress, port: nvr.port,
      rtspPort: nvr.rtspPort, username: nvr.username, password: '', channels: nvr.channels,
      hddCount: nvr.hddCount, location: nvr.location || '' })
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name || !form.ipAddress || !form.username) {
      toast.error('Completa nombre, IP y usuario')
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
        if (!form.password) { toast.error('La contraseña es requerida'); return }
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

  const f = (key: keyof NVRFormData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.type === 'number' ? Number(e.target.value) : e.target.value })

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">NVRs configurados</h2>
          <p className="text-xs text-surface-400 mt-0.5">{nvrs.length} dispositivos</p>
        </div>
        <button onClick={openCreate} className="btn-primary"><Plus size={14} /> Agregar NVR</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {nvrs.map((nvr) => {
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
                  <button onClick={() => handleRefreshStatus(nvr.id)}
                    className={clsx('btn-ghost p-1.5', refreshing === nvr.id && 'animate-spin')}>
                    <RefreshCw size={12} />
                  </button>
                  <button onClick={() => openEdit(nvr)} className="btn-ghost p-1.5"><Pencil size={12} /></button>
                  <button onClick={() => handleDelete(nvr)} className="btn-ghost p-1.5 hover:text-red-400"><Trash2 size={12} /></button>
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
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-lg p-6 animate-slide-in shadow-2xl max-h-screen overflow-auto">
            <h3 className="text-sm font-semibold text-surface-100 mb-5">
              {editingNVR ? `Editar: ${editingNVR.name}` : 'Agregar NVR Hikvision'}
            </h3>
            <div className="space-y-3">
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
                  <label className="label">Usuario NVR *</label>
                  <input className="input" placeholder="admin" value={form.username} onChange={f('username')} />
                </div>
                <div>
                  <label className="label">{editingNVR ? 'Contraseña (vacío = no cambiar)' : 'Contraseña *'}</label>
                  <input className="input" type="password" placeholder="••••••••" value={form.password} onChange={f('password')} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Canales</label>
                  <input className="input" type="number" value={form.channels} onChange={f('channels')} />
                </div>
                <div>
                  <label className="label">HDDs</label>
                  <input className="input" type="number" value={form.hddCount} onChange={f('hddCount')} />
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
