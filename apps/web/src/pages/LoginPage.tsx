// src/pages/LoginPage.tsx
import { useState, useRef, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Shield, Eye, EyeOff, Loader2, Smartphone, ArrowLeft } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useAppearanceStore } from '@/stores/appearanceStore'
import { resolveAssetUrl } from '@/lib/api'
import toast from 'react-hot-toast'

// ─── Paso 1: Usuario + contraseña ────────────────────────────
function LoginForm() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
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
      await login(username, password, rememberMe)
      // Si se requiere 2FA o enrolamiento forzoso, la UI cambia de paso y no navegamos.
      const st = useAuthStore.getState()
      if (st.twoFactorChallenge || st.mfaEnrollment) return
      if (st.mfaGraceRemaining !== null) {
        toast(
          st.mfaGraceRemaining > 0
            ? `MFA será obligatorio pronto: te quedan ${st.mfaGraceRemaining} inicio(s) de sesión sin segundo factor. Actívalo en tu perfil.`
            : 'Este es tu último inicio de sesión sin MFA. La próxima vez deberás enrolar el segundo factor.',
          { icon: '⚠️', duration: 7000 },
        )
      }
      navigate('/')
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

      <div className="flex items-center gap-2">
        <input
          id="rememberMe"
          type="checkbox"
          checked={rememberMe}
          onChange={(e) => setRememberMe(e.target.checked)}
          className="w-4 h-4 rounded accent-brand-500 cursor-pointer"
          disabled={isLoading}
        />
        <label htmlFor="rememberMe" className="text-xs text-surface-400 cursor-pointer select-none">
          Recordarme en este dispositivo
        </label>
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className="btn-primary w-full justify-center py-2.5"
      >
        {isLoading ? (
          <><Loader2 size={14} className="animate-spin" /> Ingresando...</>
        ) : 'Iniciar sesión'}
      </button>

      <div className="text-center mt-1">
        <Link
          to="/forgot-password"
          className="text-xs text-surface-400 hover:text-brand-400 transition-colors"
        >
          ¿Olvidaste tu contraseña?
        </Link>
      </div>

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

// ─── Paso 2 (alt): Enrolamiento forzoso de MFA ───────────────
function MfaEnrollForm() {
  const { startMfaEnroll, completeMfaEnroll, cancelMfaEnroll, isLoading, mfaEnrollment } = useAuthStore()
  const navigate = useNavigate()
  const [qrCodeUri, setQrCodeUri] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [loadingQr, setLoadingQr] = useState(true)
  const [backupCodes, setBackupCodes] = useState<string[]>([])

  useEffect(() => {
    let active = true
    startMfaEnroll()
      .then((d) => { if (active) { setQrCodeUri(d.qrCodeUri); setSecret(d.secret) } })
      .catch((err: any) => toast.error(err?.response?.data?.message || 'No se pudo iniciar el enrolamiento'))
      .finally(() => { if (active) setLoadingQr(false) })
    return () => { active = false }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = code.replace(/\s/g, '')
    if (trimmed.length !== 6) { toast.error('Ingresa el código de 6 dígitos'); return }
    try {
      const codes = await completeMfaEnroll(trimmed)
      setBackupCodes(codes)   // muestra los códigos de recuperación antes de continuar
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Código incorrecto')
    }
  }

  // Pantalla final: mostrar los códigos de recuperación una única vez.
  if (backupCodes.length > 0) {
    return (
      <div className="space-y-4">
        <div className="p-3 rounded-lg bg-emerald-900/30 border border-emerald-800/40">
          <p className="text-xs font-medium text-emerald-300">MFA activado correctamente</p>
          <p className="text-[11px] text-surface-400 mt-0.5">
            Guarda estos códigos de recuperación en un lugar seguro. No se volverán a mostrar.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {backupCodes.map((c, i) => (
            <code key={i} className="text-center text-sm font-mono bg-surface-800 border border-surface-600 rounded-lg py-1.5 text-surface-100">{c}</code>
          ))}
        </div>
        <button
          onClick={() => { navigator.clipboard.writeText(backupCodes.join('\n')); toast.success('Códigos copiados') }}
          className="btn-secondary w-full justify-center py-2 text-xs"
        >
          Copiar códigos
        </button>
        <button onClick={() => navigate('/')} className="btn-primary w-full justify-center py-2.5">
          Continuar
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-900/30 border border-amber-800/40">
        <Shield size={16} className="text-amber-400 flex-shrink-0" />
        <div>
          <p className="text-xs font-medium text-surface-100">MFA obligatorio</p>
          <p className="text-[11px] text-surface-400 mt-0.5">
            {mfaEnrollment?.username && `Usuario: ${mfaEnrollment.username} · `}
            Debes activar el segundo factor para continuar
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center">
        {loadingQr ? (
          <div className="w-48 h-48 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-surface-400" /></div>
        ) : qrCodeUri ? (
          <img src={qrCodeUri} alt="QR Code MFA" className="w-48 h-48 rounded-xl border border-surface-600" />
        ) : null}
        {secret && (
          <p className="text-[11px] text-surface-500 mt-2">
            Clave manual: <code className="text-surface-300 font-mono">{secret}</code>
          </p>
        )}
        <p className="text-[11px] text-surface-400 mt-2 text-center">
          Escanea el código con Google Authenticator, Authy o similar e ingresa el código generado.
        </p>
      </div>

      <div>
        <label className="label">Código TOTP (6 dígitos)</label>
        <input
          className="input text-center text-lg tracking-widest font-mono"
          type="text"
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
          autoComplete="one-time-code"
          disabled={isLoading || loadingQr}
        />
      </div>

      <button
        type="submit"
        disabled={isLoading || loadingQr || code.replace(/\s/g, '').length !== 6}
        className="btn-primary w-full justify-center py-2.5"
      >
        {isLoading ? <><Loader2 size={14} className="animate-spin" /> Activando...</> : 'Activar MFA e ingresar'}
      </button>

      <button
        type="button"
        onClick={cancelMfaEnroll}
        className="w-full flex items-center justify-center gap-2 text-xs text-surface-400 hover:text-surface-200 transition-colors mt-1"
      >
        <ArrowLeft size={12} /> Volver al inicio de sesión
      </button>
    </form>
  )
}

// ─── LoginPage ────────────────────────────────────────────────
export function LoginPage() {
  const { twoFactorChallenge, mfaEnrollment } = useAuthStore()
  const { settings: appearance, load: loadAppearance } = useAppearanceStore()

  // Load appearance on login page (user not authenticated yet, App.tsx may not have run loadAppearance)
  useEffect(() => { loadAppearance() }, [])

  const logoUrl = resolveAssetUrl(appearance.logoUrl)
  const siteName = appearance.siteName || 'VisionCore'

  return (
    <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(48,54,61,0.3)_1px,transparent_1px),linear-gradient(90deg,rgba(48,54,61,0.3)_1px,transparent_1px)] bg-[size:32px_32px]" />

      <div className="relative w-full max-w-sm">
        <div className="card p-8 shadow-2xl">
          <div className="flex flex-col items-center mb-8">
            {logoUrl ? (
              <img src={logoUrl} alt={siteName} className="h-14 object-contain mb-4" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
            ) : (
              <div className="w-14 h-14 rounded-2xl bg-brand-600 flex items-center justify-center mb-4 shadow-lg shadow-brand-900/50">
                <Shield size={28} className="text-white" />
              </div>
            )}
            <h1 className="text-xl font-semibold text-surface-50">{siteName}</h1>
            <p className="text-sm text-surface-400 mt-1">Sistema de gestión NVR</p>
          </div>

          {mfaEnrollment ? <MfaEnrollForm /> : twoFactorChallenge ? <TwoFactorForm /> : <LoginForm />}
        </div>

        <p className="text-center text-xs text-surface-600 mt-6">
          VisionCore VMS v1.0 — Hikvision ISAPI
        </p>
      </div>
    </div>
  )
}
