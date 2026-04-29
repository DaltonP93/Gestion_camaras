// src/components/nvr/NVRCard.tsx
import { Server, Wifi, WifiOff, HardDrive } from 'lucide-react'
import { clsx } from 'clsx'
import type { NVR, NVRStatus } from '@/types'

interface Props {
  nvr: NVR
  status?: NVRStatus
  onClick?: () => void
  compact?: boolean
}

export function NVRCard({ nvr, status, onClick, compact }: Props) {
  const isOnline = status?.online ?? nvr.active
  const diskPct = status?.diskUsage ?? 0

  if (compact) {
    return (
      <div
        onClick={onClick}
        className={clsx(
          'flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors',
          onClick && 'cursor-pointer hover:bg-surface-700',
          isOnline ? 'border-surface-600' : 'border-surface-700 opacity-60'
        )}
      >
        <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', isOnline ? 'bg-green-400' : 'bg-surface-500')} />
        <span className="text-xs text-surface-200 flex-1 truncate">{nvr.name}</span>
        <span className="text-xs text-surface-500">{nvr.channels}ch</span>
      </div>
    )
  }

  return (
    <div
      onClick={onClick}
      className={clsx(
        'card p-4 transition-colors',
        onClick && 'cursor-pointer hover:border-surface-500'
      )}
    >
      <div className="flex items-start gap-3 mb-3">
        <div className={clsx(
          'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
          isOnline ? 'bg-green-900/30' : 'bg-surface-700'
        )}>
          <Server size={18} className={isOnline ? 'text-green-400' : 'text-surface-500'} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-surface-100 truncate">{nvr.name}</div>
          <div className="text-xs text-surface-400 truncate">{nvr.model}</div>
          {nvr.location && (
            <div className="text-xs text-surface-500 truncate">{nvr.location}</div>
          )}
        </div>
        <div className="flex-shrink-0">
          {isOnline
            ? <Wifi size={14} className="text-green-400" />
            : <WifiOff size={14} className="text-surface-500" />
          }
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center mb-3">
        {[
          { label: 'Canales', value: nvr.channels },
          { label: 'HDDs', value: nvr.hddCount },
          { label: 'IP', value: nvr.ipAddress.split('.').slice(-1)[0] + '.*' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-surface-900 rounded-lg p-2">
            <div className="text-xs text-surface-400">{label}</div>
            <div className="text-xs font-semibold text-surface-200 mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      {status && (
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-surface-400 flex items-center gap-1">
              <HardDrive size={10} /> Almacenamiento
            </span>
            <span className={clsx(
              'font-medium',
              diskPct > 85 ? 'text-red-400' : diskPct > 70 ? 'text-amber-400' : 'text-surface-400'
            )}>
              {diskPct}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-surface-700 rounded-full overflow-hidden">
            <div
              className={clsx(
                'h-full rounded-full transition-all',
                diskPct > 85 ? 'bg-red-500' : diskPct > 70 ? 'bg-amber-500' : 'bg-green-500'
              )}
              style={{ width: `${diskPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
