// Mosaico de cámara SIMULADO: no hay video. Muestra lo que la integración real debe
// comunicar en cada celda (estado, calidad, pista, huecos, carga, cola, permisos).
import type { ReactNode } from 'react'
import { clsx } from 'clsx'

export type TileTone = 'ok' | 'muted' | 'warn' | 'blocked'

const TONE: Record<TileTone, string> = {
  ok: 'from-slate-700 via-slate-800 to-slate-900',
  muted: 'from-surface-800 to-surface-900',
  warn: 'from-amber-950 to-surface-900',
  blocked: 'from-surface-900 to-black',
}

export function CameraTile(props: {
  testId: string
  title: string
  subtitle?: string
  tone: TileTone
  badges?: ReactNode
  overlay?: ReactNode
  footer?: ReactNode
  onExpand?: () => void
  selected?: boolean
}) {
  return (
    <div
      data-testid={props.testId}
      className={clsx(
        'relative flex min-h-[120px] flex-col overflow-hidden rounded-lg border bg-gradient-to-br',
        TONE[props.tone],
        props.selected ? 'border-brand-500' : 'border-surface-600',
      )}
      onDoubleClick={props.onExpand}
    >
      <div className="flex items-start justify-between gap-2 p-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-surface-50">{props.title}</p>
          {props.subtitle && <p className="truncate text-[11px] text-surface-300">{props.subtitle}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">{props.badges}</div>
      </div>
      <div className="flex flex-1 items-center justify-center px-2 text-center text-xs text-surface-200">
        {props.overlay}
      </div>
      {props.footer && <div className="p-2">{props.footer}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'neutral', testId }: { children: ReactNode; tone?: 'neutral' | 'info' | 'warn' | 'danger' | 'ok'; testId?: string }) {
  const cls = {
    neutral: 'bg-surface-700 text-surface-100',
    info: 'bg-blue-900/70 text-blue-200',
    warn: 'bg-amber-900/70 text-amber-200',
    danger: 'bg-red-900/70 text-red-200',
    ok: 'bg-green-900/70 text-green-200',
  }[tone]
  return <span data-testid={testId} className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', cls)}>{children}</span>
}

export const GRID_CLASS: Record<number, string> = {
  1: 'grid-cols-1',
  4: 'grid-cols-2',
  9: 'grid-cols-3',
  16: 'grid-cols-2 md:grid-cols-4',
}
