// src/pages/LoginPage.tsx
import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shield, Eye, EyeOff, Loader2, Smartphone, ArrowLeft } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

// ─── Paso 1: Usuario + contraseña ────────────────────────────
function LoginForm() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const { login, isLoading } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password) {
      toast.error('Ingresa usuario y contraseña')
      return
    }
    try {
      await login(username, password)
      // If 2FA required, twoFactorChallenge is set and UI switches
      // If no 2FA, login completes and navigate
      if (!useAuthStore.getState().twoFactorChallenge) {
        navigate('/')
      }
    } catch {}
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Usuario</label>
        <input
          className="input"
          type="text"
          placeholder="tu_usuario"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          disabled={isLoading}
        />
      </div>

      <div>
        <label className="label">Contraseña</label>
        <div className="relative">
          <input
            className="input pr-10"
            type={showPass ? 'text' : 'password'}
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
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
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className="btn-primary w-full justify-center py-2.5 mt-2"
      >
        {isLoading ? (
          <><Loader2 size={14} className="animate-spin" /> Ingresando...</>
        ) : 'Iniciar sesión'}
      </button>

      {import.meta.env.DEV && (
        <div className="mt-4 pt-4 border-t border-surface-600">
          <p className="text-xs text-surface-500 text-center mb-2">Demo</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { u: 'admin', r: 'Admin' }, { u: 'supervisor', r: 'Supervisor' },
              { u: 'operador1', r: 'Operador' }, { u: 'auditor', r: 'Auditor' },
            ].map(({ u, r }) => (
              <button
                key={u}
                type="button"
                onClick={() => { setUsername(u); setPassword(u.charAt(0).toUpperCase() + u.slice(1) + '123!') }}
                className="text-xs px-2 py-1.5 rounded-md bg-surface-700 text-surface-300 hover:text-surface-100 hover:bg-surface-600 transition-colors text-left"
              >
                <span className="font-medium">{u}</span>
                <span className="block text-surface-500">{r}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </form>
  )
}

// ─── Paso 2: Código TOTP / código de recuperación ────────────
function TwoFactorForm() {
  const [code, setCode] = useState('')
  const { verify2FA, cancelTwoFactor, isLoading, twoFactorChallenge } = useAuthStore()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = code.replace(/\s/g, '')
    if (!trimmed) { toast.error('Ingresa el código'); return }
    try {
      await verify2FA(trimmed)
      navigate('/')
    } catch {}
  }

  const isBackupCode = code.replace(/\s/g, '').length === 8

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-lg bg-brand-900/30 border border-brand-800/40">
        <Smartphone size={16} className="text-brand-400 flex-shrink-0" />
        <div>
          <p className="text-xs font-medium text-surface-100">Verificación en dos pasos</p>
          <p className="text-[11px] text-surface-400 mt-0.5">
            {twoFactorChallenge?.username && `Usuario: ${twoFactorChallenge.username} · `}
            Ingresa el código de tu app autenticadora
          </p>
        </div>
      </div>

      <div>
        <label className="label">
          {isBackupCode ? 'Código de recuperación' : 'Código TOTP (6 dígitos)'}
        </label>
        <input
          ref={inputRef}
          className="input text-center text-lg tracking-widest font-mono"
          type="text"
          inputMode="numeric"
          maxLength={8}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9A-Fa-f]/g, ''))}
          autoComplete="one-time-code"
          disabled={isLoading}
        />
        <p className="text-[10px] text-surface-500 mt-1">
          Sin acceso a tu app? Usa uno de tus códigos de recuperación (8 caracteres)
        </p>
      </div>

      <button
        type="submit"
        disabled={isLoading || code.replace(/\s/g, '').length < 6}
        className="btn-primary w-full justify-center py-2.5"
      >
        {isLoading ? <><Loader2 size={14} className="animate-spin" /> Verificando...</> : 'Verificar'}
      </button>

      <button
        type="button"
        onClick={cancelTwoFactor}
        className="w-full flex items-center justify-center gap-2 text-xs text-surface-400 hover:text-surface-200 transition-colors mt-1"
      >
        <ArrowLeft size={12} /> Volver al inicio de sesión
      </button>
    </form>
  )
}

// ─── LoginPage ────────────────────────────────────────────────
export function LoginPage() {
  const { twoFactorChallenge } = useAuthStore()

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
            <p className="text-sm text-surface-400 mt-1">Sistema de gestión NVR</p>
          </div>

          {twoFactorChallenge ? <TwoFactorForm /> : <LoginForm />}
        </div>

        <p className="text-center text-xs text-surface-600 mt-6">
          VisionCore VMS v1.0 — Hikvision ISAPI
        </p>
      </div>
    </div>
  )
}
