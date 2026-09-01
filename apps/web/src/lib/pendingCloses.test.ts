// A1 (post #160) · la cola de cierres pendientes, con identidad del objetivo.
//
// Existe porque "que lo recoja el TTL" no es una red de seguridad para el HD:
// el heartbeat de la grilla toca la sesión `main`/`main_h264` co-locada para
// renovar su vencimiento —y debe seguir haciéndolo mientras el usuario mire la
// grilla—, así que un HD que quedó sin cerrar puede no vencer nunca con la
// pestaña abierta.
//
// Y lleva IDENTIDAD: un retry del intento A no puede cerrar una sesión B abierta
// después sobre la misma cámara/tipo.
import { describe, it, expect, beforeEach } from 'vitest'
import { createPendingCloseQueue, cierreConfirmado, type PendingCloseQueue } from './pendingCloses'

let q: PendingCloseQueue
beforeEach(() => { q = createPendingCloseQueue() })

describe('P0-1: la cola conserva la INTENCIÓN MÁS FUERTE, no la primera razón', () => {
  it('débil primero, fuerte después → queda la razón FUERTE (el retry escala)', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'hls_fatal_error' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'page_change' })
    expect(q.list()[0].reason).toBe('page_change')   // terminante gana
  })
  it('fuerte primero, débil después → sigue FUERTE (independiente del orden)', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'page_change' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'hls_fatal_error' })
    expect(q.list()[0].reason).toBe('page_change')
  })
  it('dos débiles conservan la primera (diagnóstico coherente)', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'hls_fatal_error' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'grid_retry' })
    expect(q.list()[0].reason).toBe('hls_fatal_error')
  })
  it('sigue contando los intentos y conserva la identidad al escalar', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'hls_fatal_error' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'page_change' })
    expect(q.list()[0]).toMatchObject({ startAttemptId: 'A', attempts: 2, reason: 'page_change' })
  })
})

describe('la cola recuerda qué falta cerrar, con su identidad', () => {
  it('anota y devuelve lo pendiente', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })

    expect(q.size()).toBe(1)
    expect(q.has('c1', 'main_h264', 'A')).toBe(true)
    expect(q.list()[0]).toMatchObject({
      cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', attempts: 1,
    })
  })

  it('reanotar la MISMA identidad cuenta intentos, no duplica', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })

    expect(q.size()).toBe(1)
    expect(q.list()[0].attempts).toBe(2)
  })

  it('dos intentos de la misma ranura son entradas distintas', () => {
    // A y B pueden estar pendientes a la vez sobre (cámara, tipo): son cierres
    // de sesiones lógicas distintas.
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B', reason: 'exit_focus' })

    expect(q.size()).toBe(2)
    expect(q.has('c1', 'main_h264', 'A')).toBe(true)
    expect(q.has('c1', 'main_h264', 'B')).toBe(true)
  })

  it('la razón del PRIMER intento manda', () => {
    // Determina si el backend puede matar el FFmpeg; un reintento no la cambia.
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'switch_to_sub' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'otra_cosa' })

    expect(q.list()[0].reason).toBe('switch_to_sub')
  })

  it('cada tipo de la misma cámara es una entrada propia', () => {
    q.add({ cameraId: 'c1', streamType: 'main', startAttemptId: 'A', reason: 'exit_focus' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })

    expect(q.size()).toBe(2)
  })

  it('`resolve` olvida SÓLO esa identidad', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'B', reason: 'exit_focus' })

    expect(q.resolve('c1', 'main_h264', 'A')).toBe(true)
    expect(q.has('c1', 'main_h264', 'A')).toBe(false)
    expect(q.has('c1', 'main_h264', 'B')).toBe(true)
    expect(q.resolve('c1', 'main_h264', 'A')).toBe(false)
  })

  it('`list` no permite mutar la cola desde afuera', () => {
    q.add({ cameraId: 'c1', streamType: 'main_h264', startAttemptId: 'A', reason: 'exit_focus' })
    q.list()[0].attempts = 99

    expect(q.list()[0].attempts).toBe(1)
  })
})

describe('cierreConfirmado exige que el desenlace hable de ESTE intento', () => {
  it('`session_closed` con attemptId coincidente confirma', () => {
    expect(cierreConfirmado({ outcome: 'session_closed', attemptId: 'A' }, 'A')).toBe(true)
  })

  it('`attempt_released` con attemptId coincidente confirma', () => {
    // El caso del retry de exit_focus tras re-entrada: A se soltó, B sobrevive.
    expect(cierreConfirmado({ outcome: 'attempt_released', attemptId: 'A' }, 'A')).toBe(true)
  })

  it('un desenlace de OTRO intento NO confirma', () => {
    expect(cierreConfirmado({ outcome: 'session_closed', attemptId: 'B' }, 'A')).toBe(false)
    expect(cierreConfirmado({ outcome: 'attempt_released', attemptId: 'B' }, 'A')).toBe(false)
  })

  it('`session_closed`/`attempt_released` SIN attemptId no confirma', () => {
    expect(cierreConfirmado({ outcome: 'session_closed' }, 'A')).toBe(false)
    expect(cierreConfirmado({ outcome: 'attempt_released' }, 'A')).toBe(false)
  })

  it.each(['no_session', 'already_gone'])(
    '`ignored` por «%s» confirma: la sesión objetivo no existe', (reason) => {
      expect(cierreConfirmado({ outcome: 'ignored', reason }, 'A')).toBe(true)
    })

  it('`attempt_not_registered` NO confirma: la ranura existe sin ESTE lease', () => {
    // La regresión del correctivo 7: tratarlo como confirmación olvidaba una
    // sesión de reconcile viva. Se conserva y se reintenta.
    expect(cierreConfirmado({ outcome: 'ignored', reason: 'attempt_not_registered' }, 'A')).toBe(false)
  })

  it.each(['retention_adopted', 'retention_gone'])(
    '`ignored/%s` sólo confirma cuando identifica ESTE intento', (reason) => {
      expect(cierreConfirmado({ outcome: 'ignored', reason, attemptId: 'A' }, 'A')).toBe(true)
      expect(cierreConfirmado({ outcome: 'ignored', reason, attemptId: 'B' }, 'A')).toBe(false)
      expect(cierreConfirmado({ outcome: 'ignored', reason }, 'A')).toBe(false)
    })

  it('`retention_pending` no confirma: la instancia exacta sigue viva', () => {
    expect(cierreConfirmado({
      outcome: 'ignored', reason: 'retention_pending', attemptId: 'A',
    }, 'A')).toBe(false)
  })

  it.each(['reaffirmed_by_newer_request', 'replaced_by_newer_generation', 'ambiguous_view', undefined])(
    '`ignored` por «%s» NO confirma: la sesión puede seguir viva', (reason) => {
      expect(cierreConfirmado({ outcome: 'ignored', reason }, 'A')).toBe(false)
    })

  it('un desenlace ausente no confirma', () => {
    expect(cierreConfirmado(undefined, 'A')).toBe(false)
    expect(cierreConfirmado(null, 'A')).toBe(false)
    expect(cierreConfirmado({}, 'A')).toBe(false)
  })
})
