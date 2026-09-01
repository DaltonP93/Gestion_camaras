// Hook React que instancia y ata al DOM el controlador de ciclo de vida.
//
// Es la ÚNICA frontera por la que las páginas tocan el arranque, el cierre y la
// vista: aquí —no en las páginas— viven `apiPost(start-stream)`,
// `closeStreamSession` y `closeViewSessions`. Las páginas reciben el controlador
// y sólo llaman su API (start/close/beginTransition/scheduleHlsRestart/heartbeat/
// disposeView). Una guarda AST verifica que ningún `start-stream`,
// `closeStreamSession` ni `closeViewSessions` directo sobreviva en las páginas.
import { useEffect, useRef } from 'react'
import { apiPost } from './api'
import { closeStreamSession, closeViewSessions } from './sessionClose'
import {
  createViewportSessionController, type ViewportSessionController,
} from './viewportSessionController'
import type { StreamInfo } from '@/types'

/**
 * Crea el controlador (una vez por montaje) con las dependencias sancionadas y
 * conecta la visibilidad de la pestaña a su heartbeat. Devuelve el controlador.
 */
export function useViewportSessionLifecycle(viewId: string): ViewportSessionController {
  const ref = useRef<ViewportSessionController | null>(null)
  if (!ref.current) {
    ref.current = createViewportSessionController({
      viewId,
      // El arranque real vive acá; el controlador agrega viewId + startAttemptId.
      startStream: (cameraId, body, signal) =>
        apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, body, undefined, signal) as any,
      close: closeStreamSession,
      closeView: closeViewSessions,
    })
  }
  const ctrl = ref.current

  // La visibilidad de la pestaña gobierna el heartbeat: oculta ⇒ no late; al
  // volver ⇒ un latido inmediato y un solo intervalo (lo maneja el scheduler que
  // posee el controlador).
  useEffect(() => {
    const onVis = () => ctrl.handleVisibilityChange()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [ctrl])

  return ctrl
}
