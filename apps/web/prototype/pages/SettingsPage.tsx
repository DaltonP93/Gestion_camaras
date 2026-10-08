// Configuración organizada por secciones (patrón de ajustes de Frigate) con todas
// las funciones de VisionCore. Guardar sólo afecta a esta pestaña (datos simulados).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Navigate, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { CAMERAS, NVRS, USERS, CAMERA_PERMISSIONS, nvrById } from '../sim/mock'
import { settingsAccess, canEditViewer, isSharedViewer, type Access, type SettingsSection } from '../model/permissions'
import { ALL_SECTIONS, SETTINGS_GROUPS, type Field, type SectionDef } from '../settings/sections'
import { useSession, ROLE_LABEL } from '../session'
import { Badge } from '../components/CameraTile'
import { ZoneEditorSection } from '../settings/ZoneEditorSection'

type Values = Record<string, string | number | boolean>

export function SettingsPage() {
  const { section } = useParams<{ section: string }>()
  const { user } = useSession()
  const visible = ALL_SECTIONS.filter(s => settingsAccess(user, s.id) !== 'none')
  const current = visible.find(s => s.id === section)
  if (!current) return visible.length ? <Navigate to={`/configuracion/${visible[0].id}`} replace /> : null
  const access = settingsAccess(user, current.id)

  return (
    <div className="flex h-full flex-col gap-3 p-3 lg:flex-row">
      <nav className="card shrink-0 p-2 lg:w-60" aria-label="Secciones de configuración" data-testid="settings-nav">
        {SETTINGS_GROUPS.map(g => {
          const items = g.sections.filter(s => settingsAccess(user, s.id) !== 'none')
          if (!items.length) return null
          return (
            <div key={g.title} className="mb-2">
              <p className="label px-2 pt-1">{g.title}</p>
              <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
                {items.map(s => (
                  <li key={s.id}>
                    <NavLink to={`/configuracion/${s.id}`} data-testid={`settings-link-${s.id}`}
                      className={({ isActive }) => clsx('flex min-h-[44px] items-center rounded-lg px-3 text-sm',
                        isActive ? 'bg-brand-600/20 text-brand-200' : 'text-surface-200 hover:bg-surface-700')}>
                      {s.title}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>
      <section className="card min-w-0 flex-1 p-4" data-testid={`settings-section-${current.id}`} data-access={access}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold text-surface-50">{current.title}</h1>
          {access === 'read' && <Badge tone="warn" testId="read-only">Sólo lectura para {ROLE_LABEL[user.role]}</Badge>}
        </div>
        <p className="mb-4 text-xs text-surface-400" data-testid="section-source">Fuente: {current.source}</p>
        <SectionBody key={`${user.id}:${current.id}`} def={current} access={access} />
      </section>
    </div>
  )
}

function SectionBody({ def, access }: { def: SectionDef; access: Access }) {
  const custom = CUSTOM[def.id]
  return (
    <div className="flex flex-col gap-6">
      {def.fields && <SectionForm def={def} access={access} />}
      {custom && custom(access)}
    </div>
  )
}

/** Formulario con estado "sin guardar" + Guardar/Deshacer (patrón de Frigate). */
function SectionForm({ def, access }: { def: SectionDef; access: Access }) {
  const [saved, setSaved] = useState<Values>(def.initial ?? {})
  const [draft, setDraft] = useState<Values>(def.initial ?? {})
  const [notice, setNotice] = useState<string | null>(null)
  const dirty = useMemo(() => Object.keys(draft).some(k => draft[k] !== saved[k]), [draft, saved])
  const readOnly = access !== 'edit'
  useEffect(() => { if (dirty) setNotice(null) }, [dirty])

  return (
    <form className="flex flex-col gap-4" data-testid={`form-${def.id}`} onSubmit={e => { e.preventDefault(); if (!readOnly && dirty) { setSaved(draft); setNotice('Guardado (sólo en esta pestaña: datos simulados).') } }}>
      <div className="grid gap-4 md:grid-cols-2">
        {def.fields!.map(f => <FieldInput key={f.key} field={f} value={draft[f.key]} disabled={readOnly} onChange={v => setDraft(d => ({ ...d, [f.key]: v }))} />)}
      </div>
      {!readOnly && (
        <div className={clsx('flex flex-wrap items-center gap-2 rounded-lg p-2', dirty && 'bg-amber-900/30')} data-testid="save-bar">
          <span className="text-xs text-surface-200" data-testid="dirty-state">{dirty ? 'Cambios sin guardar' : 'Sin cambios'}</span>
          <button type="submit" data-testid="save" className="btn-primary min-h-[44px]" disabled={!dirty}>Guardar</button>
          <button type="button" data-testid="undo" className="btn-secondary min-h-[44px]" disabled={!dirty} onClick={() => setDraft(saved)}>Deshacer</button>
          {notice && <span className="text-xs text-green-300" data-testid="save-notice">{notice}</span>}
        </div>
      )}
    </form>
  )
}

function FieldInput({ field, value, disabled, onChange }: { field: Field; value: string | number | boolean | undefined; disabled: boolean; onChange: (v: string | number | boolean) => void }) {
  const id = `f-${field.key}`
  if (field.type === 'toggle') {
    return (
      <label className="flex min-h-[44px] items-center gap-3 text-sm text-surface-100" htmlFor={id}>
        <input id={id} type="checkbox" data-testid={id} checked={!!value} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        {field.label}
        {field.help && <span className="text-xs text-surface-400">{field.help}</span>}
      </label>
    )
  }
  return (
    <div>
      <label className="label" htmlFor={id}>{field.label}</label>
      {field.type === 'select' ? (
        <select id={id} data-testid={id} className="input min-h-[44px]" value={String(value ?? '')} disabled={disabled} onChange={e => onChange(e.target.value)}>
          {field.options!.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input id={id} data-testid={id} className="input min-h-[44px]" disabled={disabled}
          type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : field.type === 'email' ? 'email' : 'text'}
          min={field.min} max={field.max} step={field.type === 'number' && field.max !== undefined && field.max < 5 ? 0.1 : undefined}
          value={field.type === 'password' ? String(value ?? '') : String(value ?? '')}
          autoComplete={field.type === 'password' ? 'new-password' : 'off'}
          onChange={e => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)} />
      )}
      {field.help && <p className="mt-1 text-xs text-surface-400">{field.help}</p>}
    </div>
  )
}

// ─── Secciones con contenido propio ───────────────────────────────────────────

function Table({ testId, head, rows }: { testId: string; head: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead><tr>{head.map(h => <th key={h} className="border-b border-surface-600 px-2 py-2 text-xs font-medium text-surface-300">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b border-surface-700 px-2 py-2 text-surface-100">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function ActionButton({ access, need, testId, children }: { access: Access; need: Access; testId: string; children: ReactNode }) {
  const allowed = need === 'read' ? access !== 'none' : access === 'edit'
  if (!allowed) return null
  return <button type="button" data-testid={testId} className="btn-secondary min-h-[44px]">{children}</button>
}

function ViewersSection({ access }: { access: Access }) {
  const { user, viewers } = useSession()
  const lists = viewers.list(user)
  const rows = [...lists.personal, ...lists.shared, ...lists.others].map(v => [
    v.name,
    v.layout.replace('x', '×'),
    isSharedViewer(v) ? (v.isPublic ? 'Todos' : `${v.accessUserIds.length} usuario(s)`) : 'Personal',
    USERS.find(u => u.id === v.createdById)?.name ?? '—',
    canEditViewer(user, v) && access === 'edit' ? <Badge tone="info">Editable desde Vivo</Badge> : <Badge>Sólo consulta</Badge>,
  ])
  return <Table testId="viewers-table" head={['Visor', 'Diseño', 'Compartido con', 'Creador', '']} rows={rows} />
}

const CUSTOM: Partial<Record<SettingsSection, (access: Access) => ReactNode>> = {
  sistema: access => (
    <div className="flex flex-col gap-3">
      <Table testId="system-status" head={['Componente', 'Estado']} rows={[
        ['API', <Badge key="a" tone="ok">ok (simulado)</Badge>],
        ['PostgreSQL', <Badge key="b" tone="ok">ok (simulado)</Badge>],
        ['Redis', <Badge key="c" tone="ok">ok (simulado)</Badge>],
        ['MediaMTX', <Badge key="d" tone="ok">ok (simulado)</Badge>],
        ['Almacenamiento de eventos', '38 % de la cuota (simulado)'],
      ]} />
      <div className="flex flex-wrap gap-2">
        <ActionButton access={access} need="edit" testId="action-diagnostics">Diagnóstico de reproducción</ActionButton>
      </div>
    </div>
  ),
  nvr: access => (
    <div className="flex flex-col gap-3">
      <Table testId="nvr-table" head={['NVR', 'Modelo', 'Estado', 'Sesiones de reproducción']} rows={NVRS.map(n => [
        n.name, n.model, n.online ? <Badge key="o" tone="ok">En línea</Badge> : <Badge key="o" tone="danger">Sin conexión</Badge>, String(n.maxConcurrentPlaybackSessions),
      ])} />
      <div className="flex flex-wrap gap-2">
        <ActionButton access={access} need="edit" testId="action-add-nvr">Agregar NVR</ActionButton>
        <ActionButton access={access} need="read" testId="action-sync-nvr">Sincronizar canales</ActionButton>
        <ActionButton access={access} need="read" testId="action-validate-nvr">Validar salud</ActionButton>
      </div>
      <p className="text-xs text-surface-400">Credenciales del NVR: se guardan cifradas y nunca se muestran.</p>
    </div>
  ),
  camaras: () => (
    <Table testId="cameras-table" head={['Cámara', 'NVR', 'Canal', 'Códec principal / sub', 'Pistas archivadas']} rows={CAMERAS.map(c => [
      c.name, nvrById(c.nvrId)?.name, String(c.channel), `${c.mainCodec} / ${c.subCodec}`,
      c.archived.sub.length ? 'principal y subflujo' : <Badge key="t" tone="warn">sólo principal</Badge>,
    ])} />
  ),
  usuarios: access => (
    <div className="flex flex-col gap-3">
      <Table testId="users-table" head={['Usuario', 'Rol']} rows={USERS.map(u => [u.name, ROLE_LABEL[u.role]])} />
      <ActionButton access={access} need="edit" testId="action-add-user">Agregar usuario</ActionButton>
    </div>
  ),
  permisos: () => {
    const restricted = USERS.filter(u => u.role === 'OPERATOR' || u.role === 'AUDITOR')
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-surface-400">Administrador y Supervisor no están restringidos por cámara en vivo y grabaciones.</p>
        <Table testId="permissions-table" head={['Cámara', ...restricted.map(u => u.name)]} rows={CAMERAS.map(c => [
          c.name,
          ...restricted.map(u => {
            const p = (CAMERA_PERMISSIONS[u.id] ?? []).find(x => x.cameraId === c.id)
            if (!p) return '—'
            return [p.canViewLive && 'vivo', p.canPlayback && 'grabaciones', p.canPtz && 'PTZ', p.canDownload && 'descarga', p.canHighQuality && 'alta calidad'].filter(Boolean).join(', ') || 'ver'
          }),
        ])} />
      </div>
    )
  },
  auditoria: () => (
    <Table testId="audit-table" head={['Fecha', 'Usuario', 'Acción']} rows={[
      ['2026-10-07 08:02', 'Supervisión (sim.)', 'Inicio de sesión'],
      ['2026-10-07 08:15', 'Auditoría (sim.)', 'Reproducción Acceso principal 08:10–08:20'],
      ['2026-10-07 09:00', 'Administración (sim.)', 'Cambio de permisos de Operación (sim.)'],
    ]} />
  ),
  visores: access => <ViewersSection access={access} />,
  zonas: access => <ZoneEditorSection readOnly={access !== 'edit'} />,
}
