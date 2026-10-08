// Editor de zonas y máscaras: lienzo portado de Frigate v0.18.0 (PolygonCanvas /
// PolygonDrawer, MIT, sin cambios) sobre React 18 + react-konva 18.2.16 + konva 10.
// La organización (selector de cámara, lista, guardar/deshacer) y el formato
// guardado (coordenadas 0–1 de CameraAnalyticsConfig.zones) son de VisionCore.
// Datos simulados: la imagen de fondo es sintética y guardar no sale del navegador.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { PolygonCanvas } from '../vendor/frigate/components/settings/PolygonCanvas'
import type { Polygon, PolygonType } from '../vendor/frigate/types/canvas'
import { CAMERAS, ZONES, type ZoneDef } from '../sim/mock'
import { canViewLive } from '../model/permissions'
import { useSession } from '../session'
import { legendColor, newPolygon, rescale, resetPolygon, toCanvasPolygons, toZoneDefs, undoLastPoint } from './editOps'

const ASPECT = 16 / 9

function useContainerSize(ref: React.RefObject<HTMLDivElement>) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const w = Math.floor(el.clientWidth)
      setSize(prev => (prev.w === w ? prev : { w, h: Math.round(w / ASPECT) }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export default function ZoneEditor({ readOnly }: { readOnly: boolean }) {
  const { user } = useSession()
  const cameras = useMemo(() => CAMERAS.filter(c => canViewLive(user, c)), [user])
  const [cameraId, setCameraId] = useState(cameras[0]?.id ?? '')
  const [saved, setSaved] = useState<Record<string, ZoneDef[]>>(() => structuredClone(ZONES))
  const containerRef = useRef<HTMLDivElement>(null)
  const { w, h } = useContainerSize(containerRef)
  const [polygons, setPolygons] = useState<Polygon[]>([])
  const [active, setActive] = useState<number | undefined>(undefined)
  const [hovered, setHovered] = useState<number | null>(null)
  const prevSize = useRef({ w: 0, h: 0 })
  const [notice, setNotice] = useState<string | null>(null)

  // Carga de la cámara elegida (o al tener el primer tamaño real).
  useEffect(() => {
    if (!w || !h) return
    setPolygons(toCanvasPolygons(cameraId, saved[cameraId] ?? [], w, h))
    setActive(undefined)
    prevSize.current = { w, h }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, w > 0])

  // Cambio de tamaño (PC ↔ tablet, rotación): reescalar en vez de recargar. El
  // tamaño anterior se captura ANTES de actualizar la referencia: el actualizador
  // de estado corre después y vería ya el tamaño nuevo (no reescalaría nada).
  useEffect(() => {
    const from = prevSize.current
    if (!w || !h || !from.w || (from.w === w && from.h === h)) return
    setPolygons(p => rescale(p, from, { w, h }))
    prevSize.current = { w, h }
  }, [w, h])

  const activePolygon = active !== undefined ? polygons[active] : undefined
  const dirty = useMemo(
    () => w > 0 && JSON.stringify(toZoneDefs(polygons, w, h)) !== JSON.stringify(saved[cameraId] ?? []) || (activePolygon !== undefined && !activePolygon.isFinished),
    [polygons, w, h, saved, cameraId, activePolygon],
  )

  const start = (type: PolygonType) => {
    setNotice(null)
    setPolygons(p => [...p, newPolygon(cameraId, type, p)])
    setActive(polygons.length)
  }
  const save = () => {
    const defs = toZoneDefs(polygons, w, h)
    setSaved(s => ({ ...s, [cameraId]: defs }))
    setActive(undefined)
    setPolygons(toCanvasPolygons(cameraId, defs, w, h))
    setNotice(`Guardado (sólo en esta pestaña): ${defs.length} polígono(s) en coordenadas 0–1.`)
  }
  const cancel = () => {
    setPolygons(toCanvasPolygons(cameraId, saved[cameraId] ?? [], w, h))
    setActive(undefined)
    setNotice(null)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="zone-editor">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="label" htmlFor="zone-camera">Cámara</label>
          <select id="zone-camera" data-testid="zone-camera" className="input min-h-[44px]" value={cameraId}
            disabled={dirty} onChange={e => setCameraId(e.target.value)}>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {!readOnly && (
          <>
            <button type="button" data-testid="new-zone" className="btn-secondary min-h-[44px]" disabled={activePolygon !== undefined} onClick={() => start('zone')}>Nueva zona</button>
            <button type="button" data-testid="new-motion-mask" className="btn-secondary min-h-[44px]" disabled={activePolygon !== undefined} onClick={() => start('motion_mask')}>Nueva máscara de movimiento</button>
          </>
        )}
      </div>

      <div ref={containerRef} className="relative w-full overflow-hidden rounded-lg border border-surface-600 bg-black" data-testid="canvas-container"
        style={{ height: h || undefined, pointerEvents: readOnly ? 'none' : undefined }}>
        {w > 0 && (
          <PolygonCanvas
            containerRef={containerRef}
            camera="sim"
            width={w}
            height={h}
            polygons={polygons}
            setPolygons={setPolygons}
            activePolygonIndex={readOnly ? undefined : active}
            hoveredPolygonIndex={hovered}
            selectedZoneMask={undefined}
            snapPoints={true}
          />
        )}
      </div>

      {!readOnly && activePolygon && (
        <div className="flex flex-wrap items-center gap-2" data-testid="polygon-controls">
          <span className="text-xs text-surface-300" data-testid="active-polygon-state">
            {activePolygon.name}: {activePolygon.points.length} punto(s){activePolygon.isFinished ? ' · cerrado' : ' · tocá el primer punto para cerrar'}
          </span>
          <button type="button" data-testid="undo-point" className="btn-secondary min-h-[44px]" onClick={() => setPolygons(p => undoLastPoint(p, active))}>Deshacer último punto</button>
          <button type="button" data-testid="reset-polygon" className="btn-secondary min-h-[44px]" onClick={() => setPolygons(p => resetPolygon(p, active))}>Reiniciar</button>
        </div>
      )}

      <ul className="flex flex-col gap-1" data-testid="zone-list">
        {polygons.map((p, i) => (
          <li key={`${p.type}-${p.name}-${i}`} data-testid={`zone-item-${i}`}
            className={clsx('flex min-h-[44px] items-center gap-2 rounded px-2 text-sm', i === active ? 'bg-brand-600/20' : 'bg-surface-900')}
            onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: legendColor(p.color) }} />
            <span className="flex-1 text-surface-100">{p.name}</span>
            <span className="text-xs text-surface-400">{p.type === 'zone' ? `zona · ${p.objects.join(', ')}` : 'máscara de movimiento'}</span>
            {!p.enabled && <span className="text-xs text-amber-300">desactivada</span>}
          </li>
        ))}
        {polygons.length === 0 && <li className="text-xs text-surface-400">Sin zonas ni máscaras para esta cámara.</li>}
      </ul>

      {!readOnly && (
        <div className={clsx('flex flex-wrap items-center gap-2 rounded-lg p-2', dirty && 'bg-amber-900/30')}>
          <span className="text-xs text-surface-200" data-testid="zones-dirty">{dirty ? 'Cambios sin guardar' : 'Sin cambios'}</span>
          <button type="button" data-testid="zones-save" className="btn-primary min-h-[44px]"
            disabled={!dirty || (activePolygon !== undefined && !activePolygon.isFinished)} onClick={save}>Guardar</button>
          <button type="button" data-testid="zones-cancel" className="btn-secondary min-h-[44px]" disabled={!dirty} onClick={cancel}>Deshacer cambios</button>
          {notice && <span className="text-xs text-green-300" data-testid="zones-notice">{notice}</span>}
        </div>
      )}
      <pre className="overflow-x-auto rounded bg-surface-900 p-2 text-[11px] text-surface-300" data-testid="zones-saved">{JSON.stringify(saved[cameraId] ?? [])}</pre>
    </div>
  )
}
