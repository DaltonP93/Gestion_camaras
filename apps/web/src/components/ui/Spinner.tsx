// src/components/ui/Spinner.tsx
import { Loader2 } from 'lucide-react'
import { clsx } from 'clsx'

interface Props {
  size?: 'sm' | 'md' | 'lg'
  className?: string
  label?: string
}

const SIZES = { sm: 14, md: 20, lg: 32 }

export function Spinner({ size = 'md', className, label }: Props) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-2', className)}>
      <Loader2 size={SIZES[size]} className="text-brand-500 animate-spin" />
      {label && <span className="text-xs text-surface-400">{label}</span>}
    </div>
  )
}
