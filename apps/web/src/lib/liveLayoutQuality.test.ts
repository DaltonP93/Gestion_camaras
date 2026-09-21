import { describe, expect, it } from 'vitest'
import { planLiveLayoutChange } from './liveLayoutQuality'

const ids = Array.from({ length: 12 }, (_, index) => `cam-${index + 1}`)

describe('planLiveLayoutChange', () => {
  it('3×3 → 1×1 conserva la primera cámara visible y solicita foco HD', () => {
    expect(planLiveLayoutChange({
      requestedLayout: 1,
      currentLayout: 9,
      currentPage: 1,
      orderedCameraIds: ids,
      visibleCameraId: 'cam-10',
      focusCameraId: null,
    })).toEqual({
      targetPage: 9,
      targetCameraId: 'cam-10',
      viewportChanged: true,
      focusAction: 'enter_focus',
    })
  })

  it('1×1 que todavía muestra substream entra en foco sin otra transición', () => {
    expect(planLiveLayoutChange({
      requestedLayout: 1,
      currentLayout: 1,
      currentPage: 4,
      orderedCameraIds: ids,
      visibleCameraId: 'cam-5',
      focusCameraId: null,
    })).toMatchObject({
      targetPage: 4,
      targetCameraId: 'cam-5',
      viewportChanged: false,
      focusAction: 'enter_focus',
    })
  })

  it('no reinicia HD al pulsar otra vez el 1×1 ya activo', () => {
    expect(planLiveLayoutChange({
      requestedLayout: 1,
      currentLayout: 1,
      currentPage: 4,
      orderedCameraIds: ids,
      visibleCameraId: 'cam-5',
      focusCameraId: 'cam-5',
    }).focusAction).toBe('none')
  })

  it('1×1 → 2×2 sale de foco y conserva la página que contiene la cámara', () => {
    expect(planLiveLayoutChange({
      requestedLayout: 4,
      currentLayout: 1,
      currentPage: 9,
      orderedCameraIds: ids,
      visibleCameraId: 'cam-10',
      focusCameraId: 'cam-10',
    })).toEqual({
      targetPage: 2,
      targetCameraId: 'cam-10',
      viewportChanged: true,
      focusAction: 'exit_focus',
    })
  })

  it('cerrar un foco superpuesto no cambia un layout que ya era el correcto', () => {
    expect(planLiveLayoutChange({
      requestedLayout: 9,
      currentLayout: 9,
      currentPage: 0,
      orderedCameraIds: ids,
      visibleCameraId: 'cam-1',
      focusCameraId: 'cam-5',
    })).toMatchObject({
      targetPage: 0,
      viewportChanged: false,
      focusAction: 'exit_focus',
    })
  })

  it('sin cámaras produce un plan inerte y seguro', () => {
    expect(planLiveLayoutChange({
      requestedLayout: 1,
      currentLayout: 9,
      currentPage: 0,
      orderedCameraIds: [],
      visibleCameraId: null,
      focusCameraId: null,
    })).toEqual({
      targetPage: 0,
      targetCameraId: null,
      viewportChanged: true,
      focusAction: 'none',
    })
  })
})
