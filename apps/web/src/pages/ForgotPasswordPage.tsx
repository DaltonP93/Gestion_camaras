// src/pages/ForgotPasswordPage.tsx
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Shield, Loader2, Mail, ArrowLeft, CheckCircle } from 'lucide-react'
import { apiPost } from '@/lib/api'
import toast from 'react-hot-toast'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) { toast.error('Ingresa tu correo'); return }
    setIsLoading(true)
    try {
      await apiPost('/auth/forgot-password', { email })
      setSent(true)
    } catch {
      // Always show success to avoid email enumeration
      setSent(true)
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
            <p className="text-sm text-surface-400 mt-1">Recuperar contraseña</p>
          </div>

          {sent ? (
            <div className="text-center space-y-4">
              <CheckCircle size={40} className="text-green-400 mx-auto" />
              <div>
                <p className="text-sm font-medium text-surface-100">Instrucciones enviadas</p>
                <p className="text-xs text-surface-400 mt-1.5">
                  Si el correo <strong>{email}</strong> está registrado, recibirás un enlace para restablecer tu contraseña.
                  Revisa también tu carpeta de spam.
                </p>
              </div>
              <p className="text-xs text-surface-500">El enlace expira en 30 minutos.</p>
              <button
                onClick={() => navigate('/login')}
                className="btn-secondary w-full justify-center"
              >
                <ArrowLeft size={13} /> Volver al login
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-xs text-surface-400 leading-relaxed">
                Ingresa tu correo electrónico y te enviaremos un enlace para restablecer tu contraseña.
              </p>

              <div>
                <label className="label">Correo electrónico</label>
                <div className="relative">
                  <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                  <input
                    className="input pl-9"
                    type="email"
                    placeholder="tu@correo.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    disabled={isLoading}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading || !email}
                className="btn-primary w-full justify-center py-2.5"
              >
                {isLoading ? (
                  <><Loader2 size={14} className="animate-spin" /> Enviando...</>
                ) : 'Enviar instrucciones'}
              </button>

              <Link
                to="/login"
                className="flex items-center justify-center gap-2 text-xs text-surface-400 hover:text-surface-200 transition-colors mt-1"
              >
                <ArrowLeft size={12} /> Volver al inicio de sesión
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
