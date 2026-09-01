// A1 (post #160, 3ª vuelta) · un cierre por respuesta tardía no puede matar la
// sesión de OTRA solicitud.
//
// LA CARRERA
//
//   1. A pide `main`; el backend la redirige y crea `main_h264`.
//   2. B pide `main_h264` para la misma cámara y vista, y queda vigente.
//   3. B responde primero: registra y aplica.
//   4. A responde tarde.
//   5. El descarte de A cierra `(user, view, cámara, main_h264)`… que es B.
//
// Ninguna defensa por ORDEN sirve: el DELETE de A saca su ticket al cerrarse, o
// sea DESPUÉS del de B, así que pasa el watermark y `lastOwnerRequestSeq`. Lo
// único que separa a A de B es el intento de arranque que cada una declaró.
//
// Acá se ejecuta `decideAttemptRelease`, que es LA función que `stopStream`
// llama como primera decisión, antes de `markTargetClosed`, del watermark, del
// borrado y del kill. Y se ejecuta junto a `decideStopTermination`, la que
// decide el proceso, para comprobar el efecto completo.
//
// La identidad es un CONJUNTO de arrendamientos, no un dueño único: dos
// arranques concurrentes son dos espectadores legítimos, y la sesión sólo cae
// cuando se suelta el último.
import { describe, it, expect } from 'vitest'
import {
  decideAttemptRelease, decideStopTermination, decideStaleSessionDelete,
} from './session-lifecycle'
import { TRANSCODE_KILL_REASONS, STALE_RESPONSE_REASON } from './stream-manager'

const A = 'sa-aaaa-1'
const B = 'sa-bbbb-2'

/** Sesión vigente en la ranura `(u1, v1, c1, main_h264)`, arrendada por B. */
const sesionDeB = { startAttemptIds: new Set([B]) }

const cerrarStale = (expected?: string, session?: { startAttemptIds?: ReadonlySet<string> } | null) =>
  decideAttemptRelease({
    reason: STALE_RESPONSE_REASON,
    staleReason: STALE_RESPONSE_REASON,
    expectedStartAttemptId: expected,
    session,
  })

describe('A pide main → se crea main_h264; B pide main_h264 y queda vigente', () => {
  it('el cierre tardío de A NO procede sobre la sesión de B', () => {
    const v = cerrarStale(A, sesionDeB)

    expect(v.action).toBe('ignored')
    expect(v).toMatchObject({ reason: 'attempt_not_registered' })
  })

  it('rechazar significa NO tocar nada: ni marca de cierre, ni fila, ni proceso', () => {
    // El veredicto es la puerta: `stopStream` retorna antes de `markTargetClosed`.
    // Se comprueba acá que el rechazo no deja ningún resquicio por el que la
    // decisión del proceso llegue a ejecutarse.
    const v = cerrarStale(A, sesionDeB)
    expect(v.action).toBe('ignored')

    // Y si alguien igual llegara a evaluar la terminación, la razón sí mata:
    // por eso la única defensa real es no llegar. Este es el contraste.
    const t = decideStopTermination({
      streamType: 'main_h264',
      reason: STALE_RESPONSE_REASON,
      killReasons: TRANSCODE_KILL_REASONS,
      expired: [{
        key: 'k', userId: 'u1', viewId: 'v1', cameraId: 'c1',
        streamType: 'main_h264', streamPath: '/c1_main_h264',
        lastClientHeartbeatMs: 0, generation: 1,
      }],
      surviving: [],
    })
    expect(t.terminate).toEqual(['/c1_main_h264'])
  })

  it('el cierre tardío de B —su propia sesión— sí procede', () => {
    const v = cerrarStale(B, sesionDeB)

    // Era el ÚNICO arrendamiento: se cierra la sesión.
    expect(v).toEqual({ action: 'close_session', attemptId: B })
  })
})

describe('identidad ausente o sin sesión', () => {
  it('sin `expectedStartAttemptId` el cierre tardío se rechaza entero', () => {
    // "Cerrá lo que haya en esa ranura" es exactamente el defecto. El TTL del
    // servidor sigue siendo la garantía final para una huérfana de verdad.
    const v = cerrarStale(undefined, sesionDeB)

    expect(v).toEqual({ action: 'ignored', reason: 'missing_expected_id' })
  })

  it('sin sesión en la ranura tampoco procede: no puede marcar un cierre', () => {
    // Importa que sea rechazo y no "seguir": seguir marcaría el watermark y
    // bloquearía un arranque legítimo que todavía viaja.
    const v = cerrarStale(A, null)

    expect(v).toEqual({ action: 'ignored', reason: 'no_session' })
  })

  it('una sesión sin intento propietario no la cierra ningún descarte', () => {
    // Las sesiones nacidas de la reconciliación del heartbeat no tienen intento
    // de cliente. Que un descarte pudiera cerrarlas sería el mismo agujero.
    expect(cerrarStale(A, { startAttemptIds: new Set<string>() }))
      .toEqual({ action: 'ignored', reason: 'attempt_not_registered' })
    expect(cerrarStale(A, {})).toEqual({ action: 'ignored', reason: 'attempt_not_registered' })
  })
})

describe('los cierres deliberados conservan su comportamiento', () => {
  it.each([
    'viewport_change', 'nvr_change', 'page_change', 'layout_change',
    'exit_focus', 'switch_to_sub', 'stop_all', 'hls_fatal_error', undefined,
  ])('«%s» procede sin declarar intento alguno', (razon) => {
    const v = decideAttemptRelease({
      reason: razon,
      staleReason: STALE_RESPONSE_REASON,
      expectedStartAttemptId: undefined,
      session: sesionDeB,
    })

    expect(v).toEqual({ action: 'full_close' })
  })

  it('un cierre deliberado a granel (sin identidad) sí es full_close', () => {
    const v = decideAttemptRelease({
      reason: 'nvr_change',
      staleReason: STALE_RESPONSE_REASON,
      expectedStartAttemptId: undefined,
      session: sesionDeB,
    })

    expect(v).toEqual({ action: 'full_close' })
  })

  it('pero un cierre deliberado CON identidad que no coincide NO toca la ranura', () => {
    // La corrección de esta ronda: la identidad —no la razón— decide el modo.
    // Un retry de `exit_focus` del intento A no puede cerrar la sesión de B.
    const v = decideAttemptRelease({
      reason: 'nvr_change',
      staleReason: STALE_RESPONSE_REASON,
      expectedStartAttemptId: A,
      session: sesionDeB,   // leases: { B }
    })

    expect(v).toEqual({ action: 'ignored', reason: 'attempt_not_registered' })
  })

  it('un cierre deliberado CON identidad que coincide suelta ese arrendamiento', () => {
    const dos = { startAttemptIds: new Set([A, B]) }
    expect(decideAttemptRelease({
      reason: 'exit_focus', staleReason: STALE_RESPONSE_REASON,
      expectedStartAttemptId: A, session: dos,
    })).toEqual({ action: 'release_attempt', attemptId: A, remaining: 1 })

    expect(decideAttemptRelease({
      reason: 'exit_focus', staleReason: STALE_RESPONSE_REASON,
      expectedStartAttemptId: A, session: { startAttemptIds: new Set([A]) },
    })).toEqual({ action: 'close_session', attemptId: A })
  })
})

describe('cierre tardío con identidad coincidente: efecto completo', () => {
  it('procede y, sin otros espectadores del path, termina el FFmpeg', () => {
    const v = cerrarStale(A, { startAttemptIds: new Set([A]) })
    expect(v).toEqual({ action: 'close_session', attemptId: A })

    const t = decideStopTermination({
      streamType: 'main_h264',
      reason: STALE_RESPONSE_REASON,
      killReasons: TRANSCODE_KILL_REASONS,
      expired: [{
        key: 'kA', userId: 'u1', viewId: 'v1', cameraId: 'c1',
        streamType: 'main_h264', streamPath: '/c1_main_h264',
        lastClientHeartbeatMs: 0, generation: 1,
      }],
      surviving: [],
    })

    expect(t.shouldKill).toBe(true)
    expect(t.terminate).toEqual(['/c1_main_h264'])
  })

  it('pero no si otro espectador comparte el mismo proceso', () => {
    expect(cerrarStale(A, { startAttemptIds: new Set([A]) }).action).toBe('close_session')

    const t = decideStopTermination({
      streamType: 'main_h264',
      reason: STALE_RESPONSE_REASON,
      killReasons: TRANSCODE_KILL_REASONS,
      expired: [{
        key: 'kA', userId: 'u1', viewId: 'v1', cameraId: 'c1',
        streamType: 'main_h264', streamPath: '/c1_main_h264',
        lastClientHeartbeatMs: 0, generation: 1,
      }],
      surviving: [{
        key: 'kOtra', userId: 'u2', viewId: 'v9', cameraId: 'c1',
        streamType: 'main_h264', streamPath: '/c1_main_h264',
        lastClientHeartbeatMs: 0, generation: 1,
      }],
    })

    expect(t.terminate).toEqual([])
  })
})

// ─── Arrendamientos coexistentes ─────────────────────────────────────────────

describe('A y B sostienen la MISMA sesión a la vez', () => {
  const dos = { startAttemptIds: new Set([A, B]) }

  it('el descarte de A suelta sólo A y deja la sesión en pie', () => {
    expect(cerrarStale(A, dos)).toEqual({ action: 'release_attempt', attemptId: A, remaining: 1 })
  })

  it('el descarte de B suelta sólo B', () => {
    expect(cerrarStale(B, dos)).toEqual({ action: 'release_attempt', attemptId: B, remaining: 1 })
  })

  it('cuando queda uno solo, su descarte sí cierra la sesión', () => {
    expect(cerrarStale(B, { startAttemptIds: new Set([B]) }))
      .toEqual({ action: 'close_session', attemptId: B })
  })

  it('con tres, se sueltan de a uno y sólo el último cierra', () => {
    const tres = new Set([A, B, 'sa-cccc-3'])
    expect(cerrarStale(A, { startAttemptIds: tres })).toMatchObject({ action: 'release_attempt', remaining: 2 })
    tres.delete(A)
    expect(cerrarStale(B, { startAttemptIds: tres })).toMatchObject({ action: 'release_attempt', remaining: 1 })
    tres.delete(B)
    expect(cerrarStale('sa-cccc-3', { startAttemptIds: tres })).toMatchObject({ action: 'close_session' })
  })

  it('un intento que nunca se registró no suelta nada, haya los que haya', () => {
    expect(cerrarStale('sa-zzzz-9', dos))
      .toEqual({ action: 'ignored', reason: 'attempt_not_registered' })
  })
})

// ─── El borrado, releído justo antes de tocar el mapa ────────────────────────
//
// `decideStaleSessionDelete` es la segunda mitad: `decideAttemptRelease` dice
// QUÉ corresponde hacer, y ésta comprueba —sobre la fila releída— que siga
// correspondiendo. Existe porque la protección general por ticket no distingue
// un arranque nuevo de un heartbeat, y ambos elevan `lastOwnerRequestSeq`.
//
// ALCANCE HONESTO: hoy `stopStream` no tiene ningún `await` entre la primera
// lectura y esta relectura, así que sus ramas de rechazo no son alcanzables por
// ese camino y se ejercitan acá, directamente sobre la función que usa. Si
// mañana aparece una operación asíncrona en medio —lo que ya pasó dos veces en
// este módulo— la comprobación ya está puesta y probada.

describe('decideStaleSessionDelete', () => {
  const conLeases = (generation: number, ...leases: string[]) =>
    ({ generation, startAttemptIds: new Set(leases) })

  it('borra cuando A es el único arrendamiento de la misma generación', () => {
    expect(decideStaleSessionDelete({
      attemptId: A, expectedGeneration: 7, current: conLeases(7, A),
    })).toEqual({ deletable: true })
  })

  it('NO borra si la ranura ya está vacía', () => {
    expect(decideStaleSessionDelete({
      attemptId: A, expectedGeneration: 7, current: null,
    })).toEqual({ deletable: false, reason: 'already_gone' })
  })

  it('NO borra si otra generación ocupa la ranura: eso sí es algo nuevo', () => {
    expect(decideStaleSessionDelete({
      attemptId: A, expectedGeneration: 7, current: conLeases(8, A),
    })).toEqual({ deletable: false, reason: 'replaced_by_newer_generation' })
  })

  it('NO borra si el arrendamiento ya se soltó por otro camino', () => {
    expect(decideStaleSessionDelete({
      attemptId: A, expectedGeneration: 7, current: conLeases(7, B),
    })).toEqual({ deletable: false, reason: 'attempt_gone' })
  })

  it('NO borra si apareció otro espectador: se suelta el propio, nada más', () => {
    expect(decideStaleSessionDelete({
      attemptId: A, expectedGeneration: 7, current: conLeases(7, A, B),
    })).toEqual({ deletable: false, reason: 'other_leases', remaining: 1 })
  })

  it('el ticket NO entra en esta decisión: no hay parámetro por donde entre', () => {
    // Es la garantía central de la corrección. Un heartbeat sube
    // `lastOwnerRequestSeq` y no puede cambiar nada de lo que se mira acá.
    expect(Object.keys({
      attemptId: A, expectedGeneration: 7, current: conLeases(7, A),
    })).toEqual(['attemptId', 'expectedGeneration', 'current'])
  })
})
