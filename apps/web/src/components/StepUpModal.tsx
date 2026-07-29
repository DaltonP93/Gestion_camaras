// Modal de verificación de seguridad adicional (step-up MFA, fase 4c). Montado una
// vez en App; se abre vía useStepUpStore.request(). Pide un código TOTP si el usuario
// tiene MFA, o su contraseña si no. Al verificar, resuelve la promesa con el token de
// elevación que withStepUp reenvía en el header x-step-up-token.
import { useEffect, useRef, useState } from 'react'
import { ShieldAlert, Loader2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { apiPost } from '@/lib/api'
import { useStepUpStore } from '@/stores/stepUpStore'
import { useAuthStore } from '@/stores/authStore'

export function StepUpModal() {
  const { open, resolveWith, cancel } = useStepUpStore()
  const usesTotp = useAuthStore((s) => !!s.user?.twoFactorEnabled)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue('')
      setSubmitting(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) cancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cancel])

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const v = value.trim()
    if (!v) { toast.error(usesTotp ? 'Ingresa el código' : 'Ingresa tu contraseña'); return }
    setSubmitting(true)
    try {
      const body = usesTotp ? { code: v } : { password: v }
      const res = await apiPost<{ stepUpToken: string }>('/auth/step-up', body)
      resolveWith(res.stepUpToken)
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Verificación incorrecta')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onMouseDown={cancel}>
      <div className="card p-6 w-full max-w-sm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-900/30 border border-amber-800/40 flex items-center justify-center">
              <ShieldAlert size={18} className="text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-surface-100">Verificación de seguridad</h3>
              <p className="text-[11px] text-surface-400">Confirma tu identidad para continuar</p>
            </div>
          </div>
          <button type="button" onClick={cancel} className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">{usesTotp ? 'Código de tu app autenticadora' : 'Tu contraseña'}</label>
            <input
              ref={inputRef}
              className={usesTotp ? 'input text-center text-lg tracking-widest font-mono' : 'input'}
              type={usesTotp ? 'text' : 'password'}
              inputMode={usesTotp ? 'numeric' : undefined}
              maxLength={usesTotp ? 6 : undefined}
              placeholder={usesTotp ? '000000' : '••••••••'}
              value={value}
              onChange={(e) => setValue(usesTotp ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)}
              autoComplete={usesTotp ? 'one-time-code' : 'current-password'}
              disabled={submitting}
            />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={cancel} className="btn-secondary flex-1 justify-center py-2 text-xs" disabled={submitting}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary flex-1 justify-center py-2 text-xs" disabled={submitting || !value.trim()}>
              {submitting ? <><Loader2 size={14} className="animate-spin" /> Verificando...</> : 'Confirmar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
