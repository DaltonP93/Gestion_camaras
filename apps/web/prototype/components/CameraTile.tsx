// Mosaico de cámara SIMULADO: no hay video. Muestra lo que la integración real debe
// comunicar en cada celda (estado, calidad, pista, huecos, carga, cola, permisos).
//
// Proporción: la celda ES el cuadro de video, siempre 16:9 (aspect-ratio), en vivo y
// en grabaciones, en PC y tablet. Los textos y botones van SUPERPUESTOS al cuadro
// (no le quitan alto), así que el video nunca se estira ni se recorta para hacer
// lugar. En la integración real el <video> va con object-fit: contain dentro de este
// cuadro: una fuente que no sea 16:9 se ve con bandas (letterbox), sin deformarse.
//
// Celdas compactas (< 300 px de ancho: grilla 3×3 en PC, 2×2 y 3×3 en tablet
// horizontal, 3×3 en tablet vertical): el centro tiene ~60 px de alto entre
// encabezado y pie. Para que el estado, el desfase y "Resincronizar" (44 px táctil)
// no se superpongan con el encabezado ni con el pie (prototype.css):
//   - se oculta el subtítulo; los detalles (.video-cell-detail) quedan sólo para
//     lectores de pantalla;
//   - mientras la celda pide atención (`attention`: p. ej. desfasada) se oculta el pie.
import type { ReactNode } from 'react'
import { clsx } from 'clsx'

export type TileTone = 'ok' | 'muted' | 'warn' | 'blocked'

const TONE: Record<TileTone, string> = {
  ok: 'from-slate-700 via-slate-800 to-slate-900',
  muted: 'from-surface-800 to-surface-900',
  warn: 'from-amber-950 to-surface-900',
  blocked: 'from-surface-900 to-black',
}

export function CameraTile(props: {
  testId: string
  title: string
  subtitle?: string
  tone: TileTone
  badges?: ReactNode
  overlay?: ReactNode
  footer?: ReactNode
  /** La celda muestra algo que requiere acción (p. ej. desfase): en celdas compactas se oculta el pie. */
  attention?: boolean
  onExpand?: () => void
  selected?: boolean
}) {
  return (
    <div
      data-testid={props.testId}
      data-video-cell="16:9"
      data-attention={props.attention || undefined}
      className={clsx(
        'video-cell relative aspect-video w-full self-start overflow-hidden rounded-lg border bg-black',
        props.selected ? 'border-brand-500' : 'border-surface-600',
      )}
      onDoubleClick={props.onExpand}
    >
      {/* Cuadro de video simulado (en la integración: <video object-fit: contain>). */}
      <div aria-hidden data-testid={`${props.testId}-frame`} className={clsx('absolute inset-0 bg-gradient-to-br', TONE[props.tone])} />
      <div className="absolute inset-0 flex flex-col">
        <div data-testid={`${props.testId}-header`} className="flex items-start justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-1.5">
          <div className="min-w-0">
            <p data-testid={`${props.testId}-title`} className="truncate text-xs font-medium text-surface-50">{props.title}</p>
            {/* En celdas angostas (< 300 px) se oculta para dejar alto al estado (prototype.css). */}
            {props.subtitle && <p className="video-cell-subtitle truncate text-[11px] text-surface-300">{props.subtitle}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">{props.badges}</div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center px-2 text-center text-xs text-surface-200">
          {props.overlay}
        </div>
        {props.footer && <div data-testid={`${props.testId}-footer`} className="video-cell-footer bg-gradient-to-t from-black/70 to-transparent p-1.5">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Badge({ children, tone = 'neutral', testId }: { children: ReactNode; tone?: 'neutral' | 'info' | 'warn' | 'danger' | 'ok'; testId?: string }) {
  const cls = {
    neutral: 'bg-surface-700 text-surface-100',
    info: 'bg-blue-900/70 text-blue-200',
    warn: 'bg-amber-900/70 text-amber-200',
    danger: 'bg-red-900/70 text-red-200',
    ok: 'bg-green-900/70 text-green-200',
  }[tone]
  return <span data-testid={testId} className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', cls)}>{children}</span>
}

/**
 * Columnas por cantidad de celdas. Las filas se ajustan al contenido (celdas 16:9):
 * la grilla NO estira las filas para llenar el alto.
 */
export const GRID_CLASS: Record<number, string> = {
  1: 'grid-cols-1',
  4: 'grid-cols-2',
  9: 'grid-cols-3',
  16: 'grid-cols-2 md:grid-cols-4',
}
