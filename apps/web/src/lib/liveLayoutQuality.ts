import type { GridLayout } from '@/types'

export type LiveLayoutFocusAction = 'enter_focus' | 'exit_focus' | 'none'

export interface LiveLayoutChangeInput {
  requestedLayout: GridLayout
  currentLayout: GridLayout
  currentPage: number
  orderedCameraIds: string[]
  visibleCameraId?: string | null
  focusCameraId?: string | null
}

export interface LiveLayoutChangePlan {
  targetPage: number
  targetCameraId: string | null
  viewportChanged: boolean
  focusAction: LiveLayoutFocusAction
}

/**
 * Decide el cambio de layout sin mezclarlo con React ni con el ciclo de vida
 * de streams.
 *
 * La cámara en foco tiene prioridad; si no existe, se conserva la primera
 * cámara visible. De ese modo 3×3 → 1×1 amplía lo que el operador ya estaba
 * viendo, en vez de saltar silenciosamente a la primera cámara del NVR.
 */
export function planLiveLayoutChange({
  requestedLayout,
  currentLayout,
  currentPage,
  orderedCameraIds,
  visibleCameraId,
  focusCameraId,
}: LiveLayoutChangeInput): LiveLayoutChangePlan {
  const ordered = new Set(orderedCameraIds)
  const targetCameraId = [focusCameraId, visibleCameraId, orderedCameraIds[0]]
    .find((id): id is string => Boolean(id && ordered.has(id))) ?? null

  const targetIndex = targetCameraId === null
    ? -1
    : orderedCameraIds.indexOf(targetCameraId)
  const targetPage = targetIndex < 0
    ? 0
    : Math.floor(targetIndex / requestedLayout)
  const viewportChanged = requestedLayout !== currentLayout || targetPage !== currentPage

  let focusAction: LiveLayoutFocusAction = 'none'
  if (requestedLayout === 1 && targetCameraId) {
    // Una transición cierra las sesiones del viewport anterior. Aunque la
    // misma cámara ya estuviera en foco, hay que readquirir HD si el layout o
    // la página cambian.
    if (focusCameraId !== targetCameraId || viewportChanged) {
      focusAction = 'enter_focus'
    }
  } else if (requestedLayout !== 1 && focusCameraId) {
    focusAction = 'exit_focus'
  }

  return { targetPage, targetCameraId, viewportChanged, focusAction }
}
