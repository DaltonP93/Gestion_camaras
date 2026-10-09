// Sustituto VisionCore de `@/components/indicators/activity-indicator` de Frigate:
// mismo contrato (className, size) con el ícono de VisionCore (lucide-react), para
// no sumar react-icons.
import { Loader2 } from 'lucide-react'
import { clsx } from 'clsx'

export default function ActivityIndicator({ className = 'w-full', size = 30 }: { className?: string; size?: number }) {
  return (
    <div className={clsx('flex items-center justify-center', className)} aria-label="Cargando">
      <Loader2 className="animate-spin text-surface-300" width={size} height={size} />
    </div>
  )
}
