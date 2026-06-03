// src/pages/ResetPasswordPage.tsx
import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Shield, Loader2, Eye, EyeOff, CheckCircle, AlertTriangle, ArrowLeft } from 'lucide-react'
import { apiPost } from '@/lib/api'
import toast from 'react-hot-toast'

function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: 'Al menos 10 caracteres', ok: password.length >= 10 },
    { label: 'Una mayúscula', ok: /[A-Z]/.test(password) },
    { label: 'Una minúscula', ok: /[a-z]/.test(password) },
    { label: 'Un número', ok: /[0-9]/.test(password) },
    { label: 'Un símbolo', ok: /[^A-Za-z0-9]/.test(password) },
  ]
  const passed = checks.filter(c => c.ok).length
  const strength = passed <= 2 ? 'Débil' : passed <= 3 ? 'Regular' : passed <= 4 ? 'Buena' : 'Fuerte'
  const color = passed <= 2 ? 'bg-red-500' : passed <= 3 ? 'bg-amber-500' : passed <= 4 ? 'bg-blue-500' : 'bg-green-500'

  if (!password) return null

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-surface-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${color}`}
            style={{ width: `${(passed / 5) * 100}%` }}
          />
        </div>
        <span className="text-[10px] text-surface-400 w-12 text-right">{strength}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {checks.map(c => (
          <div key={c.label} className={`flex items-center gap-1 text-[10px] ${c.ok ? 'text-green-400' : 'text-surface-600'}`}>
            <span>{c.ok ? '✓' : '○'}</span> {c.label}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const navigate = useNavigate()

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [done, setDone] = useState(false)

  if (!token) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="relative w-full max-w-sm">
          <div className="card p-8 shadow-2xl text-center space-y-4">
            <AlertTriangle size={36} className="text-amber-400 mx-auto" />
            <p className="text-sm font-medium text-surface-100">Enlace inválido</p>
            <p className="text-xs text-surface-400">El enlace de recuperación no es válido o ya fue utilizado.</p>
            <Link to="/login" className="btn-secondary w-full justify-center">
              <ArrowLeft size={13} /> Volver al login
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) { toast.error('Las contraseñas no coinciden'); return }
    if (newPassword.length < 10) { toast.error('La contraseña debe tener al menos 10 caracteres'); return }

    setIsLoading(true)
    try {
      await apiPost('/auth/reset-password', { token, newPassword })
      setDone(true)
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Error al restablecer la contraseña'
      toast.error(msg)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(48,54,61,0.3)_1px,transparent_1px),linear-gradient(90deg,rgba(48,54,61,0.3)_1px,transparent_1px)] bg-[size:32px_32px]" />

      <div className="relative w-full max-w-sm">
        <div className="card p-8 shadow-2xl">
          <div className="flex flex-col items-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-brand-600 flex items-center justify-center mb-4 shadow-lg shadow-brand-900/50">
              <Shield size={28} className="text-white" />
            </div>
            <h1 className="text-xl font-semibold text-surface-50">VisionCore</h1>
            <p className="text-sm text-surface-400 mt-1">Restablecer contraseña</p>
          </div>

          {done ? (
            <div className="text-center space-y-4">
              <CheckCircle size={40} className="text-green-400 mx-auto" />
              <div>
                <p className="text-sm font-medium text-surface-100">Contraseña actualizada</p>
                <p className="text-xs text-surface-400 mt-1.5">
                  Tu contraseña fue restablecida correctamente. Ahora puedes iniciar sesión con tu nueva contraseña.
                </p>
              </div>
              <button onClick={() => navigate('/login')} className="btn-primary w-full justify-center">
                Iniciar sesión
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Nueva contraseña</label>
                <div className="relative">
                  <input
                    className="input pr-10"
                    type={showPass ? 'text' : 'password'}
                    placeholder="••••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoFocus
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-200"
                  >
                    {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <PasswordStrength password={newPassword} />
              </div>

              <div>
                <label className="label">Confirmar contraseña</label>
                <input
                  className={`input ${confirmPassword && confirmPassword !== newPassword ? 'border-red-500' : ''}`}
                  type={showPass ? 'text' : 'password'}
                  placeholder="••••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={isLoading}
                />
                {confirmPassword && confirmPassword !== newPassword && (
                  <p className="text-xs text-red-400 mt-1">Las contraseñas no coinciden</p>
                )}
              </div>

              <button
                type="submit"
                disabled={isLoading || !newPassword || newPassword !== confirmPassword}
                className="btn-primary w-full justify-center py-2.5"
              >
                {isLoading ? (
                  <><Loader2 size={14} className="animate-spin" /> Guardando...</>
                ) : 'Restablecer contraseña'}
              </button>

              <Link
                to="/login"
                className="flex items-center justify-center gap-2 text-xs text-surface-400 hover:text-surface-200 transition-colors"
              >
                <ArrowLeft size={12} /> Volver al login
              </Link>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-surface-600 mt-6">
          VisionCore VMS v1.0 — Hikvision ISAPI
        </p>
      </div>
    </div>
  )
}
