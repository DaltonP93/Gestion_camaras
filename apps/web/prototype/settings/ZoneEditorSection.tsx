// Marcador provisional: se reemplaza por el editor de polígonos (react-konva) tras
// la prueba de compatibilidad con React 18.
export function ZoneEditorSection({ readOnly }: { readOnly: boolean }) {
  return <p className="text-sm text-surface-300" data-testid="zone-editor-pending">Editor de zonas {readOnly ? '(sólo lectura)' : ''}</p>
}
