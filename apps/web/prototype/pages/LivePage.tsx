// Vivo configurable con visores personales y compartidos (datos simulados).
import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { Maximize2, Minimize2, Move, Pencil, Plus, Share2, Trash2 } from 'lucide-react'
import { CAMERAS, USERS, cameraById, type Layout, type Viewer } from '../data/mock'
import { canCreateViewer, canEditViewer, canPtz, canUseHighQuality, canViewLive, isSharedViewer } from '../model/permissions'
import { LAYOUT_CELLS, ViewerError, fitSlots, slotState } from '../model/viewers'
import { useSession } from '../session'
import { Badge, CameraTile, GRID_CLASS } from '../components/CameraTile'

const LAYOUTS: Layout[] = ['1x1', '2x2', '3x3', '4x4']

type Mode =
  | { kind: 'view' }
  | { kind: 'edit'; draft: { name: string; layout: Layout; cameraSlots: Array<string | null> }; isNew: boolean }
  | { kind: 'share'; isPublic: boolean; accessUserIds: string[] }

export function LivePage() {
  const { user, viewers } = useSession()
  const [lists, setLists] = useState(() => viewers.list(user))
  const refresh = () => setLists(viewers.list(user))
  const all = useMemo(() => [...lists.personal, ...lists.shared, ...lists.others], [lists])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [focusCell, setFocusCell] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ptzFor, setPtzFor] = useState<string | null>(null)

  // Restaura la última selección del usuario (o el primer visor visible).
  useEffect(() => {
    const fresh = viewers.list(user)
    const visible = [...fresh.personal, ...fresh.shared, ...fresh.others]
    setLists(fresh)
    const last = viewers.lastSelected(user)
    setSelectedId(last && visible.some(v => v.id === last) ? last : visible[0]?.id ?? null)
    setMode({ kind: 'view' })
    setFocusCell(null)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id])

  const selected: Viewer | undefined = all.find(v => v.id === selectedId)

  const select = (id: string) => {
    setSelectedId(id)
    viewers.rememberSelection(user, id)
    setMode({ kind: 'view' })
    setFocusCell(null)
    setError(null)
  }

  const run = (fn: () => void) => {
    try { fn(); setError(null); refresh() } catch (e) {
      setError(e instanceof ViewerError ? e.message : String(e))
    }
  }

  const editing = mode.kind === 'edit' ? mode : null
  const layout: Layout = editing ? editing.draft.layout : selected?.layout ?? '2x2'
  const slots = editing ? editing.draft.cameraSlots : fitSlots(selected?.cameraSlots ?? [], layout)
  const visibleCells = focusCell !== null ? [focusCell] : slots.map((_, i) => i)
  const cellCount = focusCell !== null ? 1 : LAYOUT_CELLS[layout]
  const selectableCameras = CAMERAS.filter(c => canViewLive(user, c))

  return (
    <div className="flex h-full flex-col gap-3 p-3 lg:flex-row">
      <aside className="card shrink-0 p-3 lg:w-60" data-testid="viewer-panel">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-surface-50">Visores</h2>
          {canCreateViewer(user) && (
            <button
              type="button"
              data-testid="new-viewer"
              className="btn-ghost min-h-[44px]"
              onClick={() => setMode({ kind: 'edit', isNew: true, draft: { name: '', layout: '2x2', cameraSlots: fitSlots([], '2x2') } })}
            >
              <Plus className="h-4 w-4" /> Nuevo
            </button>
          )}
        </div>
        <ViewerGroup title="Personales" testId="personal-viewers" items={lists.personal} selectedId={selectedId} onSelect={select} empty="Sin visores personales" />
        <ViewerGroup title="Compartidos" testId="shared-viewers" items={lists.shared} selectedId={selectedId} onSelect={select} empty="Sin visores compartidos" />
        {lists.others.length > 0 && (
          <ViewerGroup title="De otros usuarios (administración)" testId="other-viewers" items={lists.others} selectedId={selectedId} onSelect={select} empty="" />
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="live-toolbar">
          {editing ? (
            <input
              aria-label="Nombre del visor"
              data-testid="viewer-name"
              className="input min-h-[44px] w-56"
              placeholder="Nombre del visor"
              value={editing.draft.name}
              onChange={e => setMode({ ...editing, draft: { ...editing.draft, name: e.target.value } })}
            />
          ) : (
            <h1 className="text-base font-semibold text-surface-50" data-testid="viewer-title">{selected?.name ?? 'Sin visor'}</h1>
          )}
          {selected && !editing && (
            <Badge tone={isSharedViewer(selected) ? 'info' : 'neutral'} testId="viewer-kind">
              {isSharedViewer(selected) ? 'Compartido' : 'Personal'}
            </Badge>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {editing && (
              <div role="group" aria-label="Diseño" className="flex gap-1">
                {LAYOUTS.map(l => (
                  <button
                    key={l}
                    type="button"
                    data-testid={`layout-${l}`}
                    aria-pressed={editing.draft.layout === l}
                    className={clsx('btn-secondary min-h-[44px] px-3', editing.draft.layout === l && 'border-brand-500')}
                    onClick={() => setMode({ ...editing, draft: { ...editing.draft, layout: l, cameraSlots: fitSlots(editing.draft.cameraSlots, l) } })}
                  >
                    {l.replace('x', '×')}
                  </button>
                ))}
              </div>
            )}
            {!editing && focusCell !== null && (
              <button type="button" data-testid="back-to-grid" className="btn-secondary min-h-[44px]" onClick={() => setFocusCell(null)}>
                <Minimize2 className="h-4 w-4" /> Volver a la grilla
              </button>
            )}
            {!editing && selected && canEditViewer(user, selected) && (
              <>
                <button type="button" data-testid="edit-viewer" className="btn-secondary min-h-[44px]"
                  onClick={() => setMode({ kind: 'edit', isNew: false, draft: { name: selected.name, layout: selected.layout, cameraSlots: fitSlots(selected.cameraSlots, selected.layout) } })}>
                  <Pencil className="h-4 w-4" /> Editar
                </button>
                <button type="button" data-testid="share-viewer" className="btn-secondary min-h-[44px]"
                  onClick={() => setMode({ kind: 'share', isPublic: selected.isPublic, accessUserIds: [...selected.accessUserIds] })}>
                  <Share2 className="h-4 w-4" /> Compartir
                </button>
                <button type="button" data-testid="delete-viewer" className="btn-secondary min-h-[44px]"
                  onClick={() => run(() => {
                    viewers.remove(user, selected.id)
                    const rest = viewers.list(user)
                    setSelectedId([...rest.personal, ...rest.shared, ...rest.others][0]?.id ?? null)
                  })}>
                  <Trash2 className="h-4 w-4" /> Borrar
                </button>
              </>
            )}
            {editing && (
              <>
                <button type="button" data-testid="save-viewer" className="btn-primary min-h-[44px]"
                  onClick={() => run(() => {
                    const saved = editing.isNew
                      ? viewers.create(user, editing.draft)
                      : viewers.update(user, selected!.id, editing.draft)
                    setSelectedId(saved.id)
                    viewers.rememberSelection(user, saved.id)
                    setMode({ kind: 'view' })
                  })}>
                  Guardar
                </button>
                <button type="button" data-testid="cancel-edit" className="btn-secondary min-h-[44px]" onClick={() => { setMode({ kind: 'view' }); setError(null) }}>
                  Cancelar
                </button>
              </>
            )}
          </div>
        </div>

        {error && <p role="alert" data-testid="viewer-error" className="text-sm text-red-300">{error}</p>}

        {mode.kind === 'share' && selected && (
          <div className="card p-3" data-testid="share-dialog" role="dialog" aria-label="Compartir visor">
            <label className="flex min-h-[44px] items-center gap-2 text-sm text-surface-100">
              <input type="checkbox" data-testid="share-public" checked={mode.isPublic}
                onChange={e => setMode({ ...mode, isPublic: e.target.checked })} />
              Visible para todos los usuarios
            </label>
            <p className="label mt-2">Acceso explícito</p>
            <div className="flex flex-wrap gap-3">
              {USERS.filter(u => u.id !== selected.createdById).map(u => (
                <label key={u.id} className="flex min-h-[44px] items-center gap-2 text-sm text-surface-200">
                  <input type="checkbox" data-testid={`share-user-${u.id}`} checked={mode.accessUserIds.includes(u.id)}
                    onChange={e => setMode({ ...mode, accessUserIds: e.target.checked ? [...mode.accessUserIds, u.id] : mode.accessUserIds.filter(x => x !== u.id) })} />
                  {u.name}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-surface-400">
              Compartir no otorga permisos sobre cámaras: cada usuario sólo ve las celdas de cámaras que ya tiene permitidas.
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" data-testid="share-save" className="btn-primary min-h-[44px]"
                onClick={() => run(() => { viewers.update(user, selected.id, { isPublic: mode.isPublic, accessUserIds: mode.accessUserIds }); setMode({ kind: 'view' }) })}>
                Guardar acceso
              </button>
              <button type="button" className="btn-secondary min-h-[44px]" onClick={() => setMode({ kind: 'view' })}>Cancelar</button>
            </div>
          </div>
        )}

        {selected || editing ? (
          <div className={clsx('grid flex-1 auto-rows-fr gap-2', GRID_CLASS[cellCount])} data-testid="live-grid" data-cells={cellCount}>
            {visibleCells.map(i => {
              const camId = slots[i]
              if (editing) {
                return (
                  <div key={i} className="card flex min-h-[120px] flex-col justify-center gap-2 p-2" data-testid={`edit-cell-${i}`}>
                    <label className="label" htmlFor={`cell-${i}`}>Celda {i + 1}</label>
                    <select id={`cell-${i}`} data-testid={`cell-select-${i}`} className="input min-h-[44px]" value={camId ?? ''}
                      onChange={e => {
                        const next = [...editing.draft.cameraSlots]
                        next[i] = e.target.value || null
                        setMode({ ...editing, draft: { ...editing.draft, cameraSlots: next } })
                      }}>
                      <option value="">— vacía —</option>
                      {selectableCameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                )
              }
              const st = slotState(user, camId)
              const cam = camId ? cameraById(camId) : undefined
              const single = cellCount === 1
              const hd = single && cam ? canUseHighQuality(user, cam) : false
              if (st.kind === 'empty') return <CameraTile key={i} testId={`cell-${i}`} title="Celda vacía" tone="muted" />
              if (st.kind === 'forbidden') {
                return <CameraTile key={i} testId={`cell-${i}`} title="Cámara no permitida" tone="blocked"
                  overlay={<span data-testid={`cell-${i}-forbidden`}>Sin permiso para esta cámara. No se solicita video.</span>} />
              }
              if (st.kind === 'missing') return <CameraTile key={i} testId={`cell-${i}`} title="Cámara eliminada" tone="muted" />
              return (
                <CameraTile
                  key={i}
                  testId={`cell-${i}`}
                  title={cam!.name}
                  subtitle={`Canal ${cam!.channel}`}
                  tone={st.kind === 'offline' ? 'warn' : 'ok'}
                  onExpand={() => setFocusCell(focusCell === null ? i : null)}
                  badges={<>
                    {st.kind === 'offline' ? <Badge tone="danger">Sin conexión</Badge> : <Badge tone="ok">En vivo</Badge>}
                    <Badge tone={hd ? 'info' : 'neutral'} testId={`cell-${i}-quality`}>{hd ? 'HD' : 'SD'}</Badge>
                  </>}
                  overlay={st.kind === 'offline' ? 'La cámara no responde' : <span className="text-surface-400">video simulado</span>}
                  footer={
                    <div className="flex justify-end gap-1">
                      {cam && canPtz(user, cam) && (
                        <button type="button" data-testid={`cell-${i}-ptz`} className="btn-ghost min-h-[44px]" onClick={() => setPtzFor(ptzFor === cam.id ? null : cam.id)}>
                          <Move className="h-4 w-4" /> PTZ
                        </button>
                      )}
                      <button type="button" data-testid={`cell-${i}-expand`} aria-label={focusCell === null ? 'Ampliar' : 'Reducir'}
                        className="btn-ghost min-h-[44px] min-w-[44px] justify-center" onClick={() => setFocusCell(focusCell === null ? i : null)}>
                        {focusCell === null ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
                      </button>
                    </div>
                  }
                />
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-surface-300" data-testid="no-viewer">No tenés visores disponibles.</p>
        )}
        {ptzFor && (
          <div className="card p-3 text-sm text-surface-200" data-testid="ptz-pad">
            PTZ simulado de {cameraById(ptzFor)?.name}: los comandos no se envían a ningún equipo.
          </div>
        )}
        <p className="text-xs text-surface-400">
          Calidad automática: grilla en subflujo; al ampliar a 1×1 se pide alta calidad sólo si tenés permiso de alta calidad para esa cámara.
        </p>
      </section>
    </div>
  )
}

function ViewerGroup(props: { title: string; testId: string; items: Viewer[]; selectedId: string | null; onSelect: (id: string) => void; empty: string }) {
  return (
    <div className="mb-3" data-testid={props.testId}>
      <p className="label">{props.title}</p>
      {props.items.length === 0 ? (
        <p className="text-xs text-surface-400">{props.empty}</p>
      ) : (
        <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
          {props.items.map(v => (
            <li key={v.id}>
              <button
                type="button"
                data-testid={`viewer-${v.id}`}
                aria-current={props.selectedId === v.id}
                onClick={() => props.onSelect(v.id)}
                className={clsx('w-full rounded-lg px-3 text-left text-sm min-h-[44px]',
                  props.selectedId === v.id ? 'bg-brand-600/20 text-brand-200' : 'text-surface-200 hover:bg-surface-700')}
              >
                {v.name} <span className="text-xs text-surface-400">· {v.layout.replace('x', '×')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
