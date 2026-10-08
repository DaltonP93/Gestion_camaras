// Selector lateral (visores, cámaras, secciones). En PC y tablet horizontal (≥ lg)
// queda visible a la izquierda; en tablet vertical se PLIEGA detrás de un botón para
// que el video use todo el ancho. Plegado por defecto; Escape lo cierra.
import { useEffect, useId, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'

export function SidePanel(props: {
  testId: string
  title: string
  /** Resumen en el botón plegado (p. ej. visor o sección actual). */
  summary?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  as?: 'aside' | 'nav'
  ariaLabel?: string
  children: ReactNode
}) {
  const contentId = useId()
  const { open, onOpenChange } = props
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])
  const Tag = props.as ?? 'aside'
  return (
    <Tag className="shrink-0 lg:w-60" data-testid={props.testId} data-open={open} aria-label={props.ariaLabel}>
      <button
        type="button"
        className="btn-secondary min-h-[44px] w-full justify-between lg:hidden"
        aria-expanded={open}
        aria-controls={contentId}
        data-testid={`${props.testId}-toggle`}
        onClick={() => onOpenChange(!open)}
      >
        <span className="min-w-0 truncate text-left">
          {props.title}
          {props.summary ? <span className="text-surface-300"> · {props.summary}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-surface-300">
          {open ? 'Ocultar' : 'Mostrar'}
          <ChevronDown aria-hidden className={clsx('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      <div
        id={contentId}
        data-testid={`${props.testId}-content`}
        className={clsx('card mt-2 p-3 lg:mt-0', open ? 'block' : 'hidden', 'lg:block')}
      >
        {props.children}
      </div>
    </Tag>
  )
}
