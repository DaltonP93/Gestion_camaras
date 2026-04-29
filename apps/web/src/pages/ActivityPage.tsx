// src/pages/ActivityPage.tsx
import { useEffect, useState } from 'react'
import { Activity, Download, Search, Filter } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { format } from 'date-fns'
import { clsx } from 'clsx'
import type { AuditLog } from '@/types'

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  LOGIN:              { label: 'Inicio sesión',       color: 'text-green-400' },
  LOGOUT:             { label: 'Cierre sesión',       color: 'text-surface-400' },
  AUTH_FAILED:        { label: 'Fallo autenticación', color: 'text-red-400' },
  VIEW_CAMERA:        { label: 'Vista en vivo',       color: 'text-blue-400' },
  VIEW_RECORDING:     { label: 'Vio grabación',       color: 'text-purple-400' },
  SEARCH_RECORDINGS:  { label: 'Buscó grabaciones',   color: 'text-indigo-400' },
  PTZ_COMMAND:        { label: 'Comando PTZ',         color: 'text-amber-400' },
  NVR_CREATED:        { label: 'NVR creado',          color: 'text-teal-400' },
  NVR_UPDATED:        { label: 'NVR actualizado',     color: 'text-teal-400' },
  NVR_DELETED:        { label: 'NVR eliminado',       color: 'text-red-400' },
  USER_CREATED:       { label: 'Usuario creado',      color: 'text-teal-400' },
  USER_UPDATED:       { label: 'Usuario actualizado', color: 'text-teal-400' },
  USER_DELETED:       { label: 'Usuario eliminado',   color: 'text-red-400' },
  PERMISSIONS_UPDATED:{ label: 'Permisos actualizados',color: 'text-amber-400' },
}

export function ActivityPage() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState('all')

  const loadLogs = async (p = 1) => {
    setIsLoading(true)
    try {
      const data = await apiGet<{ logs: AuditLog[]; total: number }>(
        `/users/audit/activity?page=${p}&limit=50`
      )
      setLogs(data.logs)
      setTotal(data.total)
      setPage(p)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { loadLogs() }, [])

  const filtered = logs.filter((l) => {
    const matchSearch =
      !search ||
      l.user?.username.toLowerCase().includes(search.toLowerCase()) ||
      l.action.toLowerCase().includes(search.toLowerCase()) ||
      l.ipAddress?.includes(search)
    const matchAction = actionFilter === 'all' || l.action === actionFilter
    return matchSearch && matchAction
  })

  const exportCSV = () => {
    const rows = [
      ['Fecha', 'Usuario', 'Acción', 'Recurso', 'IP'],
      ...filtered.map((l) => [
        format(new Date(l.createdAt), 'dd/MM/yyyy HH:mm:ss'),
        l.user?.username || '—',
        ACTION_LABELS[l.action]?.label || l.action,
        l.resource || '—',
        l.ipAddress || '—',
      ]),
    ]
    const csv = rows.map((r) => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `actividad_${format(new Date(), 'yyyyMMdd_HHmm')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const uniqueActions = Array.from(new Set(logs.map((l) => l.action)))

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Registro de actividad</h2>
          <p className="text-xs text-surface-400 mt-0.5">{total} eventos registrados</p>
        </div>
        <button onClick={exportCSV} className="btn-secondary text-xs">
          <Download size={13} /> Exportar CSV
        </button>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            className="input pl-9 text-xs"
            placeholder="Buscar usuario, acción, IP..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter size={12} className="text-surface-500" />
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="text-xs px-2 py-2 rounded-lg bg-surface-800 border border-surface-600 text-surface-300 focus:outline-none focus:border-brand-500"
          >
            <option value="all">Todas las acciones</option>
            {uniqueActions.map((a) => (
              <option key={a} value={a}>{ACTION_LABELS[a]?.label || a}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabla */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-600 bg-surface-700/30">
                <th className="text-left px-4 py-3 text-xs font-medium text-surface-400 whitespace-nowrap">Fecha y hora</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-surface-400">Usuario</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-surface-400">Acción</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-surface-400 hidden md:table-cell">Recurso</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-surface-400 hidden lg:table-cell">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700">
              {isLoading ? (
                <tr><td colSpan={5} className="text-center py-10 text-surface-500 text-sm">Cargando...</td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10">
                    <Activity size={24} className="text-surface-700 mx-auto mb-2" />
                    <p className="text-surface-500 text-sm">Sin actividad registrada</p>
                  </td>
                </tr>
              ) : filtered.map((log) => {
                const actionInfo = ACTION_LABELS[log.action]
                return (
                  <tr key={log.id} className="hover:bg-surface-700/20 transition-colors">
                    <td className="px-4 py-2.5 text-xs text-surface-400 whitespace-nowrap font-mono">
                      {format(new Date(log.createdAt), 'dd/MM/yy HH:mm:ss')}
                    </td>
                    <td className="px-4 py-2.5">
                      {log.user ? (
                        <div>
                          <div className="text-xs text-surface-200 font-medium">{log.user.username}</div>
                          <div className="text-xs text-surface-500">{log.user.role}</div>
                        </div>
                      ) : (
                        <span className="text-xs text-surface-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={clsx('text-xs font-medium', actionInfo?.color || 'text-surface-400')}>
                        {actionInfo?.label || log.action}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-surface-500 hidden md:table-cell font-mono">
                      {log.resource ? log.resource.slice(0, 16) + '...' : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-surface-500 hidden lg:table-cell font-mono">
                      {log.ipAddress || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {total > 50 && (
          <div className="px-4 py-3 border-t border-surface-600 flex items-center justify-between">
            <span className="text-xs text-surface-500">
              Página {page} de {Math.ceil(total / 50)}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => loadLogs(page - 1)}
                disabled={page === 1}
                className="btn-secondary text-xs py-1 px-3"
              >
                ← Anterior
              </button>
              <button
                onClick={() => loadLogs(page + 1)}
                disabled={page >= Math.ceil(total / 50)}
                className="btn-secondary text-xs py-1 px-3"
              >
                Siguiente →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
