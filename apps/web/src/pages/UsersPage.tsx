// src/pages/UsersPage.tsx
import { useEffect, useState, useCallback } from 'react'
import {
  Plus, Pencil, Trash2, Shield, Eye, EyeOff,
  UserCheck, UserX, Search, Key, X, Check, ChevronRight,
  Server, Monitor, ShieldCheck, ShieldOff,
  Lock, Unlock, Smartphone, Zap, Settings, Clock, AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { clsx } from 'clsx'
import type { User, Role, NVR, Camera, UserPermission } from '@/types'
import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import toast from 'react-hot-toast'
import { useAuthStore } from '@/stores/authStore'

const ROLE_OPTIONS: { value: Role; label: string; color: string }[] = [
  { value: 'ADMIN',      label: 'Administrador', color: 'text-brand-400' },
  { value: 'SUPERVISOR', label: 'Supervisor',    color: 'text-blue-400' },
  { value: 'OPERATOR',   label: 'Operador',      color: 'text-green-400' },
  { value: 'AUDITOR',    label: 'Auditor',       color: 'text-amber-400' },
]

interface UserFormData {
  username:            string
  email:               string
  fullName:            string
  password:            string
  role:                Role
  forcePasswordChange: boolean
}

const EMPTY_FORM: UserFormData = {
  username: '', email: '', fullName: '', password: '', role: 'OPERATOR', forcePasswordChange: false,
}

// ─── Permissions Modal (redesigned) ─────────────────────────────────────────

interface PermMatrix {
  nvrId?:         string
  cameraId?:      string
  canView:        boolean
  canPlayback:    boolean
  canPtz:         boolean
  canHighQuality: boolean
}

function PermissionsPanel({ user, onClose }: { user: User; onClose: () => void }) {
  const [nvrs, setNvrs] = useState<NVR[]>([])
  const [cameras, setCameras] = useState<Camera[]>([])
  const [perms, setPerms] = useState<PermMatrix[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [expandedNvrs, setExpandedNvrs] = useState<Set<string>>(new Set())

  useEffect(() => {
    setIsLoading(true)
    Promise.all([
      apiGet<NVR[]>('/nvrs'),
      apiGet<Camera[]>('/cameras'),
      apiGet<User>(`/users/${user.id}`),
    ]).then(([n, c, u]) => {
      setNvrs(n)
      setCameras(c)
      setPerms(u.permissions ?? [])
      // Expand all NVRs by default
      setExpandedNvrs(new Set(n.map(nv => nv.id)))
    }).finally(() => setIsLoading(false))
  }, [user.id])

  const getPerm = useCallback((nvrId?: string, cameraId?: string): PermMatrix => {
    const found = perms.find(p => p.nvrId === nvrId && p.cameraId === cameraId)
    return found ?? { nvrId, cameraId, canView: false, canPlayback: false, canPtz: false, canHighQuality: false }
  }, [perms])

  // Checking a camera grants both view + playback (single-checkbox model)
  const toggleCamera = (nvrId: string, cameraId: string, checked: boolean) => {
    setPerms(prev => {
      const idx = prev.findIndex(p => p.nvrId === nvrId && p.cameraId === cameraId)
      if (!checked) {
        return prev.filter((_, i) => i !== idx)
      }
      const entry: PermMatrix = { nvrId, cameraId, canView: true, canPlayback: true, canPtz: false, canHighQuality: false }
      if (idx >= 0) { const copy = [...prev]; copy[idx] = entry; return copy }
      return [...prev, entry]
    })
  }

  const toggleNvrAll = (nvrId: string, checked: boolean) => {
    const nvCams = cameras.filter(c => c.nvrId === nvrId)
    setPerms(prev => {
      const next = prev.filter(p => p.nvrId !== nvrId)
      if (checked) {
        next.push({ nvrId, cameraId: undefined, canView: true, canPlayback: true, canPtz: false, canHighQuality: false })
        nvCams.forEach(cam => next.push({ nvrId, cameraId: cam.id, canView: true, canPlayback: true, canPtz: false, canHighQuality: false }))
      }
      return next
    })
  }

  const selectAllCameras = () => {
    const all: PermMatrix[] = []
    nvrs.forEach(nvr => {
      all.push({ nvrId: nvr.id, cameraId: undefined, canView: true, canPlayback: true, canPtz: false, canHighQuality: false })
      cameras.filter(c => c.nvrId === nvr.id).forEach(cam =>
        all.push({ nvrId: nvr.id, cameraId: cam.id, canView: true, canPlayback: true, canPtz: false, canHighQuality: false })
      )
    })
    setPerms(all)
  }

  const clearAllCameras = () => setPerms([])

  const handleSaveResources = async () => {
    setIsSaving(true)
    try {
      const toSave = perms.filter(p => p.canView || p.canPlayback || p.canPtz)
      await apiPost(`/users/${user.id}/permissions`, toSave)
      toast.success('Permisos de recursos guardados')
    } finally {
      setIsSaving(false)
    }
  }

  const isAdmin = user.role === 'ADMIN'
  const totalCams   = cameras.length
  const allowedCams = [...new Set(perms.filter(p => p.cameraId && p.canView).map(p => p.cameraId))].length

  const filteredNvrs = nvrs.filter(nvr => {
    if (!search) return true
    const nvrMatch = nvr.name.toLowerCase().includes(search.toLowerCase())
    const camMatch = cameras.filter(c => c.nvrId === nvr.id).some(c => c.name.toLowerCase().includes(search.toLowerCase()))
    return nvrMatch || camMatch
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-surface-800 border border-surface-600 rounded-xl flex flex-col shadow-2xl max-h-[85vh] animate-fade-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-surface-700 flex-shrink-0">
          <div className="w-9 h-9 rounded-full bg-brand-700 flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
            {user.fullName.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-surface-100">{user.fullName}</div>
            <div className="text-xs text-surface-500">@{user.username} · {ROLE_OPTIONS.find(r => r.value === user.role)?.label ?? user.role}</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-surface-400">
            <span className="px-2 py-0.5 bg-surface-700 rounded">{allowedCams}/{totalCams} cámaras</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700">
            <X size={14} />
          </button>
        </div>

        {isAdmin && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-brand-900/30 border border-brand-700/30 text-xs text-brand-300">
            Los administradores tienen acceso total independientemente de los permisos asignados.
          </div>
        )}

        {/* Body — single camera list, one checkbox per camera */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="text-center py-16 text-surface-500 text-sm">Cargando...</div>
          ) : (
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-500" />
                  <input className="input pl-7 text-xs" placeholder="Buscar NVR o cámara..." value={search} onChange={e => setSearch(e.target.value)} />
                </div>
                <button onClick={selectAllCameras} className="text-xs text-brand-400 hover:text-brand-300 whitespace-nowrap">Seleccionar todo</button>
                <button onClick={clearAllCameras} className="text-xs text-surface-400 hover:text-surface-200 whitespace-nowrap">Limpiar</button>
              </div>

              {filteredNvrs.length === 0 ? (
                <div className="text-center py-8 text-surface-500 text-xs">Sin NVRs configurados</div>
              ) : filteredNvrs.map(nvr => {
                const nvrCams = cameras.filter(c => c.nvrId === nvr.id && (!search || c.name.toLowerCase().includes(search.toLowerCase()) || nvr.name.toLowerCase().includes(search.toLowerCase())))
                if (nvrCams.length === 0) return null
                const isOpen = expandedNvrs.has(nvr.id)
                const allChecked = nvrCams.length > 0 && nvrCams.every(c => getPerm(nvr.id, c.id).canView)
                const someChecked = nvrCams.some(c => getPerm(nvr.id, c.id).canView)
                const checkedCount = nvrCams.filter(c => getPerm(nvr.id, c.id).canView).length

                return (
                  <div key={nvr.id} className="border border-surface-700 rounded-lg overflow-hidden">
                    {/* NVR header row */}
                    <div className="flex items-center gap-2.5 px-3 py-2.5 bg-surface-750 hover:bg-surface-700/70 transition-colors">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
                        onChange={e => toggleNvrAll(nvr.id, e.target.checked)}
                        className="accent-brand-500 w-3.5 h-3.5"
                        onClick={e => e.stopPropagation()}
                      />
                      <Server size={12} className="text-surface-400 flex-shrink-0" />
                      <span className="flex-1 text-xs font-medium text-surface-200">{nvr.name}</span>
                      <span className="text-[10px] text-surface-500">{checkedCount}/{nvrCams.length}</span>
                      <button
                        onClick={() => setExpandedNvrs(prev => { const n = new Set(prev); n.has(nvr.id) ? n.delete(nvr.id) : n.add(nvr.id); return n })}
                        className="p-1 text-surface-500 hover:text-surface-200"
                      >
                        <ChevronRight size={11} className={clsx('transition-transform', isOpen && 'rotate-90')} />
                      </button>
                    </div>

                    {/* Camera rows — visible when expanded */}
                    {isOpen && nvrCams.map(cam => {
                      const checked = getPerm(nvr.id, cam.id).canView
                      return (
                        <div
                          key={cam.id}
                          className="flex items-center gap-2.5 px-3 py-2 pl-9 border-t border-surface-700/50 bg-surface-800/50 hover:bg-surface-800 transition-colors cursor-pointer"
                          onClick={() => toggleCamera(nvr.id, cam.id, !checked)}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={e => toggleCamera(nvr.id, cam.id, e.target.checked)}
                            onClick={e => e.stopPropagation()}
                            className="accent-brand-500 w-3.5 h-3.5"
                          />
                          <Monitor size={10} className={clsx('flex-shrink-0', cam.online ? 'text-green-400' : 'text-surface-600')} />
                          <span className="flex-1 text-xs text-surface-300 truncate">{cam.name}</span>
                          <span className="text-[10px] text-surface-600 font-mono">D{cam.channel}</span>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-700 flex items-center justify-between gap-2 flex-shrink-0">
          <span className="text-xs text-surface-500">
            {allowedCams}/{totalCams} cámaras con acceso
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary text-xs">Cancelar</button>
            <button onClick={handleSaveResources} disabled={isSaving || isAdmin} className="btn-primary text-xs" title={isAdmin ? 'Admin tiene acceso total' : ''}>
              {isSaving ? 'Guardando...' : <><Check size={12} /> Guardar permisos</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────
export function UsersPage() {
  const { user: currentUser } = useAuthStore()
  const [users, setUsers] = useState<User[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [form, setForm] = useState<UserFormData>(EMPTY_FORM)
  const [showPass, setShowPass] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [permUser, setPermUser] = useState<User | null>(null)

  const loadUsers = async () => {
    setIsLoading(true)
    try {
      const data = await apiGet<User[]>('/users')
      setUsers(data)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { loadUsers() }, [])

  const openCreate = () => {
    setEditingUser(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  const openEdit = (u: User) => {
    setEditingUser(u)
    setForm({ username: u.username, email: u.email, fullName: u.fullName, password: '', role: u.role, forcePasswordChange: u.forcePasswordChange ?? false })
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.username || !form.email || !form.fullName) {
      toast.error('Completa todos los campos requeridos')
      return
    }
    if (!editingUser && !form.password) {
      toast.error('La contraseña es requerida')
      return
    }
    setIsSaving(true)
    try {
      if (editingUser) {
        const payload: Partial<UserFormData> = { ...form }
        if (!payload.password) delete payload.password
        await apiPut(`/users/${editingUser.id}`, payload)
        toast.success('Usuario actualizado')
      } else {
        await apiPost('/users', form)
        toast.success('Usuario creado')
      }
      setShowModal(false)
      loadUsers()
    } finally {
      setIsSaving(false)
    }
  }

  const handleToggleActive = async (u: User) => {
    try {
      await apiPut(`/users/${u.id}`, { active: !u.active })
      toast.success(u.active ? 'Usuario desactivado' : 'Usuario activado')
      loadUsers()
    } catch {}
  }

  const handleDelete = async (u: User) => {
    if (!confirm(`¿Eliminar el usuario "${u.username}"? Esta acción no se puede deshacer.`)) return
    try {
      await apiDelete(`/users/${u.id}`)
      toast.success('Usuario eliminado')
      loadUsers()
    } catch {}
  }

  const handleReset2FA = async (u: User) => {
    if (!confirm(`¿Deshabilitar el 2FA del usuario "${u.username}"?`)) return
    try {
      await apiPost(`/users/${u.id}/reset-2fa`, {})
      toast.success('2FA deshabilitado para el usuario')
      loadUsers()
    } catch {}
  }

  const handleUnlock = async (u: User) => {
    try {
      await apiPost(`/users/${u.id}/unlock`, {})
      toast.success('Cuenta desbloqueada')
      loadUsers()
    } catch {}
  }

  const filtered = users.filter((u) =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    u.fullName.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  )

  const roleInfo = (role: Role) => ROLE_OPTIONS.find((r) => r.value === role)

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Gestión de usuarios</h2>
          <p className="text-xs text-surface-400 mt-0.5">{users.length} usuarios registrados</p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          <Plus size={14} /> Nuevo usuario
        </button>
      </div>

      {/* Búsqueda */}
      <div className="relative max-w-xs">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
        <input
          className="input pl-9"
          placeholder="Buscar usuarios..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Tabla */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-600">
              <th className="text-left px-4 py-3 text-xs font-medium text-surface-400">Usuario</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-surface-400 hidden sm:table-cell">Email</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-surface-400">Rol</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-surface-400 hidden md:table-cell">Creado</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-surface-400">Estado</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-700">
            {isLoading ? (
              <tr><td colSpan={6} className="text-center py-8 text-surface-500 text-sm">Cargando...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-surface-500 text-sm">Sin resultados</td></tr>
            ) : filtered.map((u) => {
              const role = roleInfo(u.role)
              return (
                <tr key={u.id} className="hover:bg-surface-700/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-brand-700 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                        {u.fullName.charAt(0)}
                      </div>
                      <div>
                        <div className="text-surface-100 text-xs font-medium">{u.username}</div>
                        <div className="text-surface-500 text-xs">{u.fullName}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-surface-400 hidden sm:table-cell">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className={clsx('text-xs font-medium flex items-center gap-1', role?.color)}>
                      <Shield size={10} /> {role?.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-surface-500 hidden md:table-cell">
                    {format(new Date(u.createdAt), 'dd/MM/yyyy')}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className={clsx(
                        'text-xs px-2 py-0.5 rounded-full font-medium w-fit',
                        u.active ? 'bg-green-900/40 text-green-400' : 'bg-surface-700 text-surface-500'
                      )}>
                        {u.active ? 'Activo' : 'Inactivo'}
                      </span>
                      <div className="flex gap-1 flex-wrap">
                        {u.twoFactorEnabled && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-brand-900/40 text-brand-400 border border-brand-800/40 flex items-center gap-0.5">
                            <ShieldCheck size={8} /> 2FA
                          </span>
                        )}
                        {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-400 border border-red-800/40 flex items-center gap-0.5">
                            <Lock size={8} /> Bloqueado
                          </span>
                        )}
                        {u.forcePasswordChange && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-400 border border-amber-800/40 flex items-center gap-0.5">
                            <Key size={8} /> Cambiar pass
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => setPermUser(u)}
                        className="p-1.5 rounded text-surface-500 hover:text-brand-400 hover:bg-brand-900/20 transition-colors"
                        title="Gestionar permisos"
                      >
                        <Shield size={12} />
                      </button>
                      <button
                        onClick={() => openEdit(u)}
                        className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-600 transition-colors"
                        title="Editar"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => handleToggleActive(u)}
                        className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-600 transition-colors"
                        title={u.active ? 'Desactivar' : 'Activar'}
                        disabled={u.id === currentUser?.id}
                      >
                        {u.active ? <UserX size={12} /> : <UserCheck size={12} />}
                      </button>
                      {u.twoFactorEnabled && u.id !== currentUser?.id && (
                        <button
                          onClick={() => handleReset2FA(u)}
                          className="p-1.5 rounded text-surface-500 hover:text-brand-400 hover:bg-brand-900/20 transition-colors"
                          title="Resetear 2FA"
                        >
                          <ShieldOff size={12} />
                        </button>
                      )}
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                        <button
                          onClick={() => handleUnlock(u)}
                          className="p-1.5 rounded text-surface-500 hover:text-green-400 hover:bg-green-900/20 transition-colors"
                          title="Desbloquear cuenta"
                        >
                          <Unlock size={12} />
                        </button>
                      )}
                      {u.id !== currentUser?.id && (
                        <button
                          onClick={() => handleDelete(u)}
                          className="p-1.5 rounded text-surface-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                          title="Eliminar"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Modal crear/editar */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-md p-6 animate-slide-in shadow-2xl">
            <h3 className="text-sm font-semibold text-surface-100 mb-5">
              {editingUser ? `Editar: ${editingUser.username}` : 'Nuevo usuario'}
            </h3>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Usuario *</label>
                  <input className="input" placeholder="username" value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    disabled={!!editingUser} />
                </div>
                <div>
                  <label className="label">Rol *</label>
                  <select className="input" value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="label">Nombre completo *</label>
                <input className="input" placeholder="Juan Pérez" value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              </div>

              <div>
                <label className="label">Email *</label>
                <input className="input" type="email" placeholder="user@empresa.com" value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>

              <div>
                <label className="label">{editingUser ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña *'}</label>
                <div className="relative">
                  <input className="input pr-10" type={showPass ? 'text' : 'password'}
                    placeholder="Mín. 8 caracteres" value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  <button type="button" onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400">
                    {showPass ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>

              {editingUser && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.forcePasswordChange}
                    onChange={(e) => setForm({ ...form, forcePasswordChange: e.target.checked })}
                    className="accent-brand-500"
                  />
                  <span className="text-xs text-surface-300">Forzar cambio de contraseña en próximo inicio de sesión</span>
                </label>
              )}
            </div>

            <div className="flex gap-2 mt-6 justify-end">
              <button onClick={() => setShowModal(false)} className="btn-secondary">Cancelar</button>
              <button onClick={handleSave} disabled={isSaving} className="btn-primary">
                {isSaving ? 'Guardando...' : editingUser ? 'Actualizar' : 'Crear usuario'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permissions panel (legacy) */}
      {permUser && (
        <PermissionsPanel
          user={permUser}
          onClose={() => setPermUser(null)}
        />
      )}

    </div>
  )
}
