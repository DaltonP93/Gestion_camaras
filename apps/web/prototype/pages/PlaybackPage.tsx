// Reproducción multicámara sincronizada (datos simulados, sin video).
// Reloj común, velocidades, seek, pistas archivadas reales por cámara, huecos,
// carga, límite de sesiones por NVR y sincronía POR CELDA: una celda que carga o
// queda bloqueada no detiene a las demás (salvo con "Esperar a todas"); la que se
// atrasa muestra su desfase y se resincroniza sola con su botón.
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { clsx } from 'clsx'
import { FastForward, Minus, Pause, Play, Plus, RefreshCw, Rewind } from 'lucide-react'
import { CAMERAS, DEFAULT_START, SIM_DAY, WINDOW, cameraById, fmtClock, nvrById } from '../sim/mock'
import { canDownload, canPlayback } from '../model/permissions'
import {
  DEFAULT_ZOOM, SPEEDS, ZOOM_LEVELS, cellOffset, centeredRange, followPlayhead, fmtTime, gapLabel, gapsInRange,
  gridFit, initialSync, isCellLoading, isOutOfSync, planCells, simulatedLoadMs, syncReducer, timelineTicks,
  zoomIn, zoomOut,
  type CellState, type CellSync, type PlaybackMode, type TrackId, type TrackReason,
} from '../model/playback'
import { PLAYBACK_BACKEND } from '../model/backend'
import { useSession } from '../session'
import { Badge, CameraTile, GRID_CLASS } from '../components/CameraTile'
import { SidePanel } from '../components/SidePanel'
import { BackendMark } from '../components/BackendMark'

const MAX_CELLS = 9
const TRACK_LABEL: Record<TrackId, string> = { main: 'principal', sub: 'subflujo' }
const REASON_TEXT: Record<TrackReason, string> = {
  'principal': 'Pista principal',
  'solo-subflujo': 'Subflujo: la principal no tiene grabación en este instante',
  'subflujo-archivado': 'Subflujo archivado',
  'sin-subflujo': 'Principal: el NVR no grabó subflujo en este instante',
  'hueco': 'Sin grabación',
}

type CellView = 'cargando' | 'bloqueada' | 'esperando' | 'reproduciendo' | 'pausa'

export function PlaybackPage() {
  const { user } = useSession()
  const allowed = useMemo(() => CAMERAS.filter(c => canPlayback(user, c)), [user])
  const [selected, setSelected] = useState<string[]>(() => allowed.slice(0, 4).map(c => c.id))
  const [sync, dispatch] = useReducer(syncReducer, undefined, () => initialSync(DEFAULT_START))
  const clock = sync.clock
  const [pickerOpen, setPickerOpen] = useState(false)
  const [stallCell, setStallCell] = useState(0)
  const lastKeys = useRef<Record<number, string>>({})

  useEffect(() => {
    // Otro usuario: se cierran todas las sesiones (y bloqueos simulados) y se reabren las permitidas.
    for (const k of Object.keys(lastKeys.current)) dispatch({ type: 'close', index: Number(k) })
    lastKeys.current = {}
    setSelected(allowed.slice(0, 4).map(c => c.id))
  }, [allowed])

  const mode: PlaybackMode = selected.length <= 1 ? 'single' : 'grid'
  const cellCount = selected.length <= 1 ? 1 : selected.length <= 4 ? 4 : 9
  const slots = Array.from({ length: cellCount }, (_, i) => selected[i] ?? null)
  const { cells, usage } = planCells(user, slots, clock.t, mode)
  const activeIdx = cells.flatMap((c, i) => (c.kind === 'activa' ? [i] : []))

  // Una celda que pasa a activa o cambia de pista abre su sesión y carga; la que
  // deja de estar activa (hueco, cola, sin cámara) la cierra.
  const cellKeys = cells.map(c => (c.kind === 'activa' ? `${c.cameraId}:${c.track}` : c.kind))
  const cellsSignature = cellKeys.join('|')
  useEffect(() => {
    const now = performance.now()
    cellKeys.forEach((key, i) => {
      const prevKey = lastKeys.current[i]
      if (prevKey === key) return
      const c = cells[i]
      if (c.kind === 'activa') {
        // Misma cámara con otra pista: conserva el bloqueo simulado; otra cámara arranca limpia.
        const sameCamera = prevKey?.startsWith(`${c.cameraId}:`) ?? false
        dispatch({ type: 'open', index: i, nowMs: now, loadMs: simulatedLoadMs(i, c.track), sameCamera })
      } else dispatch({ type: 'close', index: i })
      lastKeys.current[i] = key
    })
    for (const k of Object.keys(lastKeys.current)) {
      if (Number(k) >= cellKeys.length) { dispatch({ type: 'close', index: Number(k) }); delete lastKeys.current[Number(k)] }
    }
    // cellsSignature resume `cells`: sólo se reevalúa cuando cambia alguna celda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsSignature])

  // Reloj común: avanza con el tiempo real × velocidad. Cada tick también termina
  // las cargas (la celda se alinea al reloj) y congela las celdas bloqueadas.
  const activeRef = useRef(activeIdx)
  activeRef.current = activeIdx
  useEffect(() => {
    let last = performance.now()
    const id = window.setInterval(() => {
      const t = performance.now()
      dispatch({ type: 'tick', dtMs: t - last, nowMs: t, active: activeRef.current })
      last = t
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  const loadingIdx = activeIdx.filter(i => !sync.cells[i]?.stalled && isCellLoading(sync.cells[i]))
  const stalledIdx = activeIdx.filter(i => sync.cells[i]?.stalled)
  const anyWaiting = loadingIdx.length + stalledIdx.length > 0

  const cellView = (i: number): CellView => {
    const sc = sync.cells[i]
    if (sc?.stalled) return 'bloqueada'
    if (isCellLoading(sc)) return 'cargando'
    if (!clock.playing) return 'pausa'
    return clock.strictSync && anyWaiting ? 'esperando' : 'reproduciendo'
  }

  const seek = (t: number) => {
    const target = Math.min(WINDOW.end, Math.max(WINDOW.start, t))
    // Un seek del reloj común reabre todas las celdas activas en el nuevo instante.
    const loads: Record<number, number> = {}
    planCells(user, slots, target, mode).cells.forEach((c, i) => { if (c.kind === 'activa') loads[i] = simulatedLoadMs(i, c.track) })
    dispatch({ type: 'seekAll', t: target, nowMs: performance.now(), loads })
  }

  const resync = (i: number) => {
    const c = cells[i]
    if (c?.kind === 'activa') dispatch({ type: 'resync', index: i, nowMs: performance.now(), loadMs: simulatedLoadMs(i, c.track) })
  }

  const toggleCamera = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= MAX_CELLS ? prev : [...prev, id])
  }

  const stallTarget = activeIdx.includes(stallCell) ? stallCell : activeIdx[0]
  const stallActive = stallTarget !== undefined && !!sync.cells[stallTarget]?.stalled
  const fit = gridFit(cellCount)
  const fitStyle = { '--grid-w': fit.width, '--grid-min-h': fit.minHeight } as CSSProperties

  return (
    <div className="flex h-full flex-col gap-3 p-3 lg:flex-row">
      <SidePanel testId="camera-picker" title="Cámaras" summary={`${selected.length}/${MAX_CELLS}`} open={pickerOpen} onOpenChange={setPickerOpen} ariaLabel="Selector de cámaras">
        <h2 className="mb-2 hidden text-sm font-semibold text-surface-50 lg:block">Cámaras ({selected.length}/{MAX_CELLS})</h2>
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
        <p className="mt-2 text-xs text-surface-400">Día simulado {SIM_DAY} (00:00–24:00).</p>
        <BackendMark status={PLAYBACK_BACKEND.search} testId="search-backend" className="mt-2" />
      </SidePanel>

      <section className="flex min-w-0 flex-1 flex-col gap-2">
        {/*
          Bloque que entra en la pantalla en PC y tablet horizontal (≥ lg): aviso,
          controles, grilla 16:9 en el alto que sobra y timeline. La grilla se ajusta
          al alto REAL (contenedor con container-type: size, ver gridFit). La
          simulación de bloqueo queda debajo. En tablet vertical todo se apila y la
          grilla usa el ancho completo.
        */}
        {/* shrink-0: con min-height explícito, sin esto el bloque se encogería al alto de la sección y su contenido taparía lo de abajo. */}
        <div className="flex shrink-0 flex-col gap-2 lg:min-h-full" data-testid="playback-fit">
          <p role="note" data-testid="playback-proof-note" className="rounded-lg bg-amber-950/60 px-3 py-1.5 text-xs text-amber-200 ring-1 ring-amber-800">
            Este prototipo <strong>no demuestra</strong> que desaparecieron las pausas entre grabaciones: no reproduce video.
            Eso requiere video reproducible en las pruebas y, después, mediciones autorizadas con NVR reales.
          </p>

          {/*
            Controles en dos renglones: transporte arriba; abajo "Esperar a todas", el
            estado de carga (lugar FIJO: que aparezca no cambia el alto ni, por lo
            tanto, el tamaño de la grilla ajustada) y la admisión por NVR.
          */}
          <div className="card flex flex-col gap-1 p-2" data-testid="playback-controls">
            <div className="flex flex-wrap items-center gap-2">
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
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="flex min-h-[44px] items-center gap-2 text-xs text-surface-200"
                title="Sincronía estricta. Apagada (por defecto): una celda que carga o se bloquea no detiene a las demás; se atrasa sola y muestra su desfase.">
                <input type="checkbox" data-testid="strict-sync" checked={clock.strictSync} onChange={e => dispatch({ type: 'strict', value: e.target.checked })} />
                Esperar a todas
              </label>
              <span className="flex flex-wrap items-center gap-2" data-testid="nvr-usage">
                {usage.map(u => (
                  <Badge key={u.nvrId} tone={u.queued > 0 ? 'warn' : 'neutral'} testId={`usage-${u.nvrId}`}>
                    {u.name}: {u.active}/{u.limit} sesiones{u.queued > 0 ? ` · ${u.queued} en cola` : ''}
                  </Badge>
                ))}
              </span>
              <span role="status" className="flex min-h-[44px] w-[19rem] max-w-full items-center">
                {anyWaiting && (
                  <Badge tone="warn" testId="buffering-indicator">
                    {[loadingIdx.length && `Cargando ${loadingIdx.length} celda(s)`, stalledIdx.length && `${stalledIdx.length} bloqueada(s)`].filter(Boolean).join(' · ')}
                    {clock.strictSync && clock.playing ? ' · el reloj espera' : ''}
                  </Badge>
                )}
              </span>
            </div>
            <BackendMark status={PLAYBACK_BACKEND.admission} testId="admission-backend" className="self-start" />
          </div>

          <div data-testid="playback-grid-box" style={fitStyle}
            className="lg:flex lg:min-h-[var(--grid-min-h)] lg:flex-1 lg:items-center lg:justify-center lg:[container-type:size]">
            <div className={clsx('grid w-full content-start gap-2 lg:w-[var(--grid-w)]', GRID_CLASS[cellCount])}
              data-testid="playback-grid" data-cells={cellCount} data-mode={mode}>
              {cells.map((c, i) => (
                <PlaybackCell key={i} index={i} cell={c} sync={sync.cells[i]} view={c.kind === 'activa' ? cellView(i) : 'pausa'} clockT={clock.t}
                  compact={cellCount >= 9}
                  onJump={t => seek(t)} onResync={() => resync(i)}
                  downloadable={c.kind === 'activa' && canDownload(user, cameraById(c.cameraId)!)} />
              ))}
            </div>
          </div>

          <Timeline cameraIds={selected} t={clock.t} onSeek={seek} />
        </div>

        <div className="card flex flex-wrap items-center gap-2 p-2" data-testid="sync-sim">
          <span className="text-xs text-surface-200">Simular bloqueo de una celda (el NVR deja de entregar datos):</span>
          <select aria-label="Celda a bloquear" data-testid="sim-stall-cell" className="input min-h-[44px] w-auto" value={stallTarget ?? ''}
            disabled={activeIdx.length === 0} onChange={e => setStallCell(Number(e.target.value))}>
            {activeIdx.map(i => {
              const c = cells[i] as Extract<CellState, { kind: 'activa' }>
              return <option key={i} value={i}>Celda {i + 1} · {cameraById(c.cameraId)?.name}</option>
            })}
          </select>
          <button type="button" data-testid="sim-stall-toggle" className="btn-secondary min-h-[44px]" disabled={stallTarget === undefined}
            onClick={() => stallTarget !== undefined && dispatch({ type: 'stall', index: stallTarget, value: !stallActive })}>
            {stallActive ? 'Liberar' : 'Bloquear'}
          </button>
          <BackendMark status={PLAYBACK_BACKEND.stallSim} testId="stall-backend" />
          <BackendMark status={PLAYBACK_BACKEND.sync} testId="sync-backend" />
        </div>
      </section>
    </div>
  )
}

function PlaybackCell(props: {
  index: number; cell: CellState; sync: CellSync | undefined; view: CellView; clockT: number
  /** Grilla 3×3: se omite el nombre del NVR para dejar alto al estado y a "Resincronizar". */
  compact: boolean
  onJump: (t: number) => void; onResync: () => void; downloadable: boolean
}) {
  const { cell, index: i } = props
  const testId = `pcell-${i}`
  if (cell.kind === 'vacia') return <CameraTile testId={testId} title="Celda vacía" tone="muted" />
  const cam = cameraById(cell.cameraId)!
  const title = cam.name
  const subtitle = props.compact ? undefined : nvrById(cam.nvrId)?.name
  if (cell.kind === 'sin-permiso') {
    return <CameraTile testId={testId} title="Cámara no permitida" tone="blocked" overlay={<span data-testid={`${testId}-state`} data-state="sin-permiso">Sin permiso de reproducción</span>} />
  }
  if (cell.kind === 'hueco') {
    return (
      <CameraTile testId={testId} title={title} subtitle={subtitle} tone="muted"
        badges={<Badge tone="neutral">Hueco</Badge>}
        overlay={
          <div className="flex flex-col items-center gap-2" data-testid={`${testId}-state`} data-state="hueco">
            <span>Sin grabación en {fmtClock(props.clockT)}</span>
            {cell.nextAt !== null ? (
              <button type="button" data-testid={`${testId}-jump`} className="btn-secondary min-h-[44px]" onClick={() => props.onJump(cell.nextAt!)}>
                Ir al próximo tramo ({fmtClock(cell.nextAt)})
              </button>
            ) : <span className="text-surface-400">No hay más grabación en el día</span>}
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
  const offset = cellOffset(props.sync, props.clockT)
  const outOfSync = isOutOfSync(props.sync, props.clockT)
  const pos = props.sync && props.view !== 'cargando' ? props.sync.pos : props.clockT
  const offsetValue = `${offset > 0 ? '−' : '+'}${Math.abs(offset).toFixed(1)} s`
  // [texto, detalle]: en celdas compactas el detalle queda sólo para lectores de
  // pantalla (.video-cell-detail) y el texto completo, en el title.
  const stateText: Record<CellView, [string, string?]> = {
    cargando: ['Cargando…'],
    bloqueada: [`Bloqueada en ${fmtClock(pos)}`, ': el NVR no entrega datos (simulado)'],
    esperando: [`${fmtClock(pos)} · esperando`, ' a las demás celdas'],
    reproduciendo: [fmtClock(pos)],
    pausa: [`${fmtClock(pos)} (pausa)`],
  }
  const [stateMain, stateDetail] = stateText[props.view]
  return (
    <CameraTile testId={testId} title={title} subtitle={subtitle} tone={props.view === 'bloqueada' ? 'warn' : 'ok'}
      badges={trackBadge} attention={outOfSync}
      overlay={
        // Estado, desfase y "Resincronizar" al centro: es lo que no puede quedar recortado.
        // En celdas compactas: desfase y botón en un renglón, sin detalles y sin pie (CameraTile).
        <div className="flex flex-col items-center gap-1">
          <span data-testid={`${testId}-state`} data-state={props.view} data-offset={offset.toFixed(2)} data-pos={pos.toFixed(3)}
            title={stateMain + (stateDetail ?? '')}
            className={clsx(props.view !== 'cargando' && 'font-mono text-surface-100')}>
            {stateMain}{stateDetail && <span className="video-cell-detail">{stateDetail}</span>}
          </span>
          {outOfSync && (
            <div className="flex flex-wrap items-center justify-center gap-1">
              <Badge tone="warn" testId={`${testId}-offset`}><span className="video-cell-detail">desfasada </span>{offsetValue}</Badge>
              {props.view !== 'bloqueada' && (
                <button type="button" data-testid={`${testId}-resync`} className="btn-secondary min-h-[44px] px-2 text-xs"
                  aria-label={`Resincronizar ${title} con el reloj común`} onClick={props.onResync}>
                  <RefreshCw className="h-3.5 w-3.5" /> Resincronizar
                </button>
              )}
            </div>
          )}
        </div>
      }
      footer={<div className="flex items-center justify-between gap-2 text-[11px] text-surface-300">
        <span className="min-w-0 truncate" title={REASON_TEXT[cell.reason]}>{REASON_TEXT[cell.reason]}</span>
        {props.downloadable && <span className="shrink-0" data-testid={`${testId}-download`}>Descarga permitida</span>}
      </div>} />
  )
}

function Timeline(props: { cameraIds: string[]; t: number; onSeek: (t: number) => void }) {
  const { t, onSeek } = props
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const level = ZOOM_LEVELS[zoom]
  const [viewStart, setViewStart] = useState(() => centeredRange(t, level.span).start)
  // El cabezal nunca queda fuera de la vista: si sale, el rango se recentra.
  const range = followPlayhead(viewStart, level.span, t)
  useEffect(() => { if (range.start !== viewStart) setViewStart(range.start) }, [range.start, viewStart])
  const changeZoom = (next: number) => {
    setZoom(next)
    setViewStart(centeredRange(t, ZOOM_LEVELS[next].span).start)
  }
  const span = range.end - range.start
  const pct = (x: number) => ((x - range.start) / span) * 100
  const ticks = timelineTicks(range, level)
  const tracksRef = useRef<HTMLDivElement>(null)
  const onTracksClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = tracksRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    onSeek(range.start + f * span)
  }
  const segStyle = (a: number, b: number) => {
    const s = Math.max(a, range.start)
    const e = Math.min(b, range.end)
    return { left: `${pct(s)}%`, width: `${((e - s) / span) * 100}%` }
  }
  const inRange = (a: number, b: number) => b > range.start && a < range.end
  const next = zoomIn(zoom)
  const prev = zoomOut(zoom)

  return (
    <div className="card p-2" data-testid="timeline" data-zoom={level.id} data-start={Math.round(range.start)} data-end={Math.round(range.end)}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Zoom de la línea de tiempo" className="flex items-center gap-1">
          <button type="button" data-testid="tl-zoom-out" className="btn-secondary min-h-[44px] min-w-[44px] justify-center px-2"
            aria-label={prev !== zoom ? `Alejar: ver ${ZOOM_LEVELS[prev].label}` : 'Alejar (ya se ve el día completo)'} disabled={prev === zoom} onClick={() => changeZoom(prev)}>
            <Minus className="h-4 w-4" />
          </button>
          <span className="min-w-[4.5rem] text-center text-sm text-surface-50" data-testid="tl-zoom-level" aria-live="polite">{level.label}</span>
          <button type="button" data-testid="tl-zoom-in" className="btn-secondary min-h-[44px] min-w-[44px] justify-center px-2"
            aria-label={next !== zoom ? `Acercar: ver ${ZOOM_LEVELS[next].label}` : 'Acercar (ya está en el máximo)'} disabled={next === zoom} onClick={() => changeZoom(next)}>
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <span className="font-mono text-xs text-surface-200" data-testid="tl-range">{fmtTime(range.start)}–{fmtTime(range.end)}</span>
        {/* Deslizador del día completo: control de teclado y arrastre (el timeline busca con clic/toque). */}
        <label className="flex min-w-[9rem] flex-1 items-center gap-2 text-[11px] text-surface-300">
          <span className="shrink-0">Día</span>
          <input
            type="range"
            aria-label="Posición del reloj común en el día (00:00–24:00)"
            data-testid="seek-range"
            className="min-h-[44px] w-full"
            min={WINDOW.start}
            max={WINDOW.end}
            step={1}
            value={Math.floor(t)}
            onChange={e => onSeek(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="flex gap-2">
        <div className="w-24 shrink-0 sm:w-28" aria-hidden>
          <div className="h-6" />
          {props.cameraIds.map(id => (
            <div key={id} className="flex h-7 items-center truncate text-[11px] text-surface-300">{cameraById(id)?.name}</div>
          ))}
        </div>
        {/* El margen lateral deja lugar a las horas de los extremos (centradas en su marca). */}
        <div className="min-w-0 flex-1 overflow-hidden px-5">
        <div ref={tracksRef} className="relative cursor-pointer select-none" data-testid="tl-tracks"
          onClick={onTracksClick} title="Tocá o hacé clic para ir a esa hora">
          <div className="relative h-6 border-b border-surface-600" data-testid="tl-ruler">
            {ticks.map(tk => (
              <div key={tk.t} className={clsx('absolute bottom-0 w-px', tk.major ? 'h-2.5 bg-surface-300' : 'h-1.5 bg-surface-500')} style={{ left: `${pct(tk.t)}%` }} />
            ))}
            {ticks.filter(tk => tk.major).map(tk => (
              <span key={`l${tk.t}`} data-testid="tl-tick-label" data-t={tk.t}
                className="absolute top-0 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] leading-3 text-surface-100"
                style={{ left: `${pct(tk.t)}%` }}>
                {tk.label}
              </span>
            ))}
          </div>
          {ticks.filter(tk => tk.major).map(tk => (
            <div key={`g${tk.t}`} aria-hidden className="pointer-events-none absolute bottom-0 top-6 w-px bg-surface-600/40" style={{ left: `${pct(tk.t)}%` }} />
          ))}
          {props.cameraIds.map(id => {
            const cam = cameraById(id)!
            const gapList = gapsInRange(cam, range)
            return (
              <div key={id} className="relative h-7 border-b border-surface-800 bg-surface-900" data-testid={`tl-${id}`} data-gaps={gapList.length}>
                {cam.archived.main.filter(s => inRange(s.start, s.end)).map((s, k) => (
                  <div key={`m${k}`} className="absolute top-0.5 h-3 bg-blue-500/80" style={segStyle(s.start, s.end)} />
                ))}
                {cam.archived.sub.filter(s => inRange(s.start, s.end)).map((s, k) => (
                  <div key={`s${k}`} className="absolute bottom-0.5 h-3 bg-teal-400/70" style={segStyle(s.start, s.end)} />
                ))}
                {gapList.map((g, k) => {
                  const label = gapLabel(g)
                  const wide = (g.visibleEnd - g.visibleStart) / span > 0.14
                  return (
                    <div key={`g${k}`} role="img" aria-label={label} title={label} data-testid={`gap-${id}-${k}`}
                      data-start={g.start} data-end={g.end}
                      className="tl-gap absolute inset-y-0 flex items-center overflow-hidden border-x border-red-400/70 px-1"
                      style={segStyle(g.visibleStart, g.visibleEnd)}>
                      {wide && <span className="truncate text-[10px] font-medium text-red-100">sin grabación {fmtTime(g.start)}–{fmtTime(g.end)}</span>}
                    </div>
                  )
                })}
              </div>
            )
          })}
          {/* Arranca debajo del renglón de horas (top-3) para no tapar la etiqueta HH:MM. */}
          <div aria-hidden data-testid="tl-playhead" className="pointer-events-none absolute bottom-0 top-3 z-10 w-0.5 -translate-x-1/2 bg-brand-400" style={{ left: `${pct(t)}%` }}>
            <div className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rotate-45 bg-brand-400" />
          </div>
        </div>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-surface-300" data-testid="tl-legend">
        <span><span className="mr-1 inline-block h-2 w-3 bg-blue-500/80" />principal archivada</span>
        <span><span className="mr-1 inline-block h-2 w-3 bg-teal-400/70" />subflujo archivado</span>
        <span><span className="tl-gap mr-1 inline-block h-2 w-3 ring-1 ring-red-400/70" />hueco (sin grabación)</span>
        <span><span className="mr-1 inline-block h-2 w-0.5 bg-brand-400" />cabezal (reloj común)</span>
      </div>
    </div>
  )
}
