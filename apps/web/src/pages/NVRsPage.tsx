// src/pages/NVRsPage.tsx
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, RefreshCw, Server, Wifi, WifiOff, Zap, Search, CheckCircle2, XCircle, Radar, Lock, ChevronRight, AlertTriangle } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
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

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail' | 'warn'

interface DiscoveredDevice {
  ip: string
  port: number
  requiresAuth: boolean
  model?: string
  serialNumber?: string
  firmware?: string
  macAddress?: string
  deviceName?: string
  channels?: number
}

export function NVRsPage() {
  const { nvrs, nvrStatuses, loadNVRs, loadNVRStatus } = useCameraStore()
  const navigate = useNavigate()
  const [showModal, setShowModal] = useState(false)
  const [editingNVR, setEditingNVR] = useState<NVR | null>(null)
  const [form, setForm] = useState<NVRFormData>(EMPTY)
  const [isSaving, setIsSaving] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [testHint, setTestHint] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [search, setSearch] = useState('')
  // NVR IDs con credencial inválida detectada (DECRYPT_ERROR)
  const [decryptErrors, setDecryptErrors] = useState<Set<string>>(new Set())

  // ── Discovery (escaneo de red) ──────────────────────────────
  const [showScan, setShowScan] = useState(false)
  const [scanSubnet, setScanSubnet] = useState('192.168.1')
  const [scanStart, setScanStart] = useState(1)
  const [scanEnd, setScanEnd] = useState(254)
  const [scanUser, setScanUser] = useState('admin')
  const [scanPass, setScanPass] = useState('')
  const [scanning, setScanning] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([])
  const [scanInfo, setScanInfo] = useState<string>('')

  useEffect(() => { loadNVRs() }, [])
  useEffect(() => { nvrs.forEach((n) => loadNVRStatus(n.id)) }, [nvrs.length])

  const resetTest = () => { setTestStatus('idle'); setTestMsg(''); setTestHint('') }

  const openCreate = () => {
    setEditingNVR(null)
    setForm(EMPTY)
    resetTest()
    setShowModal(true)
  }
  const openEdit = (nvr: NVR) => {
    setEditingNVR(nvr)
    setForm({
      name: nvr.name, model: nvr.model, ipAddress: nvr.ipAddress, port: nvr.port,
      rtspPort: nvr.rtspPort, username: nvr.username || 'admin', password: '',
      channels: nvr.channels, hddCount: nvr.hddCount, location: nvr.location || '',
    })
    resetTest()
    setShowModal(true)
  }

  const handleTestConnection = async () => {
    // En modo edición sin contraseña: el backend usa la credencial guardada (vía nvrId)
    // En modo creación: la contraseña es obligatoria
    if (!editingNVR && (!form.ipAddress || !form.username || !form.password)) {
      toast.error('Ingresa IP, usuario y contraseña para probar')
      return
    }
    if (!form.ipAddress || !form.username) {
      toast.error('Ingresa IP y usuario para probar')
      return
    }
    setTestStatus('testing')
    setTestMsg('')
    setTestHint('')
    try {
      const payload: Record<string, unknown> = {
        ipAddress: form.ipAddress, port: form.port, username: form.username,
      }
      if (form.password) {
        payload.password = form.password
      } else if (editingNVR) {
        payload.nvrId = editingNVR.id  // backend usará la credencial guardada
      }
      const res = await apiPost<{
        success: boolean; firmware?: string; model?: string
        errorCode?: string; warning?: string; hint?: string
      }>('/nvrs/test-connection', payload)
      if (res.success) {
        if (res.errorCode === 'ISAPI_PERMISSION_DENIED') {
          setTestStatus('warn')
          setTestMsg(res.warning || 'Acceso parcial al NVR')
          setTestHint(res.hint || '')
        } else {
          setTestStatus('ok')
          const parts = ['Conexión exitosa']
          if (res.model)    parts.push(`Modelo: ${res.model}`)
          if (res.firmware) parts.push(`Firmware: ${res.firmware}`)
          setTestMsg(parts.join(' · '))
          setTestHint('')
        }
      } else {
        setTestStatus('fail')
        setTestMsg('Sin respuesta del NVR')
        setTestHint('')
      }
    } catch (err: any) {
      setTestStatus('fail')
      const data = err?.response?.data || {}
      const code = data.errorCode || ''
      if (code === 'DECRYPT_ERROR' && editingNVR) {
        setDecryptErrors((prev) => new Set(prev).add(editingNVR.id))
      }
      setTestMsg(data.message || 'No se pudo conectar. Verifica IP, puerto y credenciales.')
      setTestHint(data.hint || '')
    }
  }

  const handleAutoDetect = async () => {
    if (!editingNVR && (!form.ipAddress || !form.username || !form.password)) {
      toast.error('Ingresa IP, usuario y contraseña para detectar')
      return
    }
    if (!form.ipAddress || !form.username) {
      toast.error('Ingresa IP y usuario para detectar')
      return
    }
    setDetecting(true)
    setTestMsg('')
    setTestHint('')
    try {
      const payload: Record<string, unknown> = {
        ipAddress: form.ipAddress, port: form.port, username: form.username,
      }
      if (form.password) {
        payload.password = form.password
      } else if (editingNVR) {
        payload.nvrId = editingNVR.id
      }
      const res = await apiPost<{
        success: boolean; model?: string; serialNumber?: string
        firmware?: string; channels?: number; warning?: string; hint?: string
      }>('/nvrs/detect', payload)
      if (res.success) {
        setForm((prev) => ({
          ...prev,
          model: res.model || prev.model,
          channels: res.channels || prev.channels,
        }))
        const parts = [`Detectado: ${res.model || 'NVR'} · ${res.channels || '?'} canales`]
        if (res.firmware) parts.push(`Firmware: ${res.firmware}`)
        toast.success(parts.join(' · '))
        setTestStatus(res.warning ? 'warn' : 'ok')
        setTestMsg(res.warning || (res.firmware ? `Firmware: ${res.firmware}` : 'Conectado'))
        setTestHint(res.hint || '')
      } else {
        setTestStatus('fail')
        setTestMsg('No se pudo detectar el NVR')
        setTestHint('')
      }
    } catch (err: any) {
      setTestStatus('fail')
      const data = err?.response?.data || {}
      const code = data.errorCode || ''
      if (code === 'DECRYPT_ERROR' && editingNVR) {
        setDecryptErrors((prev) => new Set(prev).add(editingNVR.id))
      }
      const msg = data.message || 'No se pudo detectar el NVR. Verifica IP, usuario y contraseña.'
      setTestMsg(msg)
      setTestHint(data.hint || '')
      toast.error(msg)
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
        // Solo enviar password si fue realmente escrita (no vacío, no máscara)
        if (!payload.password?.trim()) {
          delete payload.password
        }
        await apiPut(`/nvrs/${editingNVR.id}`, payload)
        // Si se guardó nueva contraseña, limpiar el flag de decrypt error
        if (payload.password) {
          setDecryptErrors((prev) => {
            const next = new Set(prev)
            next.delete(editingNVR.id)
            return next
          })
        }
        toast.success('NVR actualizado')
      } else {
        const created = await apiPost<{ id: string; name: string }>('/nvrs', form)
        setShowModal(false)
        loadNVRs()
        toast.success(`NVR "${created.name}" agregado — sincronizando cámaras en segundo plano...`)
        navigate(`/nvrs/${created.id}`)
        return
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

  const handleSyncStreams = async (nvrId: string) => {
    setSyncing(nvrId)
    try {
      const res = await apiPost<{ synced: number; failed: number; total: number }>(`/nvrs/${nvrId}/sync-streams`)
      toast.success(`Streams sincronizados: ${res.synced}/${res.total}`)
    } catch {
      toast.error('Error al sincronizar streams')
    } finally {
      setSyncing(null)
    }
  }

  const handleScan = async () => {
    if (!scanSubnet.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      toast.error('Subnet inválida. Formato: 192.168.1')
      return
    }
    setScanning(true)
    setDiscovered([])
    setScanInfo('')
    try {
      const res = await apiPost<{ scanned: number; discovered: DiscoveredDevice[] }>('/nvrs/scan', {
        subnet: scanSubnet,
        port: 80,
        start: scanStart,
        end: scanEnd,
        username: scanUser || undefined,
        password: scanPass || undefined,
      })
      setDiscovered(res.discovered)
      setScanInfo(`Escaneadas ${res.scanned} IPs · ${res.discovered.length} dispositivos encontrados`)
      if (res.discovered.length === 0) {
        toast('No se encontraron dispositivos en el rango', { icon: 'ℹ️' })
      } else {
        toast.success(`${res.discovered.length} dispositivos encontrados`)
      }
    } catch {
      // toast por interceptor
    } finally {
      setScanning(false)
    }
  }

  const handleAddDiscovered = (dev: DiscoveredDevice) => {
    setEditingNVR(null)
    setForm({
      ...EMPTY,
      ipAddress: dev.ip,
      port: dev.port,
      model: dev.model || '',
      channels: dev.channels && dev.channels > 0 ? dev.channels : 16,
      name: dev.deviceName || `NVR ${dev.ip}`,
      username: scanUser || 'admin',
      password: scanPass || '',
    })
    setTestStatus('idle')
    setTestMsg('')
    setShowScan(false)
    setShowModal(true)
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
        <div className="flex gap-2">
          <button
            onClick={() => setShowScan(!showScan)}
            className={clsx('btn-secondary', showScan && 'bg-brand-600 text-white border-brand-600')}
          >
            <Radar size={14} /> Buscar en red
          </button>
          <button onClick={openCreate} className="btn-primary"><Plus size={14} /> Agregar NVR</button>
        </div>
      </div>

      {/* ── Panel de descubrimiento ── */}
      {showScan && (
        <div className="card p-4 space-y-3 border-brand-600/30">
          <div className="flex items-center gap-2">
            <Radar size={14} className="text-brand-400" />
            <h3 className="text-sm font-semibold text-surface-100">Buscar dispositivos en la red</h3>
          </div>
          <p className="text-xs text-surface-400">
            Escanea un rango de IPs para encontrar NVRs y cámaras Hikvision compatibles con ISAPI.
            Las credenciales son opcionales (sin ellas solo se detecta presencia).
          </p>

          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-4">
              <label className="label">Subnet (sin último octeto)</label>
              <input
                className="input text-xs font-mono"
                placeholder="192.168.1"
                value={scanSubnet}
                onChange={(e) => setScanSubnet(e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Desde</label>
              <input
                className="input text-xs" type="number" min={1} max={254}
                value={scanStart} onChange={(e) => setScanStart(Number(e.target.value))}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Hasta</label>
              <input
                className="input text-xs" type="number" min={1} max={254}
                value={scanEnd} onChange={(e) => setScanEnd(Number(e.target.value))}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Usuario (opc.)</label>
              <input
                className="input text-xs" placeholder="admin"
                value={scanUser} onChange={(e) => setScanUser(e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Contraseña (opc.)</label>
              <input
                className="input text-xs" type="password" placeholder="••••••••"
                value={scanPass} onChange={(e) => setScanPass(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={handleScan} disabled={scanning} className="btn-primary text-xs">
              {scanning ? (
                <><RefreshCw size={12} className="animate-spin" /> Escaneando {scanEnd - scanStart + 1} IPs...</>
              ) : (
                <><Radar size={12} /> Iniciar escaneo</>
              )}
            </button>
            {scanInfo && <span className="text-xs text-surface-400">{scanInfo}</span>}
          </div>

          {/* Resultados */}
          {discovered.length > 0 && (
            <div className="border-t border-surface-700 pt-3">
              <p className="text-xs font-medium text-surface-400 uppercase tracking-wider mb-2">
                Dispositivos encontrados
              </p>
              <div className="overflow-auto max-h-80">
                <table className="w-full text-xs">
                  <thead className="text-surface-500 sticky top-0 bg-surface-800">
                    <tr className="border-b border-surface-700">
                      <th className="text-left py-2 px-2 font-medium">IP</th>
                      <th className="text-left py-2 px-2 font-medium">Modelo</th>
                      <th className="text-left py-2 px-2 font-medium">Serie</th>
                      <th className="text-left py-2 px-2 font-medium">Firmware</th>
                      <th className="text-left py-2 px-2 font-medium">Canales</th>
                      <th className="text-left py-2 px-2 font-medium">Estado</th>
                      <th className="text-right py-2 px-2 font-medium">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="text-surface-200">
                    {discovered.map((dev) => {
                      const alreadyAdded = nvrs.some((n) => n.ipAddress === dev.ip)
                      return (
                        <tr key={dev.ip} className="border-b border-surface-700/50 hover:bg-surface-700/30">
                          <td className="py-2 px-2 font-mono">{dev.ip}:{dev.port}</td>
                          <td className="py-2 px-2 truncate max-w-[160px]" title={dev.model}>{dev.model || '—'}</td>
                          <td className="py-2 px-2 font-mono text-surface-400 truncate max-w-[140px]" title={dev.serialNumber}>{dev.serialNumber || '—'}</td>
                          <td className="py-2 px-2 text-surface-400">{dev.firmware || '—'}</td>
                          <td className="py-2 px-2">{dev.channels || '—'}</td>
                          <td className="py-2 px-2">
                            {dev.requiresAuth ? (
                              <span className="inline-flex items-center gap-1 text-amber-400">
                                <Lock size={10} /> Requiere clave
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-green-400">
                                <CheckCircle2 size={10} /> Detectado
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-right">
                            {alreadyAdded ? (
                              <span className="text-xs text-surface-500">Ya agregado</span>
                            ) : (
                              <button
                                onClick={() => handleAddDiscovered(dev)}
                                className="btn-primary text-xs px-2 py-1"
                              >
                                <Plus size={10} /> Agregar
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

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
          // Usar live status si disponible, fallback a estado guardado en DB (health worker)
          const isOnline = status?.online ?? nvr.online
          return (
            <div key={nvr.id} className="card p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className={clsx(
                    'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                    isOnline ? 'bg-green-900/40' : 'bg-surface-700'
                  )}>
                    <Server size={16} className={isOnline ? 'text-green-400' : 'text-surface-500'} />
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
                  <button
                    onClick={() => handleSyncStreams(nvr.id)}
                    className={clsx('btn-ghost p-1.5', syncing === nvr.id && 'animate-pulse text-brand-400')}
                    title="Re-sincronizar streams con MediaMTX"
                  >
                    <Zap size={12} />
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
                  {isOnline
                    ? <><Wifi size={12} className="text-green-400" /><span className="text-xs text-green-400">Online</span></>
                    : <><WifiOff size={12} className="text-red-400" /><span className="text-xs text-red-400">Offline</span></>
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
              {decryptErrors.has(nvr.id) && (
                <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded bg-red-900/30 text-red-400 text-xs">
                  <AlertTriangle size={11} />
                  Credencial guardada inválida — vuelva a guardar la contraseña del NVR
                </div>
              )}

              <div className="mt-3 pt-3 border-t border-surface-700">
                <Link
                  to={`/nvrs/${nvr.id}`}
                  className="btn-secondary w-full flex items-center justify-center gap-1.5 text-xs"
                >
                  <ChevronRight size={12} /> Ver detalle
                </Link>
              </div>
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
                    <input
                      className="input"
                      type="password"
                      placeholder={editingNVR ? 'Dejar vacío para conservar la contraseña actual' : 'Contraseña del NVR'}
                      value={form.password}
                      onChange={f('password')}
                      autoComplete="new-password"
                    />
                  </div>
                </div>

                {/* Alerta DECRYPT_ERROR en el modal */}
                {editingNVR && decryptErrors.has(editingNVR.id) && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-900/30 border border-red-700/40 text-red-400 text-xs">
                    <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                    <span>
                      La contraseña guardada no se puede descifrar (clave de cifrado cambiada).
                      <strong className="block mt-0.5">Reingresa la contraseña real del NVR y pulsa Actualizar.</strong>
                    </span>
                  </div>
                )}

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
                    'flex flex-col gap-1.5 text-xs px-3 py-2 rounded-lg',
                    testStatus === 'ok'      ? 'bg-green-900/30 text-green-400' :
                    testStatus === 'warn'    ? 'bg-amber-900/30 text-amber-400' :
                    testStatus === 'testing' ? 'bg-surface-700 text-surface-400' :
                                               'bg-red-900/30 text-red-400'
                  )}>
                    <div className="flex items-center gap-2">
                      {testStatus === 'ok'      ? <CheckCircle2 size={12} /> :
                       testStatus === 'warn'    ? <AlertTriangle size={12} /> :
                       testStatus === 'testing' ? <RefreshCw size={12} className="animate-spin" /> :
                                                  <XCircle size={12} />}
                      <span>{testStatus === 'testing' ? 'Probando conexión...' : testMsg}</span>
                    </div>
                    {testHint && (
                      <p className="text-[10px] leading-tight opacity-80 pl-5">{testHint}</p>
                    )}
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
