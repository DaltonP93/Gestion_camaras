// Visores del prototipo: selección, edición y persistencia.
//
// En la integración real los visores viven en PostgreSQL (CameraView /
// CameraViewAccess, /api/views) y la última selección es una preferencia del
// usuario. Aquí un repositorio en localStorage SIMULA esa API con las mismas reglas
// (model/permissions.ts), para revisar la experiencia sin servidor.
import { INITIAL_VIEWERS, cameraById, type Layout, type ProtoUser, type Viewer } from '../data/mock'
import { canCreateViewer, canEditViewer, canSeeViewer, canViewLive, isSharedViewer } from './permissions'

export const STORAGE_KEY = 'vc-proto:viewers:v1'
export const LAST_VIEWER_KEY = (userId: string) => `vc-proto:last-viewer:v1:${userId}`

export const LAYOUT_CELLS: Record<Layout, number> = { '1x1': 1, '2x2': 4, '3x3': 9, '4x4': 16 }

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class ViewerError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID', message: string) {
    super(message)
  }
}

function isViewer(v: unknown): v is Viewer {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.layout === 'string' &&
    o.layout in LAYOUT_CELLS && Array.isArray(o.cameraSlots) && typeof o.isPublic === 'boolean' &&
    typeof o.createdById === 'string' && Array.isArray(o.accessUserIds)
}

/** Ajusta las celdas al layout (rellena con null o recorta). */
export function fitSlots(slots: Array<string | null>, layout: Layout): Array<string | null> {
  const n = LAYOUT_CELLS[layout]
  return Array.from({ length: n }, (_, i) => slots[i] ?? null)
}

export type SlotState =
  | { kind: 'empty' }
  | { kind: 'ok'; cameraId: string }
  | { kind: 'forbidden'; cameraId: string }
  | { kind: 'offline'; cameraId: string }
  | { kind: 'missing'; cameraId: string }

/**
 * Estado de una celda para ESTE usuario. Un visor compartido puede contener
 * cámaras que el usuario no puede ver: la celda queda bloqueada y nunca se pide
 * stream (la API también lo rechazaría).
 */
export function slotState(user: ProtoUser, cameraId: string | null): SlotState {
  if (!cameraId) return { kind: 'empty' }
  const cam = cameraById(cameraId)
  if (!cam) return { kind: 'missing', cameraId }
  if (!canViewLive(user, cam)) return { kind: 'forbidden', cameraId }
  if (!cam.online) return { kind: 'offline', cameraId }
  return { kind: 'ok', cameraId }
}

export class ViewerRepo {
  constructor(private readonly storage: KeyValueStorage, private readonly now: () => string = () => new Date().toISOString()) {}

  /** Todos los visores almacenados (sin filtrar). Datos corruptos ⇒ semilla inicial. */
  private loadAll(): Viewer[] {
    let raw: string | null = null
    try { raw = this.storage.getItem(STORAGE_KEY) } catch { raw = null }
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.every(isViewer)) return parsed
      } catch { /* cae a la semilla */ }
    }
    return INITIAL_VIEWERS.map(v => ({ ...v, cameraSlots: [...v.cameraSlots], accessUserIds: [...v.accessUserIds] }))
  }

  private saveAll(viewers: Viewer[]): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(viewers))
  }

  /**
   * personal: propios sin compartir · shared: propios compartidos o compartidos con
   * el usuario (públicos o con acceso explícito) · others: personales de otros
   * usuarios que sólo ADMIN ve (GET /api/views no filtra para ADMIN).
   */
  list(user: ProtoUser): { personal: Viewer[]; shared: Viewer[]; others: Viewer[] } {
    const visible = this.loadAll().filter(v => canSeeViewer(user, v))
    const mine = (v: Viewer) => v.createdById === user.id
    const sharedWithUser = (v: Viewer) => v.isPublic || v.accessUserIds.includes(user.id)
    return {
      personal: visible.filter(v => mine(v) && !isSharedViewer(v)),
      shared: visible.filter(v => (mine(v) && isSharedViewer(v)) || (!mine(v) && sharedWithUser(v))),
      others: visible.filter(v => !mine(v) && !sharedWithUser(v)),
    }
  }

  get(user: ProtoUser, id: string): Viewer {
    const v = this.loadAll().find(x => x.id === id)
    if (!v) throw new ViewerError('NOT_FOUND', 'Visor no encontrado')
    if (!canSeeViewer(user, v)) throw new ViewerError('FORBIDDEN', 'Sin acceso a este visor')
    return v
  }

  create(user: ProtoUser, input: { name: string; layout: Layout; cameraSlots: Array<string | null> }): Viewer {
    if (!canCreateViewer(user)) throw new ViewerError('FORBIDDEN', 'Tu rol no puede crear visores')
    const name = input.name.trim()
    if (!name) throw new ViewerError('INVALID', 'El visor necesita un nombre')
    const all = this.loadAll()
    const viewer: Viewer = {
      id: `v-${all.length + 1}-${Math.abs(hash(name + this.now())).toString(36)}`,
      name,
      layout: input.layout,
      cameraSlots: fitSlots(input.cameraSlots, input.layout),
      isPublic: false,
      createdById: user.id,
      accessUserIds: [],
      updatedAt: this.now(),
    }
    this.saveAll([...all, viewer])
    return viewer
  }

  update(user: ProtoUser, id: string, patch: Partial<Pick<Viewer, 'name' | 'layout' | 'cameraSlots' | 'isPublic' | 'accessUserIds'>>): Viewer {
    const all = this.loadAll()
    const idx = all.findIndex(v => v.id === id)
    if (idx < 0) throw new ViewerError('NOT_FOUND', 'Visor no encontrado')
    const current = all[idx]
    if (!canEditViewer(user, current)) throw new ViewerError('FORBIDDEN', 'Sólo el creador o un administrador puede editar este visor')
    const layout = patch.layout ?? current.layout
    const name = patch.name !== undefined ? patch.name.trim() : current.name
    if (!name) throw new ViewerError('INVALID', 'El visor necesita un nombre')
    const next: Viewer = {
      ...current,
      ...patch,
      name,
      layout,
      cameraSlots: fitSlots(patch.cameraSlots ?? current.cameraSlots, layout),
      accessUserIds: [...new Set(patch.accessUserIds ?? current.accessUserIds)].filter(u => u !== current.createdById),
      updatedAt: this.now(),
    }
    all[idx] = next
    this.saveAll(all)
    return next
  }

  remove(user: ProtoUser, id: string): void {
    const all = this.loadAll()
    const v = all.find(x => x.id === id)
    if (!v) throw new ViewerError('NOT_FOUND', 'Visor no encontrado')
    if (!canEditViewer(user, v)) throw new ViewerError('FORBIDDEN', 'Sólo el creador o un administrador puede borrar este visor')
    this.saveAll(all.filter(x => x.id !== id))
    for (const key of [LAST_VIEWER_KEY(user.id)]) {
      if (this.storage.getItem(key) === id) this.storage.removeItem(key)
    }
  }

  /** Última selección del usuario; se ignora si ya no tiene acceso o no existe. */
  lastSelected(user: ProtoUser): string | null {
    let id: string | null = null
    try { id = this.storage.getItem(LAST_VIEWER_KEY(user.id)) } catch { id = null }
    if (!id) return null
    const v = this.loadAll().find(x => x.id === id)
    return v && canSeeViewer(user, v) ? id : null
  }

  rememberSelection(user: ProtoUser, id: string): void {
    try { this.storage.setItem(LAST_VIEWER_KEY(user.id), id) } catch { /* modo privado: sin persistencia */ }
  }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** Almacenamiento en memoria (pruebas y navegadores sin localStorage). */
export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>()
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v) },
    removeItem: k => { m.delete(k) },
  }
}

export function browserStorage(): KeyValueStorage {
  try {
    const probe = '__vc_proto_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return memoryStorage()
  }
}
