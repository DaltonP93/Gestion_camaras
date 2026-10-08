import { describe, it, expect } from 'vitest'
import { CAMERAS, USERS, WINDOW, cameraById, type ProtoUser } from '../data/mock'
import {
  canCreateViewer, canEditViewer, canPlayback, canPtz, canSeeCameraEvents, canSeeSettings, canViewLive,
  settingsAccess, SETTINGS_ACCESS, type SettingsSection,
} from './permissions'
import { ViewerRepo, ViewerError, memoryStorage, slotState, fitSlots, STORAGE_KEY, LAST_VIEWER_KEY } from './viewers'
import {
  chooseTrack, planCells, gaps, nextRecordedAt, clockReducer, initialClock, simulatedLoadMs, recordedUnion,
} from './playback'

const user = (role: string): ProtoUser => USERS.find(u => u.role === role)!
const ADMIN = user('ADMIN'), SUP = user('SUPERVISOR'), OP = user('OPERATOR'), AUD = user('AUDITOR')
const cam = (id: string) => cameraById(id)!
const H = 3600

describe('permisos (contrato RBAC actual)', () => {
  it('ADMIN y SUPERVISOR ven en vivo y reproducen todas las cámaras', () => {
    for (const u of [ADMIN, SUP]) for (const c of CAMERAS) {
      expect(canViewLive(u, c)).toBe(true)
      expect(canPlayback(u, c)).toBe(true)
    }
  })
  it('OPERATOR: sólo las cámaras con canView; nunca grabaciones', () => {
    expect(CAMERAS.filter(c => canViewLive(OP, c)).map(c => c.id)).toEqual(['cam-a1', 'cam-a2', 'cam-a3', 'cam-b1'])
    expect(CAMERAS.some(c => canPlayback(OP, c))).toBe(false)
  })
  it('AUDITOR: reproduce sólo con canPlayback por cámara y no ve vivo sin canView', () => {
    expect(CAMERAS.filter(c => canPlayback(AUD, c)).map(c => c.id)).toEqual(['cam-a1', 'cam-a2', 'cam-a5', 'cam-b1', 'cam-b2'])
    expect(canPlayback(AUD, cam('cam-a3'))).toBe(false)
  })
  it('PTZ requiere cámara PTZ y canPtz (o rol sin restricción)', () => {
    expect(canPtz(OP, cam('cam-a1'))).toBe(true)
    expect(canPtz(OP, cam('cam-a4'))).toBe(false)
    expect(canPtz(ADMIN, cam('cam-a2'))).toBe(false) // no es PTZ
  })
  it('visores: crear ADMIN/SUPERVISOR; SUPERVISOR edita sólo los propios', () => {
    expect([ADMIN, SUP, OP, AUD].map(canCreateViewer)).toEqual([true, true, false, false])
    const ajeno = { id: 'x', name: 'x', layout: '1x1' as const, cameraSlots: [null], isPublic: true, createdById: 'u-admin', accessUserIds: [], updatedAt: '' }
    expect(canEditViewer(SUP, ajeno)).toBe(false)
    expect(canEditViewer(ADMIN, { ...ajeno, createdById: 'u-sup' })).toBe(true)
  })
  it('configuración: ADMIN accede a todo; SUPERVISOR edita sólo visores, cámaras y detección; OPERATOR/AUDITOR sólo visores', () => {
    const sections = Object.keys(SETTINGS_ACCESS) as SettingsSection[]
    for (const s of sections) {
      expect(['edit', 'read']).toContain(settingsAccess(ADMIN, s))
      if (s !== 'visores') {
        expect(settingsAccess(OP, s)).toBe('none')
        expect(settingsAccess(AUD, s)).toBe('none')
      }
      if (!['visores', 'deteccion', 'zonas', 'camaras'].includes(s)) expect(settingsAccess(SUP, s)).not.toBe('edit')
    }
    expect(settingsAccess(SUP, 'auditoria')).toBe('none')
    expect([ADMIN, SUP, OP, AUD].map(canSeeSettings)).toEqual([true, true, true, true])
  })
  it('eventos: OPERATOR sin módulo; SUPERVISOR y AUDITOR sólo cámaras con canView explícito', () => {
    expect(CAMERAS.filter(c => canSeeCameraEvents(ADMIN, c)).length).toBe(CAMERAS.length)
    expect(CAMERAS.filter(c => canSeeCameraEvents(SUP, c)).map(c => c.id)).toEqual(['cam-a1', 'cam-a2', 'cam-a4', 'cam-b1'])
    expect(CAMERAS.filter(c => canSeeCameraEvents(AUD, c)).map(c => c.id)).toEqual(['cam-a1', 'cam-a2', 'cam-a5', 'cam-b1', 'cam-b2'])
    expect(CAMERAS.some(c => canSeeCameraEvents(OP, c))).toBe(false)
  })
})

describe('visores — repositorio y persistencia', () => {
  it('lista personales y compartidos según acceso', () => {
    const repo = new ViewerRepo(memoryStorage())
    expect(repo.list(SUP).personal.map(v => v.id)).toEqual(['v-sup-ronda'])
    expect(repo.list(SUP).shared.map(v => v.id)).toEqual(['v-entrada'])
    expect(repo.list(OP).shared.map(v => v.id).sort()).toEqual(['v-deposito', 'v-entrada'])
    expect(repo.list(OP).others).toEqual([])
    // ADMIN ve el visor personal de SUPERVISOR, pero NO como compartido.
    expect(repo.list(ADMIN).shared.map(v => v.id).sort()).toEqual(['v-deposito', 'v-entrada'])
    expect(repo.list(ADMIN).others.map(v => v.id)).toEqual(['v-sup-ronda'])
  })
  it('crear, editar y compartir persiste en el almacenamiento y sobrevive a una nueva instancia', () => {
    const storage = memoryStorage()
    const a = new ViewerRepo(storage, () => '2026-10-08T00:00:00Z')
    const v = a.create(SUP, { name: '  Mi visor ', layout: '2x2', cameraSlots: ['cam-a1'] })
    expect(v.name).toBe('Mi visor')
    expect(v.cameraSlots).toEqual(['cam-a1', null, null, null])
    a.update(SUP, v.id, { accessUserIds: ['u-op', 'u-op', 'u-sup'] })
    const b = new ViewerRepo(storage)
    expect(b.get(OP, v.id).accessUserIds).toEqual(['u-op'])
    expect(b.list(SUP).shared.map(x => x.id)).toContain(v.id) // al compartirlo deja de ser personal
  })
  it('OPERATOR no puede crear ni editar; AUDITOR no ve visores ajenos sin acceso', () => {
    const repo = new ViewerRepo(memoryStorage())
    expect(() => repo.create(OP, { name: 'x', layout: '1x1', cameraSlots: [] })).toThrow(ViewerError)
    expect(() => repo.update(OP, 'v-entrada', { name: 'y' })).toThrow(/creador o un administrador/)
    expect(() => repo.get(AUD, 'v-sup-ronda')).toThrow(/Sin acceso/)
  })
  it('última selección por usuario: se recuerda y se descarta si se pierde el acceso', () => {
    const storage = memoryStorage()
    const repo = new ViewerRepo(storage)
    repo.rememberSelection(OP, 'v-deposito')
    expect(new ViewerRepo(storage).lastSelected(OP)).toBe('v-deposito')
    repo.update(ADMIN, 'v-deposito', { accessUserIds: ['u-aud'] })
    expect(new ViewerRepo(storage).lastSelected(OP)).toBeNull()
    expect(storage.getItem(LAST_VIEWER_KEY('u-op'))).toBe('v-deposito')
  })
  it('almacenamiento corrupto ⇒ semilla, sin excepción', () => {
    const storage = memoryStorage()
    storage.setItem(STORAGE_KEY, '{no json')
    const count = (r: ViewerRepo) => { const l = r.list(ADMIN); return l.personal.length + l.shared.length + l.others.length }
    expect(count(new ViewerRepo(storage))).toBe(3)
    storage.setItem(STORAGE_KEY, JSON.stringify([{ id: 1 }]))
    expect(count(new ViewerRepo(storage))).toBe(3)
  })
  it('celdas de un visor compartido: las cámaras sin permiso quedan bloqueadas', () => {
    expect(slotState(OP, 'cam-a4')).toEqual({ kind: 'forbidden', cameraId: 'cam-a4' })
    expect(slotState(OP, 'cam-a1')).toEqual({ kind: 'ok', cameraId: 'cam-a1' })
    expect(slotState(ADMIN, 'cam-a6').kind).toBe('offline')
    expect(slotState(ADMIN, null).kind).toBe('empty')
    expect(fitSlots(['a', 'b', 'c', 'd', 'e'], '2x2')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('pistas archivadas — no se asume subflujo grabado', () => {
  it('grilla usa subflujo sólo si está archivado en ese instante; si no, principal', () => {
    expect(chooseTrack(cam('cam-a1'), 9 * H, 'grid')).toEqual({ track: 'sub', reason: 'subflujo-archivado' })
    expect(chooseTrack(cam('cam-a2'), 9 * H, 'grid')).toEqual({ track: 'main', reason: 'sin-subflujo' })
    // cam-a3: subflujo sólo hasta las 10:00
    expect(chooseTrack(cam('cam-a3'), 9.9 * H, 'grid').track).toBe('sub')
    expect(chooseTrack(cam('cam-a3'), 10.1 * H, 'grid')).toEqual({ track: 'main', reason: 'sin-subflujo' })
  })
  it('1×1 usa principal; sólo subflujo si la principal tiene hueco en ese instante', () => {
    expect(chooseTrack(cam('cam-a1'), 9 * H, 'single').track).toBe('main')
    expect(chooseTrack(cam('cam-a3'), 9.6 * H, 'single')).toEqual({ track: 'sub', reason: 'solo-subflujo' })
  })
  it('sin grabación en ninguna pista ⇒ hueco con próximo tramo', () => {
    expect(chooseTrack(cam('cam-a5'), 8.5 * H, 'grid')).toEqual({ track: null, reason: 'hueco' })
    expect(nextRecordedAt(cam('cam-a5'), 8.5 * H)).toBe(9 * H)
    expect(nextRecordedAt(cam('cam-a5'), 11.6 * H)).toBeNull()
  })
  it('huecos = complemento de la unión de pistas dentro de la ventana', () => {
    // cam-a3: el subflujo cubre el hueco de la principal 09:30–09:45 ⇒ sin hueco visible
    expect(gaps(cam('cam-a3'))).toEqual([])
    expect(gaps(cam('cam-a5'))).toEqual([
      { start: 8.25 * H, end: 9 * H }, { start: 9.5 * H, end: 11 * H }, { start: 11.5 * H, end: WINDOW.end },
    ])
    expect(recordedUnion(cam('cam-a1'))).toEqual([{ start: WINDOW.start, end: WINDOW.end }])
  })
})

describe('admisión por NVR (límite de sesiones)', () => {
  it('nunca supera el límite por NVR; el excedente queda en cola con posición', () => {
    const ids = ['cam-a1', 'cam-a2', 'cam-a3', 'cam-a4', 'cam-a6', 'cam-b1', 'cam-b2', 'cam-b3', null]
    const { cells, usage } = planCells(ADMIN, ids, 9 * H, 'grid')
    expect(cells.filter(c => c.kind === 'activa').length).toBe(6)
    const queued = cells.filter(c => c.kind === 'en-cola')
    expect(queued.map(c => (c as { cameraId: string }).cameraId)).toEqual(['cam-a6', 'cam-b3'])
    expect(queued.map(c => (c as { position: number }).position)).toEqual([1, 1])
    expect(usage).toEqual([
      { nvrId: 'nvr-a', name: 'NVR Recepción', active: 4, queued: 1, limit: 4 },
      { nvrId: 'nvr-b', name: 'NVR Depósito', active: 2, queued: 1, limit: 2 },
    ])
  })
  it('las celdas en hueco o sin permiso no consumen sesión', () => {
    const { cells, usage } = planCells(AUD, ['cam-a5', 'cam-a3', 'cam-a1'], 8.5 * H, 'grid')
    expect(cells.map(c => c.kind)).toEqual(['hueco', 'sin-permiso', 'activa'])
    expect(usage).toEqual([{ nvrId: 'nvr-a', name: 'NVR Recepción', active: 1, queued: 0, limit: 4 }])
  })
  it('OPERATOR no obtiene ninguna sesión de reproducción', () => {
    expect(planCells(OP, ['cam-a1', 'cam-a2'], 9 * H, 'grid').cells.every(c => c.kind === 'sin-permiso')).toBe(true)
  })
})

describe('reloj común', () => {
  it('avanza según velocidad, sólo reproduciendo', () => {
    let s = initialClock()
    s = clockReducer(s, { type: 'tick', dtMs: 1000, anyBuffering: false })
    expect(s.t).toBe(WINDOW.start)
    s = clockReducer(clockReducer(s, { type: 'play' }), { type: 'speed', speed: 4 })
    s = clockReducer(s, { type: 'tick', dtMs: 500, anyBuffering: false })
    expect(s.t).toBe(WINDOW.start + 2)
    s = clockReducer(s, { type: 'speed', speed: 3 })
    expect(s.speed).toBe(4)
  })
  it('sincronía estricta: no avanza mientras una celda carga; sin ella, sí', () => {
    let s = clockReducer(initialClock(), { type: 'play' })
    expect(clockReducer(s, { type: 'tick', dtMs: 1000, anyBuffering: true }).t).toBe(WINDOW.start)
    s = clockReducer(s, { type: 'strict', value: false })
    expect(clockReducer(s, { type: 'tick', dtMs: 1000, anyBuffering: true }).t).toBe(WINDOW.start + 1)
  })
  it('seek y saltos se limitan a la ventana; al final se pausa', () => {
    let s = clockReducer(initialClock(), { type: 'seek', t: 0 })
    expect(s.t).toBe(WINDOW.start)
    s = clockReducer(clockReducer(s, { type: 'seek', t: WINDOW.end - 1 }), { type: 'play' })
    s = clockReducer(s, { type: 'tick', dtMs: 5000, anyBuffering: false })
    expect(s).toMatchObject({ t: WINDOW.end, playing: false })
    expect(clockReducer(s, { type: 'play' }).playing).toBe(false)
    expect(clockReducer(s, { type: 'step', seconds: -10 }).t).toBe(WINDOW.end - 10)
  })
  it('la carga simulada es determinista y la principal tarda más', () => {
    expect(simulatedLoadMs(0, 'main')).toBeGreaterThan(simulatedLoadMs(0, 'sub'))
    expect(simulatedLoadMs(4, 'sub')).toBe(simulatedLoadMs(4, 'sub'))
  })
})
