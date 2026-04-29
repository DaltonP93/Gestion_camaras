// src/pages/UsersPage.tsx
import { useEffect, useState, useCallback } from 'react'
import {
  Plus, Pencil, Trash2, Shield, Eye, EyeOff,
  UserCheck, UserX, Search, Key, X, Check, ChevronRight,
  Server, Monitor, Video, PlayCircle
} from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { clsx } from 'clsx'
import type { User, Role, NVR, Camera, UserPermission } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'
import { useAuthStore } from '@/stores/authStore'

const ROLE_OPTIONS: { value: Role; label: string; color: string }[] = [
  { value: 'ADMIN',      label: 'Administrador', color: 'text-brand-400' },
  { value: 'SUPERVISOR', label: 'Supervisor',    color: 'text-blue-400' },
  { value: 'OPERATOR',   label: 'Operador',      color: 'text-green-400' },
  { value: 'AUDITOR',    label: 'Auditor',       color: 'text-amber-400' },
]

interface UserFormData {
  username: string
  email: string
  fullName: string
  password: string
  role: Role
}

const EMPTY_FORM: UserFormData = {
  username: '', email: '', fullName: '', password: '', role: 'OPERATOR',
}

// ─── Permissions panel ──────────────────────────────────────────────────────

interface PermMatrix {
  nvrId?: string
  cameraId?: string
  canView: boolean
  canPlayback: boolean
  canPtz: boolean
}

function PermissionsPanel({
  user,
  onClose,
}: {
  user: User
  onClose: () => void
}) {
  const [nvrs, setNvrs] = useState<NVR[]>([])
  const [cameras, setCameras] = useState<Camera[]>([])
  const [perms, setPerms] = useState<PermMatrix[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [expandedNvr, setExpandedNvr] = useState<string | null>(null)

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
    }).finally(() => setIsLoading(false))
  }, [user.id])

  const getPerm = useCallback((nvrId?: string, cameraId?: string): PermMatrix => {
    const found = perms.find((p) =>
      p.nvrId === (nvrId ?? undefined) && p.cameraId === (cameraId ?? undefined)
    )
    return found ?? { nvrId, cameraId, canView: false, canPlayback: false, canPtz: false }
  }, [perms])

  const setPerm = (nvrId: string | undefined, cameraId: string | undefined, field: keyof Pick<PermMatrix, 'canView' | 'canPlayback' | 'canPtz'>, value: boolean) => {
    setPerms((prev) => {
      const idx = prev.findIndex((p) =>
        p.nvrId === nvrId && p.cameraId === cameraId
      )
      const entry: PermMatrix = idx >= 0 ? { ...prev[idx] } : { nvrId, cameraId, canView: false, canPlayback: false, canPtz: false }
      entry[field] = value
      // Auto-enable canView when enabling other perms
      if ((field === 'canPlayback' || field === 'canPtz') && value) entry.canView = true

      if (idx >= 0) {
        const copy = [...prev]
        copy[idx] = entry
        return copy
      }
      return [...prev, entry]
    })
  }

  const setNvrAll = (nvrId: string, checked: boolean) => {
    const nvr = nvrs.find((n) => n.id === nvrId)
    if (!nvr) return
    const nvCams = cameras.filter((c) => c.nvrId === nvrId)

    setPerms((prev) => {
      const next = prev.filter((p) => p.nvrId !== nvrId)
      if (checked) {
        // Add NVR-level permission
        next.push({ nvrId, cameraId: undefined, canView: true, canPlayback: false, canPtz: false })
        // Add all cameras
        nvCams.forEach((cam) => {
          next.push({ nvrId, cameraId: cam.id, canView: true, canPlayback: false, canPtz: false })
        })
      }
      return next
    })
  }

  const isNvrChecked = (nvrId: string) =>
    perms.some((p) => p.nvrId === nvrId && p.canView)

  const handleSave = async () => {
    setIsSaving(true)
    try {
      // Filter out all-false entries
      const toSave = perms.filter((p) => p.canView || p.canPlayback || p.canPtz)
      await apiPost(`/users/${user.id}/permissions`, toSave)
      toast.success('Permisos guardados')
      onClose()
    } finally {
      setIsSaving(false)
    }
  }

  const PermToggle = ({
    label, icon, checked, onChange, disabled,
  }: {
    label: string; icon: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
        checked
          ? 'bg-brand-600/20 text-brand-300 border border-brand-600/30'
          : 'bg-surface-700 text-surface-500 border border-transparent hover:border-surface-500',
        disabled && 'opacity-40 cursor-not-allowed'
      )}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[420px] bg-surface-800 border-l border-surface-600 flex flex-col shadow-2xl animate-slide-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-surface-700">
          <div className="w-8 h-8 rounded-full bg-brand-700 flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
            {user.fullName.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-surface-100">{user.fullName}</div>
            <div className="text-xs text-surface-500">{user.username} · Permisos granulares</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700">
            <X size={14} />
          </button>
        </div>

        {/* Note for ADMIN */}
        {user.role === 'ADMIN' && (
          <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-brand-900/30 border border-brand-700/30 text-xs text-brand-300">
            Los administradores tienen acceso total independientemente de los permisos asignados.
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {isLoading ? (
            <div className="text-center py-12 text-surface-500 text-xs">Cargando...</div>
          ) : nvrs.length === 0 ? (
            <div className="text-center py-12 text-surface-500 text-xs">No hay NVRs configurados</div>
          ) : nvrs.map((nvr) => {
            const nvrCameras = cameras.filter((c) => c.nvrId === nvr.id)
            const isOpen = expandedNvr === nvr.id
            const nvrPerm = getPerm(nvr.id, undefined)
            const checked = isNvrChecked(nvr.id)

            return (
              <div key={nvr.id} className="border border-surface-700 rounded-lg overflow-hidden">
                {/* NVR row */}
                <div className="flex items-center gap-2 px-3 py-2.5 bg-surface-750 hover:bg-surface-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setNvrAll(nvr.id, e.target.checked)}
                    className="accent-brand-500"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Server size={12} className="text-surface-400 flex-shrink-0" />
                  <span className="flex-1 text-xs font-medium text-surface-200">{nvr.name}</span>
                  <div className="flex items-center gap-1">
                    <PermToggle
                      label="Ver" icon={<Eye size={8} />}
                      checked={nvrPerm.canView}
                      onChange={(v) => setPerm(nvr.id, undefined, 'canView', v)}
                    />
                    <PermToggle
                      label="Grab." icon={<Video size={8} />}
                      checked={nvrPerm.canPlayback}
                      onChange={(v) => setPerm(nvr.id, undefined, 'canPlayback', v)}
                    />
                  </div>
                  <button
                    onClick={() => setExpandedNvr(isOpen ? null : nvr.id)}
                    className="p-1 text-surface-500 hover:text-surface-200 transition-colors"
                  >
                    <ChevronRight size={12} className={clsx('transition-transform', isOpen && 'rotate-90')} />
                  </button>
                </div>

                {/* Cameras */}
                {isOpen && (
                  <div className="divide-y divide-surface-700/50">
                    {nvrCameras.length === 0 ? (
                      <div className="px-8 py-2 text-xs text-surface-500">Sin cámaras</div>
                    ) : nvrCameras.map((cam) => {
                      const cp = getPerm(nvr.id, cam.id)
                      return (
                        <div key={cam.id} className="flex items-center gap-2 px-3 py-2 pl-8 bg-surface-800/50 hover:bg-surface-800 transition-colors">
                          <input
                            type="checkbox"
                            checked={cp.canView}
                            onChange={(e) => setPerm(nvr.id, cam.id, 'canView', e.target.checked)}
                            className="accent-brand-500"
                          />
                          <Monitor size={10} className={clsx('flex-shrink-0', cam.online ? 'text-green-400' : 'text-surface-500')} />
                          <span className="flex-1 text-xs text-surface-300 truncate">{cam.name}</span>
                          <span className="text-[10px] text-surface-600">ch{cam.channel}</span>
                          <div className="flex items-center gap-1">
                            <PermToggle
                              label="Ver" icon={<Eye size={8} />}
                              checked={cp.canView}
                              onChange={(v) => setPerm(nvr.id, cam.id, 'canView', v)}
                            />
                            <PermToggle
                              label="Grab." icon={<PlayCircle size={8} />}
                              checked={cp.canPlayback}
                              onChange={(v) => setPerm(nvr.id, cam.id, 'canPlayback', v)}
                              disabled={!cp.canView}
                            />
                            {cam.ptzEnabled && (
                              <PermToggle
                                label="PTZ" icon={<Key size={8} />}
                                checked={cp.canPtz}
                                onChange={(v) => setPerm(nvr.id, cam.id, 'canPtz', v)}
                                disabled={!cp.canView}
                              />
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-surface-700 flex items-center justify-between gap-2">
          <span className="text-xs text-surface-500">
            {perms.filter((p) => p.canView || p.canPlayback || p.canPtz).length} permisos asignados
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">Cancelar</button>
            <button onClick={handleSave} disabled={isSaving} className="btn-primary">
              {isSaving ? 'Guardando...' : <><Check size={13} /> Guardar permisos</>}
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
    setForm({ username: u.username, email: u.email, fullName: u.fullName, password: '', role: u.role })
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
                    <span className={clsx(
                      'text-xs px-2 py-0.5 rounded-full font-medium',
                      u.active ? 'bg-green-900/40 text-green-400' : 'bg-surface-700 text-surface-500'
                    )}>
                      {u.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => setPermUser(u)}
                        className="p-1.5 rounded text-surface-500 hover:text-amber-400 hover:bg-amber-900/20 transition-colors"
                        title="Gestionar permisos"
                      >
                        <Key size={12} />
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

      {/* Permissions panel */}
      {permUser && (
        <PermissionsPanel
          user={permUser}
          onClose={() => setPermUser(null)}
        />
      )}
    </div>
  )
}
