// src/components/ui/EmptyState.tsx
import type { LucideIcon } from 'lucide-react'

interface Props {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}

export function EmptyState({ icon: Icon, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-surface-800 flex items-center justify-center mb-4">
        <Icon size={24} className="text-surface-600" />
      </div>
      <h3 className="text-sm font-medium text-surface-300 mb-1">{title}</h3>
      {description && (
        <p className="text-xs text-surface-500 max-w-xs mb-4">{description}</p>
      )}
      {action && action}
    </div>
  )
}
