// Sección "Zonas y máscaras": el editor (konva + react-konva) se carga de forma
// diferida para no sumar su peso al resto del prototipo (ni, en la integración
// real, a la vista en vivo).
import { lazy, Suspense } from 'react'

const ZoneEditor = lazy(() => import('../zones/ZoneEditor'))

export function ZoneEditorSection({ readOnly }: { readOnly: boolean }) {
  return (
    <Suspense fallback={<p className="text-sm text-surface-300" data-testid="zone-editor-loading">Cargando editor…</p>}>
      <ZoneEditor readOnly={readOnly} />
    </Suspense>
  )
}
