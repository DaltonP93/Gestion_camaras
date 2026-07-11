// apps/web/src/components/help/HelpCenter.tsx
// Centro de ayuda flotante: botón "?" fijo abajo a la derecha que abre un
// panel lateral con el manual completo del sistema. Busca en todo el
// contenido y abre automáticamente la sección de la página actual.
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { HelpCircle, X, Search, ChevronDown, ChevronRight, BookOpen } from 'lucide-react'
import { clsx } from 'clsx'
import { HELP_SECTIONS, type HelpSection } from './helpContent'

// Sección cuya ruta mejor coincide con la ubicación actual (prefijo más largo)
function sectionForPath(pathname: string): string {
  let best = 'inicio'
  let bestLen = 0
  for (const s of HELP_SECTIONS) {
    if (s.route !== '/' && pathname.startsWith(s.route) && s.route.length > bestLen) {
      best = s.id
      bestLen = s.route.length
    }
  }
  return best
}

export function HelpCenter() {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Al abrir, expandir la sección correspondiente a la página actual
  useEffect(() => {
    if (open) setExpanded(new Set([sectionForPath(location.pathname)]))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cerrar con Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // Filtrado por búsqueda: conserva las secciones/temas que matchean y los
  // expande todos para que el resultado sea visible de inmediato
  const q = query.trim().toLowerCase()
  const filtered: HelpSection[] = useMemo(() => {
    if (!q) return HELP_SECTIONS
    return HELP_SECTIONS
      .map(s => {
        const sectionMatches = s.title.toLowerCase().includes(q) || s.intro.toLowerCase().includes(q)
        const topics = s.topics.filter(t =>
          sectionMatches ||
          t.title.toLowerCase().includes(q) ||
          t.steps.some(step => step.toLowerCase().includes(q))
        )
        return topics.length > 0 || sectionMatches ? { ...s, topics: topics.length > 0 ? topics : s.topics } : null
      })
      .filter((s): s is HelpSection => s !== null)
  }, [q])

  const isExpanded = (id: string) => q.length > 0 || expanded.has(id)

  // Resalta el término buscado dentro de un texto
  const highlight = (text: string) => {
    if (!q) return text
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-brand-700/60 text-brand-100 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  return (
    <>
      {/* Botón flotante */}
      <button
        onClick={() => setOpen(true)}
        title="Manual del sistema (ayuda)"
        className={clsx(
          'fixed bottom-4 right-4 z-40 flex items-center justify-center w-11 h-11 rounded-full shadow-lg',
          'bg-brand-700 hover:bg-brand-600 text-white transition-all hover:scale-105',
          open && 'opacity-0 pointer-events-none'
        )}
      >
        <HelpCircle size={22} />
      </button>

      {/* Overlay + panel lateral */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-md h-full bg-surface-900 border-l border-surface-700 flex flex-col shadow-2xl">

            {/* Encabezado */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-700 flex-shrink-0">
              <BookOpen size={16} className="text-brand-400" />
              <h2 className="text-sm font-semibold text-surface-100">Manual del sistema</h2>
              <div className="flex-1" />
              <button onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Buscador */}
            <div className="px-4 py-2.5 border-b border-surface-700/60 flex-shrink-0">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-500 pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Buscar en el manual… (ej: zona, MP4, alerta, 453)"
                  autoFocus
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-surface-800 border border-surface-700 rounded-lg text-surface-200 placeholder-surface-600 focus:outline-none focus:border-brand-600"
                />
              </div>
            </div>

            {/* Contenido */}
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 && (
                <p className="text-xs text-surface-600 text-center py-10">
                  Sin resultados para "{query}"
                </p>
              )}
              {filtered.map(section => (
                <div key={section.id} className="border-b border-surface-800">
                  <button
                    onClick={() => toggle(section.id)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface-800/60 transition-colors"
                  >
                    <span className="text-base flex-shrink-0">{section.emoji}</span>
                    <span className="text-sm font-medium text-surface-200 flex-1">{highlight(section.title)}</span>
                    {isExpanded(section.id)
                      ? <ChevronDown size={14} className="text-surface-500 flex-shrink-0" />
                      : <ChevronRight size={14} className="text-surface-500 flex-shrink-0" />}
                  </button>

                  {isExpanded(section.id) && (
                    <div className="px-4 pb-3 space-y-3">
                      <p className="text-[11px] text-surface-400 leading-relaxed">{highlight(section.intro)}</p>
                      {section.topics.map((topic, ti) => (
                        <div key={ti} className="rounded-lg bg-surface-800/60 border border-surface-700/50 p-3">
                          <p className="text-xs font-semibold text-brand-300 mb-1.5">{highlight(topic.title)}</p>
                          <ul className="space-y-1.5">
                            {topic.steps.map((step, si) => (
                              <li key={si} className="text-[11px] text-surface-300 leading-relaxed flex gap-1.5">
                                <span className="text-surface-600 flex-shrink-0">•</span>
                                <span>{highlight(step)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Pie */}
            <div className="px-4 py-2 border-t border-surface-700 flex-shrink-0">
              <p className="text-[10px] text-surface-600">
                El manual se abre en la sección de la página actual. Presioná <kbd className="px-1 py-0.5 rounded bg-surface-800 border border-surface-700 font-mono">Esc</kbd> para cerrar.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
