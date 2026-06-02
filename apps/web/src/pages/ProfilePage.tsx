// src/pages/ProfilePage.tsx
import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Camera, Save, Lock, User, Mail, Phone, RefreshCw, Eye, EyeOff,
  Shield, ShieldCheck, ShieldOff, Smartphone, Download, Trash2,
  Monitor, Clock, MapPin, Key, AlertTriangle, CheckCircle2, Copy,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import toast from 'react-hot-toast'
import { clsx } from 'clsx'
import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import type { UserSession } from '@/types'

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrador', SUPERVISOR: 'Supervisor',
  OPERATOR: 'Operador', AUDITOR: 'Auditor',
}

// ─── Password strength meter ──────────────────────────────────
function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: '8+ caracteres',   ok: password.length >= 8 },
    { label: 'Mayúscula',       ok: /[A-Z]/.test(password) },
    { label: 'Minúscula',       ok: /[a-z]/.test(password) },
    { label: 'Número',          ok: /[0-9]/.test(password) },
    { label: 'Carácter especial', ok: /[^A-Za-z0-9]/.test(password) },
  ]
  const score = checks.filter((c) => c.ok).length
  const colors = ['bg-red-500', 'bg-red-400', 'bg-amber-400', 'bg-yellow-400', 'bg-green-500']

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex gap-1">
        {[0,1,2,3,4].map((i) => (
          <div key={i} className={clsx('h-1 flex-1 rounded-full transition-colors', i < score ? colors[score - 1] : 'bg-surface-700')} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {checks.map((c) => (
          <span key={c.label} className={clsx('text-[10px] flex items-center gap-0.5', c.ok ? 'text-green-400' : 'text-surface-500')}>
            {c.ok ? <CheckCircle2 size={9} /> : <AlertTriangle size={9} />} {c.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Sessions panel ───────────────────────────────────────────
function SessionsPanel() {
  const [sessions, setSessions] = useState<UserSession[]>([])
  const [loading, setLoading] = useState(true)
  const currentRefreshToken = localStorage.getItem('refreshToken')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<UserSession[]>('/auth/sessions')
      setSessions(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const revokeSession = async (id: string) => {
    try {
      await apiDelete(`/auth/sessions/${id}`)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      toast.success('Sesión cerrada')
    } catch {
      toast.error('Error al cerrar sesión')
    }
  }

  const revokeAll = async () => {
    try {
      await apiDelete('/auth/sessions', { refreshToken: currentRefreshToken ?? undefined })
      await load()
      toast.success('Todas las otras sesiones cerradas')
    } catch {
      toast.error('Error al cerrar sesiones')
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-surface-100 flex items-center gap-2">
          <Monitor size={14} className="text-surface-400" /> Sesiones activas
        </h3>
        {sessions.length > 1 && (
          <button onClick={revokeAll} className="text-xs text-red-400 hover:text-red-300 transition-colors">
            Cerrar otras sesiones
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-center py-4 text-xs text-surface-500">Cargando...</div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-4 text-xs text-surface-500">Sin sesiones activas</div>
      ) : (
        <div className="divide-y divide-surface-700">
          {sessions.map((s, idx) => (
            <div key={s.id} className="flex items-start gap-3 py-3">
              <div className="p-1.5 rounded-lg bg-surface-700 flex-shrink-0">
                <Monitor size={12} className="text-surface-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-surface-100">
                    {s.deviceName || 'Dispositivo desconocido'}
                  </span>
                  {idx === 0 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-400 border border-green-800/40">
                      Esta sesión
                    </span>
                  )}
                </div>
                {s.ipAddress && (
                  <div className="flex items-center gap-1 text-[10px] text-surface-500 mt-0.5">
                    <MapPin size={9} /> {s.ipAddress}
                  </div>
                )}
                <div className="flex items-center gap-3 text-[10px] text-surface-600 mt-0.5">
                  <span className="flex items-center gap-1">
                    <Clock size={9} />
                    Iniciada {formatDistanceToNow(new Date(s.createdAt), { locale: es, addSuffix: true })}
                  </span>
                  {s.lastUsedAt && (
                    <span>Última actividad {formatDistanceToNow(new Date(s.lastUsedAt), { locale: es, addSuffix: true })}</span>
                  )}
                </div>
              </div>
              {idx !== 0 && (
                <button
                  onClick={() => revokeSession(s.id)}
                  className="p-1 rounded text-surface-500 hover:text-red-400 hover:bg-surface-700 transition-colors flex-shrink-0"
                  title="Cerrar sesión"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 2FA setup panel ─────────────────────────────────────────
function TwoFactorPanel() {
  const { user, loadUser } = useAuthStore()
  const [step, setStep] = useState<'idle' | 'setup' | 'verify' | 'backup' | 'disable'>('idle')
  const [qrCodeUri, setQrCodeUri] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [regenCode, setRegenCode] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const enabled = user?.twoFactorEnabled ?? false

  const startSetup = async () => {
    setSaving(true)
    try {
      const data = await apiGet<{ secret: string; qrCodeUri: string }>('/auth/2fa/setup')
      setQrCodeUri(data.qrCodeUri)
      setSecret(data.secret)
      setStep('setup')
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Error al iniciar configuración')
    } finally {
      setSaving(false)
    }
  }

  const enable2FA = async () => {
    if (code.length !== 6) { toast.error('Código debe ser 6 dígitos'); return }
    setSaving(true)
    try {
      const data = await apiPost<{ backupCodes: string[] }>('/auth/2fa/enable', { code })
      setBackupCodes(data.backupCodes)
      setStep('backup')
      await loadUser()
      toast.success('2FA habilitado correctamente')
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Código incorrecto')
    } finally {
      setSaving(false)
    }
  }

  const disable2FA = async () => {
    if (!code || !password) { toast.error('Ingresa contraseña y código TOTP'); return }
    setSaving(true)
    try {
      await apiPost('/auth/2fa/disable', { code, password })
      await loadUser()
      setStep('idle')
      setCode('')
      setPassword('')
      toast.success('2FA deshabilitado')
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Error al deshabilitar')
    } finally {
      setSaving(false)
    }
  }

  const regenerateCodes = async () => {
    if (!regenCode) { toast.error('Ingresa tu código TOTP'); return }
    setSaving(true)
    try {
      const data = await apiPost<{ backupCodes: string[] }>('/auth/2fa/backup-codes/regenerate', { code: regenCode })
      setBackupCodes(data.backupCodes)
      setStep('backup')
      setRegenCode('')
      toast.success('Códigos de recuperación regenerados')
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Código incorrecto')
    } finally {
      setSaving(false)
    }
  }

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join('\n'))
    toast.success('Códigos copiados')
  }

  if (step === 'backup') {
    return (
      <div className="card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Key size={14} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-surface-100">Códigos de recuperación</h3>
        </div>
        <div className="p-3 rounded-lg bg-amber-900/20 border border-amber-700/30 text-xs text-amber-300">
          Guarda estos códigos en un lugar seguro. Cada código solo puede usarse una vez.
          Sin ellos no podrás acceder si pierdes tu dispositivo.
        </div>
        <div className="grid grid-cols-2 gap-2">
          {backupCodes.map((code, i) => (
            <div key={i} className="font-mono text-sm text-surface-100 bg-surface-700 px-3 py-2 rounded-lg text-center tracking-widest">
              {code}
            </div>
          ))}
        </div>
        <div className="flex gap-2 pt-1 border-t border-surface-700">
          <button onClick={copyBackupCodes} className="btn-secondary flex-1 justify-center gap-2">
            <Copy size={13} /> Copiar
          </button>
          <button
            onClick={() => {
              const text = backupCodes.join('\n')
              const a = document.createElement('a')
              a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
              a.download = 'visioncore-backup-codes.txt'
              a.click()
            }}
            className="btn-secondary flex-1 justify-center gap-2"
          >
            <Download size={13} /> Descargar
          </button>
          <button onClick={() => setStep('idle')} className="btn-primary justify-center gap-2">
            <CheckCircle2 size={13} /> Listo
          </button>
        </div>
      </div>
    )
  }

  if (step === 'setup') {
    return (
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-surface-100 flex items-center gap-2">
          <Smartphone size={14} className="text-brand-400" /> Configurar autenticador TOTP
        </h3>
        <div className="space-y-3 text-xs text-surface-400">
          <p className="font-medium text-surface-200">1. Escanea el código QR con tu app autenticadora</p>
          <p className="text-[10px]">Compatible con Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc.</p>
        </div>
        {qrCodeUri && (
          <div className="flex justify-center">
            <img src={qrCodeUri} alt="QR Code 2FA" className="w-48 h-48 rounded-xl border border-surface-600" />
          </div>
        )}
        <div>
          <p className="text-xs text-surface-400 mb-1">O ingresa la clave manualmente:</p>
          <div className="flex items-center gap-2">
            <code className={clsx('flex-1 font-mono text-xs bg-surface-700 px-2 py-1.5 rounded-lg text-surface-200 tracking-wider', !showSecret && 'blur-sm select-none')}>
              {secret}
            </code>
            <button onClick={() => setShowSecret(!showSecret)} className="p-1.5 text-surface-500 hover:text-surface-200">
              {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button onClick={() => { navigator.clipboard.writeText(secret); toast.success('Clave copiada') }}
              className="p-1.5 text-surface-500 hover:text-surface-200">
              <Copy size={12} />
            </button>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-surface-200 mb-2">2. Ingresa el código de 6 dígitos para confirmar</p>
          <input
            className="input text-center font-mono text-lg tracking-widest"
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="flex gap-2 pt-1 border-t border-surface-700">
          <button onClick={() => setStep('idle')} className="btn-secondary">Cancelar</button>
          <button
            onClick={enable2FA}
            disabled={saving || code.length !== 6}
            className="btn-primary flex-1 justify-center"
          >
            {saving ? <><RefreshCw size={13} className="animate-spin" /> Verificando...</> : 'Activar 2FA'}
          </button>
        </div>
      </div>
    )
  }

  if (step === 'disable') {
    return (
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-surface-100 flex items-center gap-2">
          <ShieldOff size={14} className="text-red-400" /> Deshabilitar 2FA
        </h3>
        <div className="p-3 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-300">
          Deshabilitar 2FA reduce la seguridad de tu cuenta. Confirma con tu contraseña y código actual.
        </div>
        <div>
          <label className="label">Contraseña</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        <div>
          <label className="label">Código TOTP actual</label>
          <input className="input font-mono text-center tracking-widest" type="text" inputMode="numeric"
            maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))} placeholder="000000" />
        </div>
        <div className="flex gap-2 pt-1 border-t border-surface-700">
          <button onClick={() => setStep('idle')} className="btn-secondary">Cancelar</button>
          <button
            onClick={disable2FA}
            disabled={saving || !password || code.length !== 6}
            className="btn-primary bg-red-600 hover:bg-red-500 flex-1 justify-center"
          >
            {saving ? <><RefreshCw size={13} className="animate-spin" /> Deshabilitando...</> : 'Deshabilitar 2FA'}
          </button>
        </div>
      </div>
    )
  }

  // idle
  return (
    <div className="card p-5 space-y-4">
      <h3 className="text-sm font-semibold text-surface-100 flex items-center gap-2">
        {enabled ? <ShieldCheck size={14} className="text-green-400" /> : <Shield size={14} className="text-surface-400" />}
        Autenticación de dos factores
      </h3>

      <div className={clsx(
        'flex items-center gap-3 p-3 rounded-lg border',
        enabled
          ? 'bg-green-900/20 border-green-700/30'
          : 'bg-surface-700/50 border-surface-600'
      )}>
        {enabled ? (
          <CheckCircle2 size={16} className="text-green-400 flex-shrink-0" />
        ) : (
          <AlertTriangle size={16} className="text-amber-400 flex-shrink-0" />
        )}
        <div>
          <p className="text-xs font-medium text-surface-100">
            {enabled ? '2FA habilitado' : '2FA no habilitado'}
          </p>
          <p className="text-[10px] text-surface-400 mt-0.5">
            {enabled
              ? 'Tu cuenta está protegida con autenticación de dos factores'
              : 'Protege tu cuenta con TOTP (Google Authenticator, Authy...)'}
          </p>
        </div>
      </div>

      {enabled ? (
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setStep('disable')} className="btn-secondary text-xs gap-2">
            <ShieldOff size={13} /> Deshabilitar 2FA
          </button>
          <div className="flex items-center gap-2">
            <input
              className="input text-xs w-28 font-mono text-center tracking-widest"
              placeholder="código TOTP"
              maxLength={6}
              inputMode="numeric"
              value={regenCode}
              onChange={(e) => setRegenCode(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <button
              onClick={regenerateCodes}
              disabled={saving || regenCode.length !== 6}
              className="btn-secondary text-xs gap-2 whitespace-nowrap"
            >
              <RefreshCw size={13} /> Nuevos códigos de recuperación
            </button>
          </div>
        </div>
      ) : (
        <button onClick={startSetup} disabled={saving} className="btn-primary gap-2">
          {saving ? <><RefreshCw size={13} className="animate-spin" /> Iniciando...</> : <><Smartphone size={13} /> Configurar 2FA</>}
        </button>
      )}
    </div>
  )
}

// ─── ProfilePage ──────────────────────────────────────────────
export function ProfilePage() {
  const { user, loadUser } = useAuthStore()

  const [fullName, setFullName]     = useState(user?.fullName || '')
  const [email, setEmail]           = useState(user?.email || '')
  const [phone, setPhone]           = useState(user?.phone || '')
  const [savingProfile, setSavingProfile] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword]         = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPass, setShowCurrentPass] = useState(false)
  const [showNewPass, setShowNewPass]         = useState(false)
  const [savingPassword, setSavingPassword]   = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const [savingAvatar, setSavingAvatar] = useState(false)

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    try {
      await apiPut('/profile', { fullName, email, phone: phone || null })
      await loadUser()
      toast.success('Perfil actualizado')
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Error al guardar')
    } finally {
      setSavingProfile(false)
    }
  }

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) { toast.error('Las contraseñas nuevas no coinciden'); return }
    setSavingPassword(true)
    try {
      await apiPut('/profile/password', { currentPassword, newPassword })
      toast.success('Contraseña cambiada. Redirigiendo...')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => useAuthStore.getState().logout(), 2000)
    } catch (e: any) {
      const errors = e?.response?.data?.errors
      if (errors?.length) toast.error(errors.join(', '))
      else toast.error(e?.response?.data?.message || 'Error al cambiar contraseña')
    } finally {
      setSavingPassword(false)
    }
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 500_000) { toast.error('La imagen no debe superar 500 KB'); return }
    setSavingAvatar(true)
    try {
      const reader = new FileReader()
      reader.onload = async () => {
        await apiPut('/profile/avatar', { avatarUrl: reader.result as string })
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
    } catch { toast.error('Error al eliminar la foto') }
    finally { setSavingAvatar(false) }
  }

  return (
    <div className="p-5 max-w-2xl space-y-5 animate-fade-in">
      <div>
        <h2 className="text-base font-semibold text-surface-100">Mi perfil</h2>
        <p className="text-xs text-surface-400 mt-0.5">Información personal, seguridad y sesiones</p>
      </div>

      {/* Avatar */}
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
            <button onClick={() => fileRef.current?.click()} disabled={savingAvatar} className="btn-secondary flex items-center gap-2">
              <Camera size={13} /> Cambiar foto
            </button>
            {user?.avatarUrl && (
              <button onClick={handleRemoveAvatar} disabled={savingAvatar} className="btn-ghost text-xs text-red-400 hover:text-red-300">
                Eliminar foto
              </button>
            )}
            <p className="text-xs text-surface-500">JPG, PNG o WebP · máx. 500 KB</p>
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleAvatarChange} />
        </div>
      </div>

      {/* Datos personales */}
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-surface-100">Datos personales</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Nombre completo</label>
            <div className="relative">
              <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input className="input pl-9" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Email</label>
            <div className="relative">
              <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input className="input pl-9" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Teléfono</label>
            <div className="relative">
              <Phone size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input className="input pl-9" placeholder="+595 21 123456" value={phone} onChange={(e) => setPhone(e.target.value)} />
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

      {/* 2FA */}
      <TwoFactorPanel />

      {/* Sessions */}
      <SessionsPanel />

      {/* Cambiar contraseña */}
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-surface-100 flex items-center gap-2">
          <Lock size={14} className="text-surface-400" /> Cambiar contraseña
        </h3>

        <div>
          <label className="label">Contraseña actual</label>
          <div className="relative">
            <input
              className="input pr-10"
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
                className="input pr-10"
                type={showNewPass ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Mín. 8 caracteres"
              />
              <button type="button" onClick={() => setShowNewPass(!showNewPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400">
                {showNewPass ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {newPassword && <PasswordStrength password={newPassword} />}
          </div>
          <div>
            <label className="label">Confirmar nueva</label>
            <input
              className={clsx('input', newPassword && confirmPassword && newPassword !== confirmPassword ? 'border-red-500' : '')}
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
            disabled={savingPassword || !currentPassword || !newPassword || newPassword !== confirmPassword}
            className="btn-primary"
          >
            {savingPassword ? <><RefreshCw size={13} className="animate-spin" /> Cambiando...</> : <><Lock size={13} /> Cambiar contraseña</>}
          </button>
        </div>
      </div>
    </div>
  )
}
