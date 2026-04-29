// src/components/alerts/SeverityBadge.tsx
import { clsx } from 'clsx'
import type { AlertSeverity } from '@/types'

const CONFIG: Record<AlertSeverity, { label: string; classes: string }> = {
  CRITICAL: { label: 'Crítico', classes: 'bg-red-900/40 text-red-400 border-red-800' },
  HIGH:     { label: 'Alto',    classes: 'bg-orange-900/40 text-orange-400 border-orange-800' },
  MEDIUM:   { label: 'Medio',   classes: 'bg-amber-900/40 text-amber-400 border-amber-800' },
  LOW:      { label: 'Bajo',    classes: 'bg-blue-900/40 text-blue-400 border-blue-800' },
}

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const { label, classes } = CONFIG[severity]
  return (
    <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full border', classes)}>
      {label}
    </span>
  )
}
