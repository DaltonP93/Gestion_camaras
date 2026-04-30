// src/pages/ProfilePage.tsx
import { useState, useRef } from 'react'
import { Camera, Save, Lock, User, Mail, Phone, RefreshCw, Eye, EyeOff } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { apiPut } from '@/lib/api'
import toast from 'react-hot-toast'
import { clsx } from 'clsx'

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrador', SUPERVISOR: 'Supervisor',
  OPERATOR: 'Operador', AUDITOR: 'Auditor',
}

export function ProfilePage() {
  const { user, loadUser } = useAuthStore()

  // Personal data
  const [fullName, setFullName] = useState(user?.fullName || '')
  const [email, setEmail] = useState(user?.email || '')
  const [phone, setPhone] = useState(user?.phone || '')
  const [savingProfile, setSavingProfile] = useState(false)

  // Password
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPass, setShowCurrentPass] = useState(false)
  const [showNewPass, setShowNewPass] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)

  // Avatar
  const fileRef = useRef<HTMLInputElement>(null)
  const [savingAvatar, setSavingAvatar] = useState(false)

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    try {
      await apiPut('/profile', { fullName, email, phone: phone || null })
      await loadUser()
      toast.success('Perfil actualizado')
    } catch (e: any) {
      toast.error(e?.message || 'Error al guardar')
    } finally {
      setSavingProfile(false)
    }
  }

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) {
      toast.error('Las contraseñas nuevas no coinciden')
      return
    }
    if (newPassword.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres')
      return
    }
    setSavingPassword(true)
    try {
      await apiPut('/profile/password', { currentPassword, newPassword })
      toast.success('Contraseña cambiada. Inicia sesión nuevamente.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => useAuthStore.getState().logout(), 2000)
    } catch (e: any) {
      toast.error(e?.message || 'Error al cambiar contraseña')
    } finally {
      setSavingPassword(false)
    }
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 500_000) {
      toast.error('La imagen no debe superar 500 KB')
      return
    }
    setSavingAvatar(true)
    try {
      const reader = new FileReader()
      reader.onload = async () => {
        const dataUrl = reader.result as string
        await apiPut('/profile/avatar', { avatarUrl: dataUrl })
        await loadUser()
        toast.success('Foto actualizada')
        setSavingAvatar(false)
      }
      reader.readAsDataURL(file)
    } catch {
      toast.error('Error al subir la imagen')
      setSavingAvatar(false)
    }
  }

  const handleRemoveAvatar = async () => {
    setSavingAvatar(true)
    try {
      await apiPut('/profile/avatar', { avatarUrl: null })
      await loadUser()
      toast.success('Foto eliminada')
    } catch {
      toast.error('Error al eliminar la foto')
    } finally {
      setSavingAvatar(false)
    }
  }

  const inputClass = 'input'

  return (
    <div className="p-5 max-w-2xl space-y-5 animate-fade-in">
      <div>
        <h2 className="text-base font-semibold text-surface-100">Mi perfil</h2>
        <p className="text-xs text-surface-400 mt-0.5">Gestiona tu información personal y seguridad</p>
      </div>

      {/* ── Avatar ── */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-surface-100 mb-4">Foto de perfil</h3>
        <div className="flex items-center gap-5">
          <div className="relative">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="Avatar" className="w-20 h-20 rounded-full object-cover border-2 border-surface-600" />
            ) : (
              <div className="w-20 h-20 rounded-full bg-brand-600 flex items-center justify-center text-white text-2xl font-bold border-2 border-surface-600">
                {user?.fullName?.charAt(0).toUpperCase() || 'U'}
              </div>
            )}
            {savingAvatar && (
              <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
                <RefreshCw size={16} className="text-white animate-spin" />
              </div>
            )}
          </div>
          <div className="space-y-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={savingAvatar}
              className="btn-secondary flex items-center gap-2"
            >
              <Camera size={13} /> Cambiar foto
            </button>
            {user?.avatarUrl && (
              <button
                onClick={handleRemoveAvatar}
                disabled={savingAvatar}
                className="btn-ghost text-xs text-red-400 hover:text-red-300"
              >
                Eliminar foto
              </button>
            )}
            <p className="text-xs text-surface-500">JPG, PNG o WebP · máx. 500 KB</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleAvatarChange}
          />
        </div>
      </div>

      {/* ── Datos personales ── */}
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-surface-100">Datos personales</h3>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Nombre completo</label>
            <div className="relative">
              <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input className={clsx(inputClass, 'pl-9')} value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="label">Email</label>
            <div className="relative">
              <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input className={clsx(inputClass, 'pl-9')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="label">Teléfono</label>
            <div className="relative">
              <Phone size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input className={clsx(inputClass, 'pl-9')} placeholder="+595 21 123456" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1 border-t border-surface-700">
          <div className="flex-1 text-xs text-surface-500">
            Usuario: <span className="text-surface-300 font-mono">{user?.username}</span>
            {' · '}Rol: <span className="text-brand-400">{ROLE_LABEL[user?.role || '']}</span>
          </div>
          <button onClick={handleSaveProfile} disabled={savingProfile} className="btn-primary">
            {savingProfile ? <><RefreshCw size={13} className="animate-spin" /> Guardando...</> : <><Save size={13} /> Guardar</>}
          </button>
        </div>
      </div>

      {/* ── Cambiar contraseña ── */}
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-surface-100 flex items-center gap-2">
          <Lock size={14} className="text-surface-400" /> Cambiar contraseña
        </h3>

        <div>
          <label className="label">Contraseña actual</label>
          <div className="relative">
            <input
              className={clsx(inputClass, 'pr-10')}
              type={showCurrentPass ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
            />
            <button type="button" onClick={() => setShowCurrentPass(!showCurrentPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400">
              {showCurrentPass ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Nueva contraseña</label>
            <div className="relative">
              <input
                className={clsx(inputClass, 'pr-10')}
                type={showNewPass ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Mín. 8 caracteres"
              />
              <button type="button" onClick={() => setShowNewPass(!showNewPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400">
                {showNewPass ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </div>
          <div>
            <label className="label">Confirmar nueva</label>
            <input
              className={clsx(inputClass, newPassword && confirmPassword && newPassword !== confirmPassword ? 'border-red-500' : '')}
              type={showNewPass ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repetir contraseña"
            />
          </div>
        </div>

        <div className="flex justify-end pt-1 border-t border-surface-700">
          <button
            onClick={handleChangePassword}
            disabled={savingPassword || !currentPassword || !newPassword}
            className="btn-primary"
          >
            {savingPassword ? <><RefreshCw size={13} className="animate-spin" /> Cambiando...</> : <><Lock size={13} /> Cambiar contraseña</>}
          </button>
        </div>
      </div>
    </div>
  )
}
