// Operaciones de edición del polígono activo. La lógica de `undoLastPoint` y
// `resetPolygon` está adaptada de Frigate v0.18.0 (77a66e7),
// web/src/components/settings/PolygonEditControls.tsx (`undo`, `reset`), MIT —
// aviso completo en prototype/vendor/frigate/LICENSE. Se reimplementa aquí como
// funciones puras para no portar sus dependencias de UI (shadcn, react-icons, i18n).
// La conversión a coordenadas normalizadas es propia de VisionCore.
import type { Polygon, PolygonType } from '../vendor/frigate/types/canvas'
import { interpolatePoints } from '../vendor/frigate/utils/canvasUtil'
import type { ZoneDef } from '../sim/mock'

// Frigate guarda los colores en BGR (como OpenCV): `toRGBColorString` invierte el
// orden al dibujar. Estos valores son BGR.
export const COLORS: Record<PolygonType, number[]> = {
  zone: [29, 29, 229],
  motion_mask: [160, 160, 160],
  object_mask: [40, 120, 200],
}

/** Color CSS de la leyenda a partir del BGR de Frigate. */
export function legendColor(bgr: number[]): string {
  return `rgb(${bgr[2]},${bgr[1]},${bgr[0]})`
}

/** Quita el último punto agregado (el de mayor `pointsOrder`). */
export function undoLastPoint(polygons: Polygon[], index: number | undefined): Polygon[] {
  if (index === undefined || !polygons[index]) return polygons
  const p = polygons[index]
  if (p.points.length === 0 || !p.pointsOrder || p.pointsOrder.length === 0) return polygons
  const last = p.pointsOrder.indexOf(Math.max(...p.pointsOrder))
  const next = [...polygons]
  next[index] = {
    ...p,
    points: [...p.points.slice(0, last), ...p.points.slice(last + 1)],
    pointsOrder: [...p.pointsOrder.slice(0, last), ...p.pointsOrder.slice(last + 1)],
    isFinished: p.isFinished && p.points.length > 3,
  }
  return next
}

/** Vacía el polígono activo para volver a dibujarlo. */
export function resetPolygon(polygons: Polygon[], index: number | undefined): Polygon[] {
  if (index === undefined || !polygons[index]) return polygons
  const next = [...polygons]
  next[index] = { ...polygons[index], points: [], pointsOrder: [], isFinished: false }
  return next
}

/** Zonas guardadas (0–1) → polígonos del lienzo en píxeles. */
export function toCanvasPolygons(cameraId: string, zones: ZoneDef[], width: number, height: number): Polygon[] {
  return zones.map((z, i) => ({
    typeIndex: i,
    camera: cameraId,
    name: z.name,
    type: z.type,
    objects: z.objects,
    points: interpolatePoints(z.points, 1, 1, width, height),
    pointsOrder: z.points.map((_, k) => k + 1),
    distances: [],
    isFinished: true,
    color: COLORS[z.type],
    enabled: z.enabled,
  }))
}

/** Polígonos del lienzo → formato persistido (0–1, 3 decimales). Descarta los no cerrados. */
export function toZoneDefs(polygons: Polygon[], width: number, height: number): ZoneDef[] {
  return polygons
    .filter(p => p.isFinished && p.points.length >= 3)
    .map(p => ({
      name: p.name,
      type: p.type === 'motion_mask' ? 'motion_mask' : 'zone',
      points: interpolatePoints(p.points, width, height, 1, 1).map(([x, y]) => [x, y] as [number, number]),
      objects: p.objects,
      enabled: p.enabled ?? true,
    }))
}

/** Reescala puntos al cambiar el tamaño del lienzo (PC ↔ tablet, rotación). */
export function rescale(polygons: Polygon[], from: { w: number; h: number }, to: { w: number; h: number }): Polygon[] {
  if (from.w === to.w && from.h === to.h) return polygons
  return polygons.map(p => ({ ...p, points: interpolatePoints(p.points, from.w, from.h, to.w, to.h) }))
}

export function newPolygon(cameraId: string, type: PolygonType, existing: Polygon[]): Polygon {
  const count = existing.filter(p => p.type === type).length + 1
  return {
    typeIndex: existing.length,
    camera: cameraId,
    name: `${type === 'zone' ? 'zona' : 'mascara'}_${count}`,
    type,
    objects: type === 'zone' ? ['persona'] : [],
    points: [],
    pointsOrder: [],
    distances: [],
    isFinished: false,
    color: COLORS[type],
    enabled: true,
  }
}
