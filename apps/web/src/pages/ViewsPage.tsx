// src/pages/ViewsPage.tsx
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Pencil, Trash2, Play, Lock, Globe, LayoutGrid,
  ChevronRight, Monitor, Clock, Users, X, Check, Search,
  ChevronLeft, ChevronDown, Eye
} from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { useCameraStore } from '@/stores/cameraStore'
import { useAuthStore } from '@/stores/authStore'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'
import type { CameraView, CameraSlot, ViewLayout, NVR, Camera, User } from '@/types'

// ─── Layout config ──────────────────────────────────────────────────────────
const LAYOUTS: { value: ViewLayout; label: string; slots: number; cols: number; rows: number }[] = [
  { value: '1x1',      label: '1×1',          slots: 1,  cols: 1, rows: 1 },
  { value: '2x2',      label: '2×2',          slots: 4,  cols: 2, rows: 2 },
  { value: '3x3',      label: '3×3',          slots: 9,  cols: 3, rows: 3 },
  { value: '4x4',      label: '4×4',          slots: 16, cols: 4, rows: 4 },
  { value: 'featured', label: 'Destacado',    slots: 8,  cols: 3, rows: 3 },
  { value: 'custom',   label: 'Personalizado', slots: 12, cols: 3, rows: 4 },
]

function makeSlots(layout: ViewLayout, existing?: CameraSlot[], customCount?: number): CameraSlot[] {
  const count = layout === 'custom'
    ? (customCount ?? existing?.length ?? 12)
    : (LAYOUTS.find((l) => l.value === layout)?.slots ?? 9)
  return Array.from({ length: count }, (_, i) => ({
    slotIndex: i,
    cameraId: existing?.find((s) => s.slotIndex === i)?.cameraId ?? null,
    size: layout === 'featured' && i === 0 ? 'large' as const : 'normal' as const,
  }))
}

// ─── Layout mini-preview ────────────────────────────────────────────────────
function LayoutPreview({ layout, size = 40 }: { layout: ViewLayout; size?: number }) {
  const conf = LAYOUTS.find((l) => l.value === layout) || LAYOUTS[2]
  const gap = 1
  const cellSize = (size - gap * (conf.cols - 1)) / conf.cols

  if (layout === 'featured') {
    const largeCellW = cellSize * 2 + gap
    const smallCellW = cellSize
    const smallCellH = (size - gap * (conf.rows - 1)) / conf.rows
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <rect x={0} y={0} width={largeCellW} height={largeCellW} rx={1} fill="currentColor" opacity={0.5} />
        {[0, 1, 2].map((r) => (
          <rect key={r}
            x={largeCellW + gap}
            y={r * (smallCellH + gap)}
            width={smallCellW}
            height={smallCellH}
            rx={1} fill="currentColor" opacity={0.3}
          />
        ))}
        {[0, 1, 2, 3].map((r) => (
          <rect key={r}
            x={r % 3 * (smallCellW + gap)}
            y={largeCellW + gap + Math.floor(r / 3) * (smallCellH + gap)}
            width={smallCellW}
            height={smallCellH}
            rx={1} fill="currentColor" opacity={0.3}
          />
        ))}
      </svg>
    )
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {Array.from({ length: conf.cols * conf.rows }, (_, i) => {
        const c = i % conf.cols
        const r = Math.floor(i / conf.cols)
        return (
          <rect
            key={i}
            x={c * (cellSize + gap)}
            y={r * (cellSize + gap)}
            width={cellSize}
            height={(size - gap * (conf.rows - 1)) / conf.rows}
            rx={1}
            fill="currentColor"
            opacity={0.4}
          />
        )
      })}
    </svg>
  )
}

// ─── Camera picker dropdown ──────────────────────────────────────────────────
function CameraPicker({
  value,
  nvrs,
  cameras,
  usedCameraIds,
  onChange,
}: {
  value: string | null
  nvrs: NVR[]
  cameras: Camera[]
  usedCameraIds?: Set<string>   // cameraIds already used in OTHER slots
  onChange: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [nvrFilter, setNvrFilter] = useState<string>('all')

  const filtered = cameras.filter((c) => {
    const matchNvr = nvrFilter === 'all' || c.nvrId === nvrFilter
    const q = search.toLowerCase()
    return matchNvr && (c.name.toLowerCase().includes(q) || (c.location || '').toLowerCase().includes(q))
  })

  const selected = cameras.find((c) => c.id === value)
  const isDuplicate = value ? (usedCameraIds?.has(value) ?? false) : false

  const handleSelect = (camId: string | null) => {
    if (camId && usedCameraIds?.has(camId)) {
      const cam = cameras.find((c) => c.id === camId)
      toast(`"${cam?.name ?? 'Esta cámara'}" ya está asignada a otro slot en esta vista.`, { icon: '⚠️' })
    }
    onChange(camId)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={clsx(
          'w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs transition-colors text-left',
          isDuplicate
            ? 'bg-amber-900/30 text-amber-300 border border-amber-700/50 hover:bg-amber-900/40'
            : value
              ? 'bg-brand-700/30 text-brand-300 hover:bg-brand-700/50'
              : 'bg-surface-700 text-surface-400 hover:bg-surface-600'
        )}
      >
        <Monitor size={10} className="flex-shrink-0" />
        <span className="flex-1 truncate">{selected ? selected.name : 'Sin asignar'}</span>
        {isDuplicate && (
          <span className="text-[9px] bg-amber-700/40 text-amber-300 px-1 rounded shrink-0">Dup.</span>
        )}
        <ChevronDown size={10} className="flex-shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-surface-800 border border-surface-600 rounded-lg shadow-xl min-w-52">
          <div className="p-2 border-b border-surface-700 space-y-1.5">
            <input
              autoFocus
              className="input text-xs py-1"
              placeholder="Buscar cámara..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="input text-xs py-1"
              value={nvrFilter}
              onChange={(e) => setNvrFilter(e.target.value)}
            >
              <option value="all">Todos los NVRs</option>
              {nvrs.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </div>
          <div className="max-h-48 overflow-y-auto">
            <button
              type="button"
              onClick={() => handleSelect(null)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-surface-400 hover:bg-surface-700 transition-colors"
            >
              <X size={10} /> Sin asignar
            </button>
            {filtered.map((cam) => {
              const alreadyUsed = usedCameraIds?.has(cam.id) ?? false
              return (
                <button
                  key={cam.id}
                  type="button"
                  onClick={() => handleSelect(cam.id)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors',
                    cam.id === value
                      ? 'bg-brand-600/20 text-brand-300'
                      : alreadyUsed
                        ? 'text-amber-400/80 hover:bg-amber-900/20'
                        : 'text-surface-300 hover:bg-surface-700'
                  )}
                >
                  <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0',
                    cam.online ? 'bg-green-400' : 'bg-surface-600')} />
                  <span className="flex-1 truncate">{cam.name}</span>
                  {alreadyUsed && (
                    <span className="text-[9px] text-amber-500 shrink-0">Ya asignada</span>
                  )}
                  <span className="text-surface-500 text-[10px]">{cam.nvr?.name ?? ''}</span>
                  {cam.id === value && <Check size={10} className="text-brand-400" />}
                </button>
              )
            })}
            {filtered.length === 0 && (
              <div className="py-4 text-center text-xs text-surface-500">Sin cámaras</div>
            )}
          </div>
        </div>
      )}
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
    </div>
  )
}

// ─── Grid editor ────────────────────────────────────────────────────────────
function GridEditor({
  layout,
  slots,
  nvrs,
  cameras,
  onSlotChange,
}: {
  layout: ViewLayout
  slots: CameraSlot[]
  nvrs: NVR[]
  cameras: Camera[]
  onSlotChange: (index: number, cameraId: string | null) => void
}) {
  const conf = LAYOUTS.find((l) => l.value === layout) || LAYOUTS[2]

  // For each slot index, build the set of cameraIds used in ALL OTHER slots
  const getUsedIds = (slotIndex: number): Set<string> =>
    new Set(slots.filter((s) => s.slotIndex !== slotIndex && s.cameraId).map((s) => s.cameraId!))

  if (layout === 'featured') {
    return (
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `2fr 1fr`, gridTemplateRows: `2fr 1fr 1fr` }}>
        {/* Large cell (slot 0) spans 1 col 2 rows */}
        <div className="row-span-2 bg-surface-700 rounded-lg p-2 flex flex-col gap-1">
          <div className="text-[10px] text-surface-400 font-medium">Slot 1 — Destacado</div>
          <div className="flex-1">
            <CameraPicker value={slots[0]?.cameraId ?? null} nvrs={nvrs} cameras={cameras}
              usedCameraIds={getUsedIds(0)}
              onChange={(id) => onSlotChange(0, id)} />
          </div>
        </div>
        {/* Right column: slots 1-2 */}
        {[1, 2].map((i) => (
          <div key={i} className="bg-surface-700 rounded-lg p-2 flex flex-col gap-1">
            <div className="text-[10px] text-surface-400 font-medium">Slot {i + 1}</div>
            <CameraPicker value={slots[i]?.cameraId ?? null} nvrs={nvrs} cameras={cameras}
              usedCameraIds={getUsedIds(i)}
              onChange={(id) => onSlotChange(i, id)} />
          </div>
        ))}
        {/* Bottom row: slots 3-7 */}
        {[3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="bg-surface-700 rounded-lg p-2 flex flex-col gap-1">
            <div className="text-[10px] text-surface-400 font-medium">Slot {i + 1}</div>
            <CameraPicker value={slots[i]?.cameraId ?? null} nvrs={nvrs} cameras={cameras}
              usedCameraIds={getUsedIds(i)}
              onChange={(id) => onSlotChange(i, id)} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${conf.cols}, 1fr)` }}
    >
      {slots.map((slot, i) => (
        <div key={i} className="bg-surface-700 rounded-lg p-2 flex flex-col gap-1 min-h-[64px]">
          <div className="text-[10px] text-surface-400 font-medium">Slot {i + 1}</div>
          <CameraPicker
            value={slot.cameraId}
            nvrs={nvrs}
            cameras={cameras}
            usedCameraIds={getUsedIds(slot.slotIndex)}
            onChange={(id) => onSlotChange(i, id)}
          />
        </div>
      ))}
    </div>
  )
}

// ─── View Builder Modal ──────────────────────────────────────────────────────
const STEP_ORDER = ['basic', 'cameras', 'access', 'summary'] as const
type WizardStep = typeof STEP_ORDER[number]

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin', SUPERVISOR: 'Supervisor', OPERATOR: 'Operador', AUDITOR: 'Auditor',
}

function ViewBuilderModal({
  initial,
  nvrs,
  cameras,
  users,
  onSave,
  onClose,
}: {
  initial?: CameraView
  nvrs: NVR[]
  cameras: Camera[]
  users: User[]
  onSave: (view: CameraView) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<WizardStep>('basic')
  const [name, setName] = useState(initial?.name ?? '')
  const [nameError, setNameError] = useState('')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [layout, setLayout] = useState<ViewLayout>(initial?.layout ?? '3x3')
  const [customSlotCount, setCustomSlotCount] = useState(() =>
    initial?.layout === 'custom' ? (initial.cameraSlots.length || 12) : 12
  )
  const [slots, setSlots] = useState<CameraSlot[]>(() =>
    makeSlots(initial?.layout ?? '3x3', initial?.cameraSlots, initial?.layout === 'custom' ? initial.cameraSlots.length : 12)
  )
  const [slideshowEnabled, setSlideshowEnabled] = useState(initial?.slideshowEnabled ?? false)
  const [slideshowInterval, setSlideshowInterval] = useState(initial?.slideshowInterval ?? 10)
  const [isPublic, setIsPublic] = useState(initial?.isPublic ?? false)
  const [accessUserIds, setAccessUserIds] = useState<string[]>(
    initial?.access?.map((a) => a.userId) ?? []
  )
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [isSaving, setIsSaving] = useState(false)

  const changeLayout = (l: ViewLayout) => {
    setLayout(l)
    setSlots(makeSlots(l, slots, customSlotCount))
  }

  const handleCustomSlotCount = (n: number) => {
    const count = Math.max(1, Math.min(25, n))
    setCustomSlotCount(count)
    setSlots(makeSlots('custom', slots, count))
  }

  const handleSlotChange = (index: number, cameraId: string | null) => {
    setSlots((prev) => prev.map((s) => s.slotIndex === index ? { ...s, cameraId } : s))
  }

  const toggleUser = (uid: string) => {
    setAccessUserIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    )
  }

  const handleNext = () => {
    if (step === 'basic') {
      if (!name.trim()) { setNameError('El nombre es obligatorio'); return }
      setNameError('')
    }
    const idx = STEP_ORDER.indexOf(step)
    if (idx < STEP_ORDER.length - 1) setStep(STEP_ORDER[idx + 1])
  }

  const handleBack = () => {
    const idx = STEP_ORDER.indexOf(step)
    if (idx > 0) setStep(STEP_ORDER[idx - 1])
  }

  const handleSave = async () => {
    if (!name.trim()) { toast.error('Ingresa un nombre para la vista'); return }
    setIsSaving(true)
    try {
      const payload = { name, description, layout, cameraSlots: slots, slideshowEnabled, slideshowInterval, isPublic, accessUserIds }
      const saved = initial
        ? await apiPut<CameraView>(`/views/${initial.id}`, payload)
        : await apiPost<CameraView>('/views', payload)
      toast.success(initial ? 'Vista actualizada' : 'Vista creada')
      onSave(saved)
    } catch {
      // error handled by api lib
    } finally {
      setIsSaving(false)
    }
  }

  const steps = [
    { key: 'basic',   label: 'Diseño' },
    { key: 'cameras', label: 'Cámaras' },
    { key: 'access',  label: 'Acceso' },
    { key: 'summary', label: 'Resumen' },
  ] as const

  const assignedSlots = slots.filter((s) => s.cameraId)
  const filteredUsers = users.filter((u) => roleFilter === 'all' || u.role === roleFilter)

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-black/70 backdrop-blur-sm">
      <div className="m-auto w-full max-w-3xl bg-surface-800 border border-surface-600 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-surface-700">
          <LayoutGrid size={16} className="text-brand-400" />
          <h2 className="text-sm font-semibold text-surface-100 flex-1">
            {initial ? `Editar vista: ${initial.name}` : 'Nueva vista de cámaras'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700">
            <X size={14} />
          </button>
        </div>

        {/* Steps */}
        <div className="flex items-center gap-0 px-5 py-3 border-b border-surface-700">
          {steps.map((s, i) => {
            const currentIdx = STEP_ORDER.indexOf(step)
            const done = i < currentIdx
            return (
              <button
                key={s.key}
                onClick={() => {
                  if (s.key !== 'basic' && !name.trim()) return
                  setStep(s.key)
                }}
                className={clsx(
                  'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors',
                  step === s.key
                    ? 'bg-brand-600 text-white font-medium'
                    : done
                      ? 'text-brand-400 hover:text-surface-200'
                      : 'text-surface-400 hover:text-surface-200'
                )}
              >
                <span className={clsx(
                  'w-4 h-4 rounded-full border text-[10px] flex items-center justify-center font-medium border-current',
                  done && step !== s.key && 'bg-brand-600/30'
                )}>
                  {done ? <Check size={8} /> : i + 1}
                </span>
                {s.label}
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* ── Step 1: Diseño ── */}
          {step === 'basic' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Nombre *</label>
                  <input
                    className={clsx('input', nameError && 'border-red-500 focus:ring-red-500/30')}
                    placeholder="Planta baja - Turno mañana"
                    value={name}
                    onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameError('') }}
                  />
                  {nameError && <p className="text-xs text-red-400 mt-1">{nameError}</p>}
                </div>
                <div>
                  <label className="label">Descripción</label>
                  <input className="input" placeholder="Descripción opcional"
                    value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
              </div>

              <div>
                <label className="label">Distribución de cámaras</label>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-1.5">
                  {LAYOUTS.map((l) => (
                    <button
                      key={l.value}
                      type="button"
                      onClick={() => changeLayout(l.value)}
                      className={clsx(
                        'flex flex-col items-center gap-2 p-3 rounded-lg border transition-all',
                        layout === l.value
                          ? 'border-brand-500 bg-brand-600/10 text-brand-300'
                          : 'border-surface-600 bg-surface-750 text-surface-400 hover:border-surface-500'
                      )}
                    >
                      <LayoutPreview layout={l.value} size={36} />
                      <span className="text-xs font-medium">{l.label}</span>
                      <span className="text-[10px] text-surface-500">
                        {l.value === 'custom' ? 'variable' : `${l.slots} cam.`}
                      </span>
                    </button>
                  ))}
                </div>
                {layout === 'custom' && (
                  <div className="flex items-center gap-3 mt-3 p-3 bg-surface-750 rounded-lg">
                    <label className="text-xs text-surface-300 whitespace-nowrap">Número de celdas</label>
                    <input
                      type="number"
                      min={1} max={25}
                      className="input w-20 text-center"
                      value={customSlotCount}
                      onChange={(e) => handleCustomSlotCount(Number(e.target.value))}
                    />
                    <span className="text-xs text-surface-500">máx. 25 cámaras</span>
                  </div>
                )}
              </div>

              <div className="bg-surface-750 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-surface-200">Presentación automática</div>
                    <div className="text-xs text-surface-500 mt-0.5">Avanza páginas automáticamente si hay más cámaras que celdas</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSlideshowEnabled(!slideshowEnabled)}
                    className={clsx(
                      'w-9 h-5 rounded-full transition-colors relative flex-shrink-0',
                      slideshowEnabled ? 'bg-brand-600' : 'bg-surface-600'
                    )}
                  >
                    <span className={clsx(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                      slideshowEnabled ? 'translate-x-4' : 'translate-x-0.5'
                    )} />
                  </button>
                </div>
                {slideshowEnabled && (
                  <div className="flex items-center gap-3">
                    <label className="label whitespace-nowrap mb-0">Intervalo (seg.)</label>
                    <input
                      type="number"
                      min={5} max={300}
                      className="input w-24 text-center"
                      value={slideshowInterval}
                      onChange={(e) => setSlideshowInterval(Number(e.target.value))}
                    />
                    <span className="text-xs text-surface-500">segundos por página</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 2: Cámaras ── */}
          {step === 'cameras' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-surface-200">Asigna cámaras a cada celda</p>
                  <p className="text-xs text-surface-500 mt-0.5">
                    <span className={clsx(assignedSlots.length > 0 ? 'text-brand-400' : 'text-surface-500')}>
                      {assignedSlots.length}
                    </span>
                    {' '}de {slots.length} celdas asignadas
                    {nvrs.length > 0 && (
                      <span className="ml-2 text-surface-600">· {nvrs.length} NVRs · {cameras.length} cámaras disponibles</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => setSlots(makeSlots(layout, undefined, customSlotCount))}
                >
                  <X size={11} /> Limpiar todo
                </button>
              </div>
              <GridEditor
                layout={layout}
                slots={slots}
                nvrs={nvrs}
                cameras={cameras}
                onSlotChange={handleSlotChange}
              />
            </div>
          )}

          {/* ── Step 3: Acceso ── */}
          {step === 'access' && (
            <div className="space-y-4">
              <div className="bg-surface-750 rounded-lg p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isPublic ? <Globe size={14} className="text-green-400" /> : <Lock size={14} className="text-amber-400" />}
                  <div>
                    <div className="text-xs font-medium text-surface-200">
                      {isPublic ? 'Vista pública' : 'Vista privada'}
                    </div>
                    <div className="text-xs text-surface-500 mt-0.5">
                      {isPublic
                        ? 'Todos los usuarios activos pueden ver esta vista'
                        : 'Solo los usuarios asignados pueden acceder'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsPublic(!isPublic)}
                  className={clsx(
                    'w-9 h-5 rounded-full transition-colors relative flex-shrink-0',
                    isPublic ? 'bg-green-600' : 'bg-surface-600'
                  )}
                >
                  <span className={clsx(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                    isPublic ? 'translate-x-4' : 'translate-x-0.5'
                  )} />
                </button>
              </div>

              {!isPublic && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="label mb-0 flex-1">Usuarios con acceso</label>
                    <select
                      className="input text-xs py-1 w-36"
                      value={roleFilter}
                      onChange={(e) => setRoleFilter(e.target.value)}
                    >
                      <option value="all">Todos los roles</option>
                      {(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR'] as const).map((r) => (
                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                    {accessUserIds.length > 0 && (
                      <span className="text-xs text-brand-400">{accessUserIds.length} seleccionados</span>
                    )}
                  </div>
                  <div className="space-y-1 mt-1.5 max-h-64 overflow-y-auto">
                    {filteredUsers.length === 0 && (
                      <div className="py-4 text-center text-xs text-surface-500">Sin usuarios para este filtro</div>
                    )}
                    {filteredUsers.map((u) => (
                      <label key={u.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-700 cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={accessUserIds.includes(u.id)}
                          onChange={() => toggleUser(u.id)}
                          className="accent-brand-500"
                        />
                        <div className="w-6 h-6 rounded-full bg-brand-700 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                          {u.fullName.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-surface-200">{u.fullName}</div>
                          <div className="text-xs text-surface-500">{u.username}</div>
                        </div>
                        <span className={clsx(
                          'text-[10px] px-1.5 py-0.5 rounded font-medium',
                          u.role === 'ADMIN'       ? 'bg-red-900/40 text-red-300' :
                          u.role === 'SUPERVISOR'  ? 'bg-amber-900/40 text-amber-300' :
                          u.role === 'OPERATOR'    ? 'bg-blue-900/40 text-blue-300' :
                                                     'bg-surface-600 text-surface-400'
                        )}>
                          {ROLE_LABELS[u.role] ?? u.role}
                        </span>
                        {accessUserIds.includes(u.id) && (
                          <Check size={12} className="text-brand-400 flex-shrink-0" />
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 4: Resumen ── */}
          {step === 'summary' && (() => {
            // Detect cameras assigned to more than one slot
            const cameraSlotMap = new Map<string, number[]>()
            slots.forEach((s) => {
              if (!s.cameraId) return
              const existing = cameraSlotMap.get(s.cameraId) ?? []
              cameraSlotMap.set(s.cameraId, [...existing, s.slotIndex])
            })
            const duplicateCameras = [...cameraSlotMap.entries()].filter(([, idxs]) => idxs.length > 1)

            return (
            <div className="space-y-4">
              <p className="text-xs text-surface-400">Revisa la configuración antes de {initial ? 'actualizar' : 'crear'} la vista.</p>

              {duplicateCameras.length > 0 && (
                <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-900/20 border border-amber-700/40">
                  <span className="text-amber-400 text-sm leading-none mt-0.5">⚠</span>
                  <div>
                    <p className="text-xs font-medium text-amber-300">Cámaras duplicadas</p>
                    <p className="text-[11px] text-amber-400/80 mt-0.5">
                      Las siguientes cámaras aparecen en más de un slot. Puedes guardar igualmente, pero cada slot transmitirá el mismo stream.
                    </p>
                    <ul className="mt-1.5 space-y-0.5">
                      {duplicateCameras.map(([camId, idxs]) => {
                        const cam = cameras.find((c) => c.id === camId)
                        return (
                          <li key={camId} className="text-[11px] text-amber-300">
                            <span className="font-medium">{cam?.name ?? camId}</span>
                            <span className="text-amber-500 ml-1">— slots {idxs.map((i) => i + 1).join(', ')}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </div>
              )}

              {/* Diseño */}
              <div className="bg-surface-750 rounded-lg p-4 space-y-2.5">
                <div className="text-xs font-semibold text-surface-300 mb-1">Diseño</div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-surface-400">Nombre</span>
                  <span className="text-xs font-medium text-surface-100">{name}</span>
                </div>
                {description && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-surface-400">Descripción</span>
                    <span className="text-xs text-surface-300">{description}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-surface-400">Layout</span>
                  <span className="text-xs text-surface-200 flex items-center gap-1.5">
                    <LayoutPreview layout={layout} size={14} />
                    {LAYOUTS.find((l) => l.value === layout)?.label}
                    {layout === 'custom' && <span className="text-surface-500">({customSlotCount} celdas)</span>}
                  </span>
                </div>
                {slideshowEnabled && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-surface-400">Presentación</span>
                    <span className="text-xs text-brand-300">cada {slideshowInterval}s</span>
                  </div>
                )}
              </div>

              {/* Cámaras */}
              <div className="bg-surface-750 rounded-lg p-4 space-y-2">
                <div className="text-xs font-semibold text-surface-300 mb-1">
                  Cámaras asignadas
                  <span className="ml-2 text-brand-400 font-normal">({assignedSlots.length}/{slots.length})</span>
                </div>
                {assignedSlots.length === 0 ? (
                  <p className="text-xs text-surface-500">Sin cámaras asignadas</p>
                ) : (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {assignedSlots.map((s) => {
                      const cam = cameras.find((c) => c.id === s.cameraId)
                      return (
                        <div key={s.slotIndex} className="flex items-center gap-2 text-xs">
                          <span className="text-surface-600 w-10 shrink-0">Slot {s.slotIndex + 1}</span>
                          {cam ? (
                            <>
                              <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', cam.online ? 'bg-green-400' : 'bg-surface-600')} />
                              <span className="text-surface-200 flex-1 truncate">{cam.name}</span>
                              <span className="text-surface-500 truncate max-w-24">{cam.nvr?.name}</span>
                            </>
                          ) : (
                            <span className="text-surface-500 italic">Cámara no encontrada</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Acceso */}
              <div className="bg-surface-750 rounded-lg p-4 space-y-2">
                <div className="text-xs font-semibold text-surface-300 mb-1">Acceso</div>
                <div className="flex items-center gap-2">
                  {isPublic
                    ? <><Globe size={12} className="text-green-400" /><span className="text-xs text-green-300">Pública — todos los usuarios</span></>
                    : <><Lock size={12} className="text-amber-400" /><span className="text-xs text-amber-300">Privada</span></>}
                </div>
                {!isPublic && accessUserIds.length > 0 && (
                  <div className="space-y-1 mt-1">
                    {accessUserIds.map((uid) => {
                      const u = users.find((u) => u.id === uid)
                      return u ? (
                        <div key={uid} className="flex items-center gap-2 text-xs text-surface-400">
                          <span className="text-surface-200">{u.fullName}</span>
                          <span className="text-surface-600">·</span>
                          <span className="text-surface-500">{ROLE_LABELS[u.role] ?? u.role}</span>
                        </div>
                      ) : null
                    })}
                  </div>
                )}
                {!isPublic && accessUserIds.length === 0 && (
                  <p className="text-xs text-amber-400/70">Sin usuarios asignados — solo el creador podrá ver esta vista</p>
                )}
              </div>
            </div>
          )
          })()}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-surface-700">
          <div className="flex gap-2">
            {step !== 'basic' && (
              <button type="button" className="btn-secondary" onClick={handleBack}>
                <ChevronLeft size={13} /> Anterior
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
            {step !== 'summary' ? (
              <button type="button" className="btn-primary" onClick={handleNext}>
                Siguiente <ChevronRight size={13} />
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={handleSave} disabled={isSaving}>
                {isSaving ? 'Guardando...' : initial ? 'Actualizar vista' : 'Crear vista'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── View card ───────────────────────────────────────────────────────────────
function ViewCard({
  view,
  onPlay,
  onEdit,
  onDelete,
  canManage,
}: {
  view: CameraView
  onPlay: () => void
  onEdit: () => void
  onDelete: () => void
  canManage: boolean
}) {
  const assignedCount = view.cameraSlots.filter((s) => s.cameraId).length
  const conf = LAYOUTS.find((l) => l.value === view.layout) || LAYOUTS[2]

  return (
    <div className="card p-4 flex flex-col gap-3 hover:border-surface-500 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center text-surface-400">
            <LayoutPreview layout={view.layout} size={24} />
          </div>
          <div>
            <div className="text-sm font-medium text-surface-100">{view.name}</div>
            {view.description && (
              <div className="text-xs text-surface-500 mt-0.5 truncate max-w-48">{view.description}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {view.isPublic
            ? <Globe size={11} className="text-green-400" />
            : <Lock size={11} className="text-amber-400" />}
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-surface-400">
        <span className="flex items-center gap-1">
          <Monitor size={10} /> {assignedCount}/{conf.slots} cámaras
        </span>
        <span className="flex items-center gap-1">
          <LayoutGrid size={10} /> {conf.label}
        </span>
        {view.slideshowEnabled && (
          <span className="flex items-center gap-1 text-brand-400">
            <Clock size={10} /> {view.slideshowInterval}s
          </span>
        )}
        {!view.isPublic && view.access && (
          <span className="flex items-center gap-1">
            <Users size={10} /> {view.access.length} usuarios
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 pt-1 border-t border-surface-700">
        <button
          onClick={onPlay}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-medium transition-colors"
        >
          <Play size={11} /> Abrir vista
        </button>
        {canManage && (
          <>
            <button
              onClick={onEdit}
              className="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-surface-600 transition-colors"
              title="Editar"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
              title="Eliminar"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────
export function ViewsPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()
  const canManage = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR'

  const [views, setViews] = useState<CameraView[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showBuilder, setShowBuilder] = useState(false)
  const [editingView, setEditingView] = useState<CameraView | undefined>()

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      const [v, u] = await Promise.all([
        apiGet<CameraView[]>('/views'),
        canManage ? apiGet<User[]>('/users') : Promise.resolve([]),
      ])
      setViews(v)
      setUsers(u)
    } finally {
      setIsLoading(false)
    }
  }, [canManage])

  useEffect(() => {
    loadData()
    loadNVRs()
    loadCameras()
  }, [])

  const handleDelete = async (view: CameraView) => {
    if (!confirm(`¿Eliminar la vista "${view.name}"?`)) return
    try {
      await apiDelete(`/views/${view.id}`)
      toast.success('Vista eliminada')
      setViews((prev) => prev.filter((v) => v.id !== view.id))
    } catch {}
  }

  const handleSaved = (saved: CameraView) => {
    setViews((prev) => {
      const idx = prev.findIndex((v) => v.id === saved.id)
      return idx >= 0 ? prev.map((v) => v.id === saved.id ? saved : v) : [saved, ...prev]
    })
    setShowBuilder(false)
    setEditingView(undefined)
  }

  const filtered = views.filter((v) =>
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    (v.description || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Visores de cámaras</h2>
          <p className="text-xs text-surface-400 mt-0.5">{views.length} vistas guardadas</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => { setEditingView(undefined); setShowBuilder(true) }}>
            <Plus size={14} /> Nueva vista
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative max-w-xs">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
        <input
          className="input pl-9"
          placeholder="Buscar vistas..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="text-center py-16 text-surface-500 text-sm">Cargando vistas...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <LayoutGrid size={32} className="text-surface-600 mx-auto" />
          <p className="text-surface-400 text-sm">
            {search ? 'Sin resultados para tu búsqueda' : 'No hay vistas guardadas aún'}
          </p>
          {canManage && !search && (
            <button className="btn-primary mx-auto" onClick={() => setShowBuilder(true)}>
              <Plus size={14} /> Crear primera vista
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((view) => (
            <ViewCard
              key={view.id}
              view={view}
              canManage={canManage}
              onPlay={() => navigate(`/views/${view.id}`)}
              onEdit={() => { setEditingView(view); setShowBuilder(true) }}
              onDelete={() => handleDelete(view)}
            />
          ))}
        </div>
      )}

      {/* Builder modal */}
      {showBuilder && (
        <ViewBuilderModal
          initial={editingView}
          nvrs={nvrs}
          cameras={cameras}
          users={users}
          onSave={handleSaved}
          onClose={() => { setShowBuilder(false); setEditingView(undefined) }}
        />
      )}
    </div>
  )
}
