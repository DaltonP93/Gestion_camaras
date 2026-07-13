// SearchableCombobox — selector con buscador reutilizable.
//
// Reemplaza los <select> nativos en listas grandes y dinámicas (cámaras, NVRs,
// permisos…). Un <select> con 144 cámaras es inusable; este componente ofrece:
//   - búsqueda por texto, sin distinguir mayúsculas/minúsculas ni tildes
//   - búsqueda sobre label + sublabel + keywords (nombre, NVR, canal, ubicación)
//   - agrupación por `group`
//   - navegación con teclado (↑ ↓ Enter Escape) con aria-activedescendant
//   - botón limpiar, estados vacío / disabled / loading
//   - ventana con scroll y tope de render para acotar listas enormes
//
// Para enums cortos (severidad, dirección, tipo) seguir usando <select> nativo.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, ChevronDown, X, Check, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'

export interface ComboOption {
  value: string
  label: string
  group?: string        // p.ej. nombre del NVR
  sublabel?: string     // p.ej. "ch 24 · online"
  badge?: string        // p.ej. "● analítica activa"
  keywords?: string     // texto extra buscable (NVR, canal, ubicación)
  disabled?: boolean
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: ComboOption[]
  placeholder?: string      // texto cuando no hay selección
  searchPlaceholder?: string
  emptyLabel?: string       // etiqueta de la opción "sin selección" (value='')
  disabled?: boolean
  loading?: boolean
  className?: string
  maxRender?: number        // tope de opciones renderizadas (default 100)
}

// Normaliza para comparar: minúsculas y sin diacríticos (tildes).
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function optionText(o: ComboOption): string {
  return norm([o.label, o.sublabel, o.group, o.keywords].filter(Boolean).join(' '))
}

// Matcher puro (exportado para tests): ¿la opción coincide con la consulta?
// Insensible a mayúsculas/minúsculas y a tildes; busca en label+sublabel+group+keywords.
export function optionMatchesQuery(o: ComboOption, query: string): boolean {
  const q = norm(query.trim())
  return q === '' || optionText(o).includes(q)
}

export function SearchableCombobox({
  value, onChange, options,
  placeholder = 'Seleccionar…',
  searchPlaceholder = 'Buscar…',
  emptyLabel,
  disabled = false,
  loading = false,
  className,
  maxRender = 100,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = options.find(o => o.value === value)

  // Filtrado + tope de render. La opción "vacía" (emptyLabel) va siempre primera
  // y no se filtra por texto.
  const { visible, truncated } = useMemo(() => {
    const q = norm(query.trim())
    const base: ComboOption[] = emptyLabel !== undefined
      ? [{ value: '', label: emptyLabel }]
      : []
    const matched = q
      ? options.filter(o => optionText(o).includes(q))
      : options
    const all = [...base, ...matched]
    return { visible: all.slice(0, maxRender), truncated: Math.max(0, all.length - maxRender) }
  }, [query, options, emptyLabel, maxRender])

  // Agrupar respetando el orden de aparición de los grupos.
  const groups = useMemo(() => {
    const map = new Map<string, ComboOption[]>()
    for (const o of visible) {
      const g = o.group ?? ''
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(o)
    }
    return Array.from(map.entries())
  }, [visible])

  // Índice plano para navegación con teclado.
  const flat = visible

  useEffect(() => { setHighlight(0) }, [query, open])

  // Cerrar al hacer click fuera.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // Enfocar el buscador al abrir.
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  // Mantener visible el elemento resaltado.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  const commit = (o: ComboOption) => {
    if (o.disabled) return
    onChange(o.value)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); e.preventDefault(); return }
    if (e.key === 'Escape') { setOpen(false); e.preventDefault(); return }
    if (e.key === 'ArrowDown') { setHighlight(h => Math.min(h + 1, flat.length - 1)); e.preventDefault() }
    else if (e.key === 'ArrowUp') { setHighlight(h => Math.max(h - 1, 0)); e.preventDefault() }
    else if (e.key === 'Enter') {
      const o = flat[highlight]
      if (o) commit(o)
      e.preventDefault()
    }
  }

  let flatIdx = -1

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      {/* Botón/trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={clsx(
          'w-full flex items-center gap-2 text-sm bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-left',
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-surface-600',
        )}
      >
        <span className={clsx('flex-1 truncate', selected ? 'text-surface-200' : 'text-surface-500')}>
          {loading ? 'Cargando…' : selected ? selected.label : placeholder}
        </span>
        {loading
          ? <Loader2 size={14} className="animate-spin text-surface-500 flex-shrink-0" />
          : value && !disabled
            ? <X size={14} className="text-surface-500 hover:text-surface-300 flex-shrink-0"
                onClick={(e) => { e.stopPropagation(); onChange('') }} />
            : <ChevronDown size={14} className="text-surface-500 flex-shrink-0" />}
      </button>

      {/* Dropdown */}
      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full bg-surface-900 border border-surface-700 rounded-lg shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-surface-800">
            <Search size={13} className="text-surface-500 flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent text-sm text-surface-200 placeholder-surface-600 outline-none"
            />
            {query && (
              <X size={13} className="text-surface-500 hover:text-surface-300 cursor-pointer"
                onClick={() => setQuery('')} />
            )}
          </div>

          <ul ref={listRef} role="listbox" className="max-h-64 overflow-y-auto py-1"
            aria-activedescendant={flat[highlight] ? `combo-opt-${highlight}` : undefined}>
            {flat.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-surface-500">Sin resultados</li>
            )}
            {groups.map(([group, opts]) => (
              <li key={group || '_'}>
                {group && (
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-surface-500 font-medium">
                    {group}
                  </div>
                )}
                <ul>
                  {opts.map((o) => {
                    flatIdx++
                    const idx = flatIdx
                    const isSel = o.value === value
                    const isHi = idx === highlight
                    return (
                      <li
                        key={o.value || '_empty'}
                        id={`combo-opt-${idx}`}
                        data-idx={idx}
                        role="option"
                        aria-selected={isSel}
                        onMouseEnter={() => setHighlight(idx)}
                        onClick={() => commit(o)}
                        className={clsx(
                          'flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer',
                          o.disabled && 'opacity-40 cursor-not-allowed',
                          isHi ? 'bg-surface-700/70' : 'hover:bg-surface-800',
                        )}
                      >
                        <span className="flex-1 min-w-0">
                          <span className={clsx('truncate block', isSel ? 'text-brand-300' : 'text-surface-200')}>
                            {o.label}
                            {o.badge && <span className="ml-1 text-[10px] text-brand-400">{o.badge}</span>}
                          </span>
                          {o.sublabel && <span className="text-[11px] text-surface-500 truncate block">{o.sublabel}</span>}
                        </span>
                        {isSel && <Check size={13} className="text-brand-400 flex-shrink-0" />}
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
            {truncated > 0 && (
              <li className="px-3 py-2 text-center text-[11px] text-surface-500">
                +{truncated} más — refiná la búsqueda
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
