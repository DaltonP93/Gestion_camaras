// Registro de las sesiones EFECTIVAS de esta pestaña.
//
// POR QUÉ NO ALCANZA `cameraId → Set<StreamKind>`
//
// La versión anterior ya guardaba el tipo real —eso arregló los cierres que
// asumían `sub`— pero seguía sin identificar QUÉ solicitud creó cada sesión.
// Con el backend redirigiendo `main` → `main_h264`, dos solicitudes distintas
// aterrizan en la misma entrada:
//
//   A pide `main`, el backend crea `main_h264`
//   B pide `main_h264`, queda vigente, responde primero y registra
//   A responde tarde → su descarte hacía `remove(cameraId, 'main_h264')`
//
// …y borraba del registro la entrada VIGENTE de B. A partir de ahí la vista ya
// no sabía que tenía esa sesión abierta y nadie la cerraba nunca.
//
// Cada entrada es ahora `cameraId + streamType + startAttemptId`. Un descarte
// tardío sólo puede quitar la entrada de SU intento; la de otro es intocable.
//
// Y una ranura puede sostener VARIOS arrendamientos a la vez, igual que del lado
// del servidor: si el usuario inicia A y B sobre la misma cámara y tipo, y las
// dos llegan a registrarse, la sesión vive mientras quede alguno. Colapsarlas en
// una sola entrada —reemplazando— hacía que el descarte de la superviviente no
// encontrara nada que soltar.

import type { StreamKind } from './streamTypes'

export interface SessionEntry {
  cameraId: string
  streamType: StreamKind
  /** Intento de arranque que creó esta sesión. */
  startAttemptId: string
  /**
   * Scope (generación de viewport/ruta) que era vigente cuando se creó. Una
   * transición cierra SÓLO las entradas de su scope abandonado; nunca una de
   * otro scope (una B que ocupó la ranura después). Opcional: los llamadores que
   * no usan scope (p. ej. sin transiciones) lo dejan sin definir.
   */
  ownerScope?: symbol
}

export interface SessionRegistry {
  /**
   * Registra un arrendamiento vivo. NO reemplaza los que ya hubiera sobre la
   * misma ranura: el backend los mantiene todos, y borrar el de otra solicitud
   * dejaría su sesión sin nadie que la recuerde.
   */
  add(entry: SessionEntry): void
  /**
   * Quita una entrada SÓLO si su intento coincide. Devuelve true si quitó algo.
   * Es la operación que usa el descarte tardío: nunca puede tocar la entrada de
   * otro intento.
   */
  removeAttempt(cameraId: string, streamType: StreamKind, startAttemptId: string): boolean
  /**
   * Quita TODOS los arrendamientos de ese tipo, sea cual sea el intento: es el
   * cierre deliberado, que cierra la ranura entera.
   */
  removeType(cameraId: string, streamType: StreamKind): SessionEntry[]
  /** ¿Existe una entrada exactamente de ese intento? */
  hasAttempt(cameraId: string, streamType: StreamKind, startAttemptId: string): boolean
  /** Arrendamientos vivos sobre esa ranura, en orden de alta. */
  attemptsOf(cameraId: string, streamType: StreamKind): string[]

  /** Tipos vivos de una cámara, en orden estable. */
  typesOf(cameraId: string): StreamKind[]
  /** Entradas completas de una cámara, en el mismo orden. */
  entriesOf(cameraId: string): SessionEntry[]
  has(cameraId: string): boolean
  hasType(cameraId: string, type: StreamKind): boolean
  cameras(): string[]
  /** Olvida TODAS las sesiones de una cámara y devuelve las que había. */
  forget(cameraId: string): SessionEntry[]
  clear(): SessionEntry[]
  size(): number
  snapshot(): SessionEntry[]
}

// Orden estable para que los cierres y las pruebas sean deterministas: primero
// lo transcodificado, que es lo que consume un proceso.
const ORDEN: readonly StreamKind[] = ['main_h264', 'main', 'sub']
const porOrden = (a: SessionEntry, b: SessionEntry) =>
  ORDEN.indexOf(a.streamType) - ORDEN.indexOf(b.streamType)

export function createSessionRegistry(): SessionRegistry {
  /** cámara → (tipo → (intento → entrada)). Varios arrendamientos por ranura. */
  const porCamara = new Map<string, Map<StreamKind, Map<string, SessionEntry>>>()

  const ranuras = (cameraId: string) => {
    let m = porCamara.get(cameraId)
    if (!m) { m = new Map(); porCamara.set(cameraId, m) }
    return m
  }
  const arrendamientos = (cameraId: string, streamType: StreamKind) => {
    const m = ranuras(cameraId)
    let s = m.get(streamType)
    if (!s) { s = new Map(); m.set(streamType, s) }
    return s
  }
  const podar = (cameraId: string, streamType?: StreamKind) => {
    const m = porCamara.get(cameraId)
    if (!m) return
    if (streamType && (m.get(streamType)?.size ?? 0) === 0) m.delete(streamType)
    if (m.size === 0) porCamara.delete(cameraId)
  }
  const ordenadas = (cameraId: string): SessionEntry[] =>
    Array.from(porCamara.get(cameraId)?.values() ?? [])
      .flatMap(s => Array.from(s.values()))
      .sort(porOrden)

  return {
    add(entry) { arrendamientos(entry.cameraId, entry.streamType).set(entry.startAttemptId, { ...entry }) },

    removeAttempt(cameraId, streamType, startAttemptId) {
      const s = porCamara.get(cameraId)?.get(streamType)
      // La comparación es la garantía: sólo se suelta el arrendamiento propio.
      // Los de otras solicitudes —vivas y vigentes— quedan intactos.
      if (!s?.has(startAttemptId)) return false
      s.delete(startAttemptId)
      podar(cameraId, streamType)
      return true
    },

    removeType(cameraId, streamType) {
      const s = porCamara.get(cameraId)?.get(streamType)
      if (!s || s.size === 0) return []
      const out = Array.from(s.values())
      s.clear()
      podar(cameraId, streamType)
      return out
    },

    hasAttempt(cameraId, streamType, startAttemptId) {
      return porCamara.get(cameraId)?.get(streamType)?.has(startAttemptId) ?? false
    },

    attemptsOf(cameraId, streamType) {
      return Array.from(porCamara.get(cameraId)?.get(streamType)?.keys() ?? [])
    },

    typesOf(cameraId) {
      return Array.from(new Set(ordenadas(cameraId).map(e => e.streamType)))
    },
    entriesOf(cameraId) { return ordenadas(cameraId).map(e => ({ ...e })) },

    has(cameraId) { return ordenadas(cameraId).length > 0 },
    hasType(cameraId, type) { return (porCamara.get(cameraId)?.get(type)?.size ?? 0) > 0 },
    cameras() { return Array.from(porCamara.keys()) },

    forget(cameraId) {
      const out = ordenadas(cameraId)
      porCamara.delete(cameraId)
      return out
    },

    clear() {
      const out = Array.from(porCamara.keys()).flatMap(id => ordenadas(id))
      porCamara.clear()
      return out
    },

    size() {
      let n = 0
      porCamara.forEach(m => m.forEach(s => { n += s.size }))
      return n
    },

    snapshot() {
      return Array.from(porCamara.keys()).flatMap(id => ordenadas(id)).map(e => ({ ...e }))
    },
  }
}
