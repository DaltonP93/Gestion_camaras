// Eventos de detección (simulados). Sólo cámaras permitidas; retención visible.
import { useMemo, useState } from 'react'
import { CAMERAS, EVENTS, cameraById, fmtClock, type DetectionEvent } from '../data/mock'
import { canPlayback, canSeeCameraEvents } from '../model/permissions'
import { useSession } from '../session'
import { Badge } from '../components/CameraTile'

const LABELS: Array<DetectionEvent['label'] | ''> = ['', 'persona', 'vehículo', 'animal']

export function EventsPage() {
  const { user } = useSession()
  const cameras = useMemo(() => CAMERAS.filter(c => canSeeCameraEvents(user, c)), [user])
  const [cameraId, setCameraId] = useState('')
  const [label, setLabel] = useState<DetectionEvent['label'] | ''>('')
  const events = EVENTS
    .filter(e => cameras.some(c => c.id === e.cameraId))
    .filter(e => !cameraId || e.cameraId === cameraId)
    .filter(e => !label || e.label === label)

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label" htmlFor="ev-camera">Cámara</label>
          <select id="ev-camera" data-testid="events-camera" className="input min-h-[44px]" value={cameraId} onChange={e => setCameraId(e.target.value)}>
            <option value="">Todas las permitidas ({cameras.length})</option>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ev-label">Objeto</label>
          <select id="ev-label" data-testid="events-label" className="input min-h-[44px]" value={label} onChange={e => setLabel(e.target.value as DetectionEvent['label'] | '')}>
            {LABELS.map(l => <option key={l} value={l}>{l || 'Todos'}</option>)}
          </select>
        </div>
        <p className="text-xs text-surface-400">
          Las ventanas de evento retenidas se guardan completas en el servidor; el archivo continuo sigue en el NVR.
        </p>
      </div>
      {user.role !== 'ADMIN' && (
        <p className="text-xs text-amber-300" data-testid="events-scope-note">
          Hoy la API sólo muestra eventos de cámaras con permiso de visualización explícito, también para Supervisor.
        </p>
      )}
      <ul className="flex flex-col gap-2" data-testid="events-list">
        {events.length === 0 && <li className="text-sm text-surface-300">Sin eventos para estos filtros.</li>}
        {events.map(e => {
          const cam = cameraById(e.cameraId)!
          return (
            <li key={e.id} className="card flex flex-wrap items-center gap-3 p-3" data-testid={`event-${e.id}`}>
              <div className="h-14 w-24 shrink-0 rounded bg-gradient-to-br from-slate-700 to-slate-900" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-surface-50">{e.label} · {cam.name}</p>
                <p className="text-xs text-surface-300">{fmtClock(e.start)}–{fmtClock(e.end)} · zona {e.zone ?? '—'} · confianza {Math.round(e.score * 100)} %</p>
              </div>
              <Badge tone={e.retained ? 'ok' : 'neutral'} testId={`event-${e.id}-retention`}>{e.retained ? 'Clip retenido' : 'Sólo en NVR'}</Badge>
              {canPlayback(user, cam) && <Badge tone="info">Ver en grabaciones</Badge>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
