// Reproducción multicámara sincronizada (datos simulados, sin video).
// Reloj común, velocidades, seek, pistas archivadas reales por cámara, huecos,
// carga y límite de sesiones por NVR.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { FastForward, Pause, Play, Rewind } from 'lucide-react'
import { CAMERAS, SIM_DAY, WINDOW, cameraById, fmtClock, nvrById } from '../data/mock'
import { canDownload, canPlayback } from '../model/permissions'
import {
  SPEEDS, chooseTrack, clockReducer, initialClock, planCells, simulatedLoadMs,
  type CellState, type PlaybackMode, type TrackId, type TrackReason,
} from '../model/playback'
import { useSession } from '../session'
import { Badge, CameraTile, GRID_CLASS } from '../components/CameraTile'

const MAX_CELLS = 9
const TRACK_LABEL: Record<TrackId, string> = { main: 'principal', sub: 'subflujo' }
const REASON_TEXT: Record<TrackReason, string> = {
  'principal': 'Pista principal',
  'solo-subflujo': 'Subflujo: la principal no tiene grabación en este instante',
  'subflujo-archivado': 'Subflujo archivado',
  'sin-subflujo': 'Principal: el NVR no grabó subflujo en este instante',
  'hueco': 'Sin grabación',
}

export function PlaybackPage() {
  const { user } = useSession()
  const allowed = useMemo(() => CAMERAS.filter(c => canPlayback(user, c)), [user])
  const [selected, setSelected] = useState<string[]>(() => allowed.slice(0, 4).map(c => c.id))
  const [clock, dispatch] = useReducer(clockReducer, undefined, () => initialClock())
  const [loadingUntil, setLoadingUntil] = useState<Record<string, number>>({})
  const [now, setNow] = useState(() => performance.now())
  const lastKeys = useRef<Record<number, string>>({})

  useEffect(() => { setSelected(allowed.slice(0, 4).map(c => c.id)); lastKeys.current = {} }, [allowed])

  const mode: PlaybackMode = selected.length <= 1 ? 'single' : 'grid'
  const cellCount = selected.length <= 1 ? 1 : selected.length <= 4 ? 4 : 9
  const slots = Array.from({ length: cellCount }, (_, i) => selected[i] ?? null)
  const { cells, usage } = planCells(user, slots, clock.t, mode)

  // Una celda que pasa a activa o cambia de pista empieza a cargar.
  const cellKeys = cells.map(c => (c.kind === 'activa' ? `${c.cameraId}:${c.track}` : c.kind))
  const cellsSignature = cellKeys.join('|')
  useEffect(() => {
    const t0 = performance.now()
    const updates: Record<string, number> = {}
    cellKeys.forEach((key, i) => {
      const c = cells[i]
      if (lastKeys.current[i] !== key && c.kind === 'activa') updates[i] = t0 + simulatedLoadMs(i, c.track)
      lastKeys.current[i] = key
    })
    if (Object.keys(updates).length) setLoadingUntil(prev => ({ ...prev, ...updates }))
    // cellsSignature resume `cells`: sólo se reevalúa cuando cambia alguna celda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsSignature])

  const isLoading = (i: number) => cells[i]?.kind === 'activa' && (loadingUntil[i] ?? 0) > now
  const anyBuffering = cells.some((_, i) => isLoading(i))

  // Reloj: avanza con el tiempo real × velocidad (y espera la carga si la sincronía es estricta).
  const anyBufferingRef = useRef(anyBuffering)
  anyBufferingRef.current = anyBuffering
  useEffect(() => {
    let last = performance.now()
    const id = window.setInterval(() => {
      const t = performance.now()
      dispatch({ type: 'tick', dtMs: t - last, anyBuffering: anyBufferingRef.current })
      setNow(t)
      last = t
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  const seek = (t: number) => {
    dispatch({ type: 'seek', t })
    // Un seek fuera del bloque cargado reabre todas las celdas activas.
    const t0 = performance.now()
    setLoadingUntil(Object.fromEntries(slots.map((id, i) => {
      const cam = id ? cameraById(id) : undefined
      const choice = cam ? chooseTrack(cam, t, mode) : null
      return [i, choice?.track ? t0 + simulatedLoadMs(i, choice.track) : 0]
    })))
  }

  const toggleCamera = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= MAX_CELLS ? prev : [...prev, id])
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 lg:flex-row">
      <aside className="card shrink-0 p-3 lg:w-60" data-testid="camera-picker">
        <h2 className="mb-2 text-sm font-semibold text-surface-50">Cámaras ({selected.length}/{MAX_CELLS})</h2>
        {allowed.length === 0 && <p className="text-xs text-surface-400" data-testid="no-playback-cameras">No tenés permiso de reproducción en ninguna cámara.</p>}
        <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
          {allowed.map(c => (
            <li key={c.id}>
              <label className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm text-surface-200 hover:bg-surface-700">
                <input type="checkbox" data-testid={`pick-${c.id}`} checked={selected.includes(c.id)} onChange={() => toggleCamera(c.id)} />
                {c.name}
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-surface-400">Día simulado {SIM_DAY}, 08:00–12:00.</p>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="card flex flex-wrap items-center gap-2 p-2" data-testid="playback-controls">
          <button type="button" data-testid="step-back" aria-label="Retroceder 10 segundos" className="btn-secondary min-h-[44px]" onClick={() => seek(clock.t - 10)}>
            <Rewind className="h-4 w-4" /> 10 s
          </button>
          <button type="button" data-testid="play-pause" aria-label={clock.playing ? 'Pausar' : 'Reproducir'} className="btn-primary min-h-[44px]"
            onClick={() => dispatch({ type: 'toggle' })}>
            {clock.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {clock.playing ? 'Pausa' : 'Reproducir'}
          </button>
          <button type="button" data-testid="step-forward" aria-label="Avanzar 10 segundos" className="btn-secondary min-h-[44px]" onClick={() => seek(clock.t + 10)}>
            10 s <FastForward className="h-4 w-4" />
          </button>
          <div role="group" aria-label="Velocidad" className="flex gap-1">
            {SPEEDS.map(s => (
              <button key={s} type="button" data-testid={`speed-${s}`} aria-pressed={clock.speed === s}
                className={clsx('btn-secondary min-h-[44px] px-3', clock.speed === s && 'border-brand-500 text-brand-200')}
                onClick={() => dispatch({ type: 'speed', speed: s })}>
                {s}×
              </button>
            ))}
          </div>
          <span className="font-mono text-lg text-surface-50" data-testid="clock" data-t={Math.floor(clock.t)} data-t-exact={clock.t.toFixed(3)}>{fmtClock(clock.t)}</span>
          <label className="flex min-h-[44px] items-center gap-2 text-xs text-surface-200">
            <input type="checkbox" data-testid="strict-sync" checked={clock.strictSync} onChange={e => dispatch({ type: 'strict', value: e.target.checked })} />
            Esperar a todas las celdas
          </label>
          {anyBuffering && <Badge tone="warn" testId="buffering-indicator">Cargando {cells.filter((_, i) => isLoading(i)).length} celda(s)</Badge>}
        </div>

        <div className="flex flex-wrap gap-2" data-testid="nvr-usage">
          {usage.map(u => (
            <Badge key={u.nvrId} tone={u.queued > 0 ? 'warn' : 'neutral'} testId={`usage-${u.nvrId}`}>
              {u.name}: {u.active}/{u.limit} sesiones{u.queued > 0 ? ` · ${u.queued} en cola` : ''}
            </Badge>
          ))}
        </div>

        <div className={clsx('grid flex-1 auto-rows-fr gap-2', GRID_CLASS[cellCount])} data-testid="playback-grid" data-cells={cellCount} data-mode={mode}>
          {cells.map((c, i) => <PlaybackCell key={i} index={i} cell={c} loading={isLoading(i)} playing={clock.playing} t={clock.t}
            onJump={t => seek(t)} downloadable={c.kind === 'activa' && canDownload(user, cameraById(c.cameraId)!)} />)}
        </div>

        <Timeline cameraIds={selected} t={clock.t} onSeek={seek} />
      </section>
    </div>
  )
}

function PlaybackCell(props: { index: number; cell: CellState; loading: boolean; playing: boolean; t: number; onJump: (t: number) => void; downloadable: boolean }) {
  const { cell, index: i } = props
  const testId = `pcell-${i}`
  if (cell.kind === 'vacia') return <CameraTile testId={testId} title="Celda vacía" tone="muted" />
  const cam = cameraById(cell.cameraId)!
  const title = cam.name
  const subtitle = nvrById(cam.nvrId)?.name
  if (cell.kind === 'sin-permiso') {
    return <CameraTile testId={testId} title="Cámara no permitida" tone="blocked" overlay={<span data-testid={`${testId}-state`} data-state="sin-permiso">Sin permiso de reproducción</span>} />
  }
  if (cell.kind === 'hueco') {
    return (
      <CameraTile testId={testId} title={title} subtitle={subtitle} tone="muted"
        badges={<Badge tone="neutral">Hueco</Badge>}
        overlay={
          <div className="flex flex-col items-center gap-2" data-testid={`${testId}-state`} data-state="hueco">
            <span>Sin grabación en {fmtClock(props.t)}</span>
            {cell.nextAt !== null ? (
              <button type="button" data-testid={`${testId}-jump`} className="btn-secondary min-h-[44px]" onClick={() => props.onJump(cell.nextAt!)}>
                Ir al próximo tramo ({fmtClock(cell.nextAt)})
              </button>
            ) : <span className="text-surface-400">No hay más grabación en la ventana</span>}
          </div>
        } />
    )
  }
  const trackBadge = (
    <Badge tone={cell.reason === 'sin-subflujo' || cell.reason === 'solo-subflujo' ? 'warn' : 'info'} testId={`${testId}-track`}>
      {TRACK_LABEL[cell.track]} · pista {cam.channel * 100 + (cell.track === 'main' ? 1 : 2)}
    </Badge>
  )
  if (cell.kind === 'en-cola') {
    return (
      <CameraTile testId={testId} title={title} subtitle={subtitle} tone="warn" badges={trackBadge}
        overlay={<span data-testid={`${testId}-state`} data-state="en-cola">
          En cola · posición {cell.position} · el NVR acepta {cell.limit} sesión(es) de reproducción
        </span>} />
    )
  }
  return (
    <CameraTile testId={testId} title={title} subtitle={subtitle} tone="ok" badges={trackBadge}
      overlay={props.loading
        ? <span data-testid={`${testId}-state`} data-state="cargando">Cargando…</span>
        : <span data-testid={`${testId}-state`} data-state={props.playing ? 'reproduciendo' : 'pausa'} className="font-mono text-surface-100">
            {fmtClock(props.t)} {props.playing ? '' : '(pausa)'}
          </span>}
      footer={<div className="flex items-center justify-between text-[11px] text-surface-300">
        <span>{REASON_TEXT[cell.reason]}</span>
        {props.downloadable && <span data-testid={`${testId}-download`}>Descarga permitida</span>}
      </div>} />
  )
}

function Timeline(props: { cameraIds: string[]; t: number; onSeek: (t: number) => void }) {
  const span = WINDOW.end - WINDOW.start
  const pct = (x: number) => `${((x - WINDOW.start) / span) * 100}%`
  const width = (a: number, b: number) => `${((Math.min(b, WINDOW.end) - Math.max(a, WINDOW.start)) / span) * 100}%`
  return (
    <div className="card p-2" data-testid="timeline">
      <input
        type="range"
        aria-label="Posición del reloj común"
        data-testid="seek-range"
        className="w-full min-h-[44px]"
        min={WINDOW.start}
        max={WINDOW.end}
        step={1}
        value={Math.floor(props.t)}
        onChange={e => props.onSeek(Number(e.target.value))}
      />
      <div className="mt-1 flex flex-col gap-1">
        {props.cameraIds.map(id => {
          const cam = cameraById(id)!
          return (
            <div key={id} className="flex items-center gap-2" data-testid={`tl-${id}`}>
              <span className="w-28 shrink-0 truncate text-[11px] text-surface-300">{cam.name}</span>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-surface-900" title="Gris: sin grabación">
                {cam.archived.main.map((s, k) => (
                  <div key={`m${k}`} className="absolute top-0 h-2.5 bg-blue-500/80" style={{ left: pct(s.start), width: width(s.start, s.end) }} />
                ))}
                {cam.archived.sub.map((s, k) => (
                  <div key={`s${k}`} className="absolute bottom-0 h-2.5 bg-teal-400/70" style={{ left: pct(s.start), width: width(s.start, s.end) }} />
                ))}
                <div className="absolute inset-y-0 w-0.5 bg-brand-400" style={{ left: pct(props.t) }} />
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex gap-3 text-[11px] text-surface-400">
        <span><span className="mr-1 inline-block h-2 w-3 bg-blue-500/80" />principal archivada</span>
        <span><span className="mr-1 inline-block h-2 w-3 bg-teal-400/70" />subflujo archivado</span>
        <span><span className="mr-1 inline-block h-2 w-3 bg-surface-900 ring-1 ring-surface-600" />hueco</span>
      </div>
    </div>
  )
}
