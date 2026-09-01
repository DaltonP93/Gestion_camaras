// Carga de una VISTA (CameraView + sus cámaras y streams) con ALCANCE.
//
// POR QUÉ EXISTE
//
// La ruta `views/:id` conserva el mismo componente montado entre navegaciones.
// Al ir de A a B, si B resolvía primero y A después, la respuesta tardía de A
// sobrescribía `view` y `slots` mientras la URL seguía en B. Peor: el cargador
// de grilla tomaba entonces la vista A como actual y abría SUS streams, y el
// heartbeat los mantenía vivos —cámaras que el usuario no está mirando—.
//
// La corrida de carga lleva una IDENTIDAD (un token por `id` y montaje). Se
// compara contra el ref VIGENTE —no contra el `id` capturado por el closure, que
// no distingue una corrida vieja de la nueva sobre el mismo id tras un remonte—
// después de CADA await y antes de CADA cambio de estado. Una respuesta que dejó
// de ser vigente no toca nada: ni estado, ni streams, ni loading/error.
//
// Se extrae del componente para poder ejercitar el CÓDIGO REAL —no una réplica—
// contra promesas que se resuelven en el orden que la prueba elija.

export interface ScopedViewLoadDeps<V, C, S> {
  id: string
  /** ¿Esta carga sigue siendo la vigente? Se consulta tras cada await. */
  isCurrent: () => boolean
  fetchView: (id: string) => Promise<V>
  /** Ids de cámara asignados en la vista, en orden. */
  assignedIds: (view: V) => string[]
  fetchCamera: (cameraId: string) => Promise<C>
  fetchStream: (cameraId: string) => Promise<S>
  onView: (view: V) => void
  onSlots: (view: V, cameras: Map<string, C>, streams: Map<string, S>) => void
  onError: (message: string) => void
  /** loading=false. Sólo si la carga sigue vigente. */
  onSettled: () => void
  errorMessage?: (e: unknown) => string
}

/**
 * Ejecuta la carga completa respetando el alcance en cada punto de reanudación.
 *
 * Los DOS guardas —tras el `CameraView` y tras los GETs secundarios— son lo que
 * impide que una corrida vieja pise a la nueva. `onSettled` y `onError` también
 * se guardan: un `finally`/`catch` tardío de A no puede tocar el loading/error
 * de B.
 */
export async function runScopedViewLoad<V, C, S>(d: ScopedViewLoadDeps<V, C, S>): Promise<void> {
  try {
    const view = await d.fetchView(d.id)
    // Tras el GET del CameraView: si ya no es vigente, no toca `view` ni sigue.
    if (!d.isCurrent()) return
    d.onView(view)

    const ids = d.assignedIds(view)
    const [camerasData, streamData] = await Promise.all([
      Promise.allSettled(ids.map((cid) => d.fetchCamera(cid))),
      Promise.allSettled(ids.map((cid) => d.fetchStream(cid))),
    ])

    // Tras los GETs secundarios: pudieron resolver tarde, ya en la vista nueva.
    if (!d.isCurrent()) return

    const cameras = new Map<string, C>()
    camerasData.forEach((r, i) => { if (r.status === 'fulfilled') cameras.set(ids[i], r.value) })
    const streams = new Map<string, S>()
    streamData.forEach((r, i) => { if (r.status === 'fulfilled') streams.set(ids[i], r.value) })

    d.onSlots(view, cameras, streams)
  } catch (e) {
    if (d.isCurrent()) d.onError(d.errorMessage ? d.errorMessage(e) : 'No se pudo cargar la vista')
  } finally {
    if (d.isCurrent()) d.onSettled()
  }
}
