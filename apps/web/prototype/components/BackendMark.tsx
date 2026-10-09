// Marca persistente del estado de backend de una sección o control (model/backend.ts).
import { clsx } from 'clsx'
import { FlaskConical, PlugZap } from 'lucide-react'
import { backendText, type BackendStatus } from '../model/backend'

export function BackendMark({ status, testId = 'backend-status', className }: { status: BackendStatus; testId?: string; className?: string }) {
  const simulated = status.kind === 'simulado'
  const Icon = simulated ? FlaskConical : PlugZap
  return (
    <span
      role="note"
      data-testid={testId}
      data-backend={status.kind}
      className={clsx(
        'inline-flex items-start gap-1 rounded px-1.5 py-0.5 text-[11px] leading-snug',
        simulated ? 'bg-fuchsia-950/70 text-fuchsia-200 ring-1 ring-fuchsia-800' : 'bg-sky-950/70 text-sky-200 ring-1 ring-sky-800',
        className,
      )}
    >
      <Icon aria-hidden className="mt-px h-3 w-3 shrink-0" />
      <span>{backendText(status)}</span>
    </span>
  )
}
