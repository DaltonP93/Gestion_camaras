// apps/api/src/services/session-lifecycle.ts
//
// FUENTE ÚNICA de la verdad sobre la vigencia de una sesión de LiveView.
//
// EL BUG QUE ESTE MÓDULO EXISTE PARA IMPEDIR (incidente del 2026-08-11):
// el limpiador renovaba `lastHeartbeat` cuando veía FFmpeg vivo. Eso cerraba un
// ciclo que se alimentaba a sí mismo —FFmpeg vivo ⇒ heartbeat renovado ⇒ la
// sesión nunca se borra ⇒ nunca se llama a stopTranscodeProcess ⇒ FFmpeg sigue
// vivo— y produjo una sesión iniciada el 2026-08-10T12:38:14.898Z que todavía
// "latía" el 2026-08-11T14:22:00.832Z. Quien actualizaba el heartbeat era el
// propio limpiador, no un espectador.
//
// Esa sesión fantasma además contaba como demanda real en el monitor de
// pipeline (activeSessions > 0 ⇒ demandActive), y con el path on-demand apagado
// porque nadie miraba, terminaba fabricando CAMERA_STREAM_ERROR.
//
// TRES CONCEPTOS DISTINTOS QUE NO PUEDEN MEZCLARSE:
//
//   lastClientHeartbeat  Hora del SERVIDOR al recibir actividad explícita de un
//                        cliente autenticado. ÚNICA evidencia de que alguien
//                        está mirando. Nunca se deriva del navegador: un
//                        timestamp enviado por el cliente no es confiable.
//   lastMediaActivity    Diagnóstico. Que el medio se mueva NO prueba que haya
//                        un espectador (FFmpeg tira del RTSP aunque nadie mire).
//   processAlive         Estado OBSERVADO del proceso. No es un heartbeat y no
//                        puede mantener viva una sesión de usuario.
//
// Las funciones de este archivo son PURAS y reciben el reloj por parámetro, de
// modo que las carreras se prueban de forma determinista.

export type StreamType = 'sub' | 'main' | 'main_h264'

/** Proyección mínima de una sesión para decidir su vigencia. */
export interface SessionTruth {
  key: string
  userId: string
  viewId: string
  cameraId: string
  streamType: StreamType
  streamPath: string
  /** Hora del servidor (epoch ms) del último heartbeat REAL de cliente. */
  lastClientHeartbeatMs: number
  /** Generación de la sesión: distingue una sesión reabierta de la cerrada. */
  generation: number
}

// ─── TTL efectivo ────────────────────────────────────────────────────────────

/** TTL por defecto de una sesión de grilla (substream), en segundos. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_SEC = 90
/**
 * TTL por defecto de una sesión HD/transcodificada con la pestaña en segundo
 * plano, en segundos. Decisión explícita del encargo: 90 s.
 */
export const DEFAULT_STREAM_HD_IDLE_TIMEOUT_SEC = 90

const MIN_IDLE_TIMEOUT_SEC = 15      // por debajo, un hipo de red mata la sesión
const MAX_IDLE_TIMEOUT_SEC = 3600    // 1 h — techo para que un error de config no inmortalice sesiones

export interface SessionTtl {
  /** TTL de sesiones `sub` y `main` (ms). */
  standardTtlMs: number
  /** TTL de sesiones `main_h264` (ms). */
  hdTtlMs: number
  /** Lo que pidió el operador, ya normalizado, o null si no configuró nada. */
  requestedStandardSec: number | null
  requestedHdSec: number | null
  /** true si algún valor configurado NO es el que rige (se acotó). */
  wasClamped: boolean
}

/**
 * Parsea segundos exigiendo un entero DECIMAL COMPLETO. No se usa parseInt
 * suelto porque acepta prefijos parciales: "1e5" daría 1 y "90s" daría 90, con
 * lo que una configuración mal formada se aceptaría en silencio.
 */
function parseStrictSec(value: unknown): number | null {
  let n: number
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null   // rechaza "", "1e5", "90s", "-5", "1.5"
    n = Number(trimmed)
  } else if (typeof value === 'number') {
    n = value
  } else {
    return null
  }
  if (!Number.isFinite(n)) return null
  const floored = Math.floor(n)
  return floored > 0 ? floored : null
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * PURA. Resuelve los dos TTL efectivos. El HD cae al TTL estándar cuando no se
 * configuró uno propio, de modo que un despliegue que sólo define
 * STREAM_IDLE_TIMEOUT sigue comportándose igual que antes.
 */
export function resolveSessionTtl(input: {
  streamIdleTimeoutSec?: unknown
  streamHdIdleTimeoutSec?: unknown
}): SessionTtl {
  const parsedStd = parseStrictSec(input.streamIdleTimeoutSec)
  const parsedHd  = parseStrictSec(input.streamHdIdleTimeoutSec)

  const standardSec = parsedStd != null
    ? clamp(parsedStd, MIN_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC)
    : DEFAULT_STREAM_IDLE_TIMEOUT_SEC
  const hdSec = parsedHd != null
    ? clamp(parsedHd, MIN_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC)
    // Sin configuración propia el HD hereda el estándar (no el default fijo):
    // así un operador que sube STREAM_IDLE_TIMEOUT no se encuentra con que el
    // HD sigue muriendo a los 90 s sin haberlo pedido.
    : (parsedStd != null ? standardSec : DEFAULT_STREAM_HD_IDLE_TIMEOUT_SEC)

  return {
    standardTtlMs: standardSec * 1000,
    hdTtlMs: hdSec * 1000,
    requestedStandardSec: parsedStd != null ? standardSec : null,
    requestedHdSec: parsedHd != null ? hdSec : null,
    wasClamped:
      (parsedStd != null && standardSec !== parsedStd) ||
      (parsedHd != null && hdSec !== parsedHd),
  }
}

let cachedTtl: SessionTtl | null = null

/**
 * TTL efectivo del proceso, resuelto UNA vez desde el entorno. Se registran
 * SIEMPRE los valores efectivos: el entorno crudo puede diferir de lo que rige
 * (un TTL de 5 corre como 15), así que leer las variables no alcanza para saber
 * con qué plazos opera el proceso.
 */
export function getSessionTtl(log?: (msg: string) => void): SessionTtl {
  if (cachedTtl) return cachedTtl
  cachedTtl = resolveSessionTtl({
    streamIdleTimeoutSec: process.env.STREAM_IDLE_TIMEOUT,
    streamHdIdleTimeoutSec: process.env.STREAM_HD_IDLE_TIMEOUT,
  })
  log?.(
    `[stream-manager] stream_session_ttl_resolved` +
    ` standardTtlMs=${cachedTtl.standardTtlMs}` +
    ` hdTtlMs=${cachedTtl.hdTtlMs}` +
    ` requestedStandardSec=${cachedTtl.requestedStandardSec ?? 'none'}` +
    ` requestedHdSec=${cachedTtl.requestedHdSec ?? 'none'}` +
    ` wasClamped=${cachedTtl.wasClamped}`
  )
  return cachedTtl
}

/** Sólo para tests: olvida el TTL memoizado. */
export function resetSessionTtlCache(): void {
  cachedTtl = null
}

/** TTL que corresponde a un tipo de stream. */
export function ttlForStreamType(streamType: StreamType, ttl: SessionTtl): number {
  return streamType === 'main_h264' ? ttl.hdTtlMs : ttl.standardTtlMs
}

// ─── Vigencia ────────────────────────────────────────────────────────────────

export type ExpiryReason = 'client_heartbeat_expired' | 'view_heartbeat_expired' | 'view_heartbeat_missing'

export interface ExpiredSession {
  session: SessionTruth
  reason: ExpiryReason
  /** Edad del heartbeat de cliente al decidir (ms) — para el log. */
  clientHeartbeatAgeMs: number
}

export interface ExpiryDecision {
  expired: ExpiredSession[]
  surviving: SessionTruth[]
}

/**
 * PURA. Decide qué sesiones vencieron. Sólo mira heartbeats de CLIENTE: ni el
 * proceso vivo ni la actividad de medio entran en esta decisión, y no existe
 * ningún parámetro por el que pudieran entrar.
 *
 * Una sesión vence si su propio heartbeat de cliente venció, o si venció (o no
 * existe) el heartbeat del view al que pertenece: ambos los produce el cliente.
 */
export function decideSessionExpiry(input: {
  sessions: SessionTruth[]
  /** key: `${userId}:${viewId}` → hora del servidor del último heartbeat del view. */
  viewHeartbeats: Map<string, number>
  nowMs: number
  ttl: SessionTtl
}): ExpiryDecision {
  const { sessions, viewHeartbeats, nowMs, ttl } = input
  const expired: ExpiredSession[] = []
  const surviving: SessionTruth[] = []

  for (const s of sessions) {
    const limit = ttlForStreamType(s.streamType, ttl)
    const clientAge = nowMs - s.lastClientHeartbeatMs
    const vk = `${s.userId}:${s.viewId}`
    const viewBeat = viewHeartbeats.get(vk)

    if (clientAge > limit) {
      expired.push({ session: s, reason: 'client_heartbeat_expired', clientHeartbeatAgeMs: clientAge })
      continue
    }
    if (viewBeat == null) {
      expired.push({ session: s, reason: 'view_heartbeat_missing', clientHeartbeatAgeMs: clientAge })
      continue
    }
    if (nowMs - viewBeat > limit) {
      expired.push({ session: s, reason: 'view_heartbeat_expired', clientHeartbeatAgeMs: clientAge })
      continue
    }
    surviving.push(s)
  }

  return { expired, surviving }
}

// ─── Terminación de procesos compartidos ─────────────────────────────────────

export interface ProcessTerminationDecision {
  /** Paths cuyo FFmpeg debe terminarse: ya no queda ningún espectador válido. */
  terminate: string[]
  /** Paths que siguen vivos porque otro espectador con heartbeat fresco los usa. */
  keepAlive: Array<{ streamPath: string; remainingViewers: number }>
}

/**
 * PURA. Dado el conjunto de sesiones que vencen y el que sobrevive, decide qué
 * procesos FFmpeg terminar.
 *
 * REGLA CENTRAL: varias sesiones pueden compartir el mismo proceso/perfil. Que
 * venza una NO puede matar el proceso mientras otro espectador con heartbeat
 * fresco lo siga usando. Sólo se termina cuando desaparece la última sesión
 * válida de ese `streamPath`.
 *
 * Sólo `main_h264` posee un FFmpeg propio; `sub` y `main` los sirve MediaMTX
 * bajo demanda y se apagan solos.
 */
export function decideProcessTermination(
  expired: SessionTruth[],
  surviving: SessionTruth[],
): ProcessTerminationDecision {
  const owners = (list: SessionTruth[], path: string) =>
    list.filter(s => s.streamType === 'main_h264' && s.streamPath === path).length

  const terminate: string[] = []
  const keepAlive: ProcessTerminationDecision['keepAlive'] = []
  const seen = new Set<string>()

  for (const s of expired) {
    if (s.streamType !== 'main_h264') continue
    if (seen.has(s.streamPath)) continue
    seen.add(s.streamPath)

    const remaining = owners(surviving, s.streamPath)
    if (remaining > 0) keepAlive.push({ streamPath: s.streamPath, remainingViewers: remaining })
    else terminate.push(s.streamPath)
  }

  return { terminate, keepAlive }
}

/**
 * PURA. ¿Puede este cierre actuar sobre la sesión que encontró?
 *
 * Es la primera decisión de `stopStream`, ANTES de marcar el cierre, de tocar
 * watermarks, de borrar la fila y de matar procesos.
 *
 * EL PROBLEMA QUE RESUELVE
 *
 * La identidad de una sesión es `(userId, viewId, cameraId, streamType)`, y esa
 * cuádrupla NO distingue dos solicitudes de arranque cuando el backend
 * redirige:
 *
 *   A pide `main`      → el backend crea `main_h264`
 *   B pide `main_h264` → misma cámara y vista; queda vigente y responde primero
 *   A responde tarde   → su descarte cierra `…:main_h264`, que ahora es de B
 *
 * Las defensas por orden no sirven acá: el DELETE de A saca su ticket al
 * CERRARSE, no al abrirse, así que es POSTERIOR al de B y pasa tanto el
 * watermark como `lastOwnerRequestSeq`. Lo único que separa a A de B es el
 * intento de arranque que cada una declaró.
 *
 * Sólo se exige para `stale_response`. Un cierre deliberado —transición, salida
 * de foco, desmontaje, TTL— cierra lo que haya en la ranura, que es justo lo
 * que se le pide, y conserva su comportamiento anterior.
 */
export type AttemptReleaseVerdict =
  /** Cierre deliberado: cierra la ranura entera, como siempre. */
  | { action: 'full_close' }
  /** No hay nada que hacer, y NADA puede tocarse. */
  | { action: 'ignored'; reason: 'missing_expected_id' | 'no_session' | 'attempt_not_registered' }
  /** El intento existía, pero quedan otros: se suelta sólo el suyo. */
  | { action: 'release_attempt'; attemptId: string; remaining: number }
  /** Era el último arrendamiento: se cierra la sesión y se evalúa el proceso. */
  | { action: 'close_session'; attemptId: string }

/**
 * PURA. Qué puede hacer un cierre por respuesta tardía.
 *
 * POR QUÉ ES UN CONJUNTO Y NO UN DUEÑO ÚNICO
 *
 * La versión anterior comparaba contra UN propietario que se reemplazaba con
 * cada arranque, decidiendo cuál era "más nuevo" por `ticket.seq`. Ese ticket
 * mide el orden de llegada al SERVIDOR, y no coincide con el orden lógico del
 * navegador cuando dos POST viajan a la vez:
 *
 *   el usuario inicia A y luego B;
 *   B llega primero y crea la sesión;
 *   A llega segundo, con ticket mayor, y le arrebataba la propiedad;
 *   A se descarta en el navegador y su `stale_response` coincidía…
 *   …y mataba la sesión y el FFmpeg que B seguía usando.
 *
 * Con arrendamientos no hay nada que arrebatar: cada arranque aceptado suma el
 * suyo, cada descarte suelta el suyo, y la sesión sólo cae cuando se suelta el
 * último. El ticket sigue sirviendo para los watermarks —orden de llegada, que
 * es lo que mide— pero no decide identidad lógica.
 */
export function decideAttemptRelease(args: {
  reason?: string
  staleReason: string
  expectedStartAttemptId?: string
  session?: { startAttemptIds?: ReadonlySet<string> } | null
}): AttemptReleaseVerdict {
  const isStale = args.reason === args.staleReason

  // La IDENTIDAD, no la razón, decide el modo. Un cierre que declara un
  // `expectedStartAttemptId` —sea una respuesta tardía o un retry deliberado de
  // `exit_focus`/`switch_to_sub`— sólo puede soltar ESE arrendamiento. Ésa es la
  // guarda que impide que el retry de A cierre una sesión B abierta después
  // sobre la misma cámara/tipo: no alcanzaba con proteger `stale_response`.
  if (!args.expectedStartAttemptId) {
    // Sin identidad: una respuesta tardía no puede probar pertenencia y se
    // rechaza; un cierre deliberado a granel (transición, desmontaje) que no
    // rastrea intentos cierra la ranura entera, como siempre.
    return isStale
      ? { action: 'ignored', reason: 'missing_expected_id' }
      : { action: 'full_close' }
  }

  if (!args.session) return { action: 'ignored', reason: 'no_session' }

  const leases = args.session.startAttemptIds
  if (!leases || !leases.has(args.expectedStartAttemptId)) {
    return { action: 'ignored', reason: 'attempt_not_registered' }
  }
  const attemptId = args.expectedStartAttemptId
  const remaining = leases.size - 1
  return remaining > 0
    ? { action: 'release_attempt', attemptId, remaining }
    : { action: 'close_session', attemptId }
}

/**
 * PURA. ¿Puede un cierre por respuesta tardía BORRAR la sesión?
 *
 * Es la segunda mitad de `decideAttemptRelease`, y existe porque la protección
 * general por ticket —`resolveDeletable`— no sabe distinguir dos cosas muy
 * distintas que ambas elevan `lastOwnerRequestSeq`:
 *
 *   · un arranque NUEVO, que es una intención lógica nueva del navegador;
 *   · un heartbeat de grilla, que sólo dice "sigo mirando".
 *
 * Con esa confusión aparecía la fuga: existía `main_h264` con un único
 * arrendamiento A; el DELETE de A sacaba su ticket y se demoraba; un
 * `reconcileView` posterior tocaba la sesión y subía la marca; al reanudarse, el
 * cierre encontraba `reaffirmed_by_newer_request` y devolvía `ignored`. A seguía
 * en la lista, la sesión viva y su FFmpeg corriendo — sin nadie mirándola.
 *
 * La señal correcta no es el ticket sino el propio conjunto de arrendamientos:
 * un arranque nuevo SIEMPRE agrega el suyo, y una sesión reabierta llega con
 * otra generación. Un heartbeat no hace ninguna de las dos cosas. Así que basta
 * releer la fila y comprobar que sigue siendo la misma sesión y que A sigue
 * siendo su único arrendamiento.
 */
export type StaleDeleteVerdict =
  | { deletable: true }
  | {
      deletable: false
      reason: 'already_gone' | 'replaced_by_newer_generation' | 'attempt_gone' | 'other_leases'
      /** Arrendamientos que quedaron, cuando los hay. */
      remaining?: number
    }

export function decideStaleSessionDelete(args: {
  /** Arrendamiento que pide el cierre. */
  attemptId: string
  /** Generación de la sesión sobre la que se decidió el veredicto. */
  expectedGeneration: number
  /** Fila RELEÍDA del mapa, justo antes de borrar. */
  current?: { generation: number; startAttemptIds: ReadonlySet<string> } | null
}): StaleDeleteVerdict {
  if (!args.current) return { deletable: false, reason: 'already_gone' }

  // Otra sesión ocupa la ranura: eso sí es algo genuinamente nuevo.
  if (args.current.generation !== args.expectedGeneration) {
    return { deletable: false, reason: 'replaced_by_newer_generation' }
  }

  const leases = args.current.startAttemptIds
  // El arrendamiento se soltó por otro camino mientras tanto.
  if (!leases.has(args.attemptId)) return { deletable: false, reason: 'attempt_gone' }

  // Apareció otro espectador lógico: se suelta el propio, no se cierra la
  // sesión. Un heartbeat no puede producir esta rama.
  if (leases.size > 1) {
    return { deletable: false, reason: 'other_leases', remaining: leases.size - 1 }
  }
  return { deletable: true }
}

export interface StopTerminationDecision {
  /** ¿La razón del cierre autoriza terminar el proceso? */
  shouldKill: boolean
  /** Refcount: qué paths quedan sin dueño y cuáles siguen usándose. */
  processes: ProcessTerminationDecision
  /** Lo que realmente hay que matar: autorización Y ausencia de dueños. */
  terminate: string[]
}

/**
 * PURA. Decisión completa de un cierre explícito: ¿se termina el FFmpeg?
 *
 * Combina las DOS condiciones que estaban escritas sueltas en `stopStream`:
 *
 *   · la razón del cierre autoriza matar (un fallo transitorio no lo hace: el
 *     próximo arranque reutiliza el proceso vivo), y
 *   · no queda ningún otro espectador sobre el mismo `streamPath`.
 *
 * Vive acá para poder ejecutarla: el contrato de razones con el frontend es
 * exactamente lo que falló —`viewport_changed` no estaba en el conjunto y la
 * sesión se borraba dejando el proceso corriendo— y una condición que no se
 * puede ejecutar en una prueba es una condición que nadie verifica.
 */
export function decideStopTermination(args: {
  streamType: StreamType
  reason?: string
  killReasons: ReadonlySet<string>
  /** La sesión que se está cerrando. */
  expired: SessionTruth[]
  /** Todas las demás sesiones vivas. */
  surviving: SessionTruth[]
}): StopTerminationDecision {
  // Sin razón declarada se mata: es el cierre por defecto (desmontaje, TTL).
  const shouldKill = !args.reason || args.killReasons.has(args.reason)
  const processes = decideProcessTermination(args.expired, args.surviving)
  return {
    shouldKill,
    processes,
    terminate: shouldKill ? processes.terminate : [],
  }
}

// ─── Autorización de reinicio del supervisor ─────────────────────────────────

/**
 * PURA. ¿Queda algún espectador REAL sobre este `streamPath`?
 *
 * El supervisor de FFmpeg usaba `lastMediaActivity` para decidir si valía la
 * pena re-spawnear tras una caída. Eso contradice la regla del módulo: la
 * actividad de medio es diagnóstico y no prueba que haya nadie mirando, así que
 * podía resucitar un proceso sin propietario — la misma sesión fantasma que A1
 * debía eliminar, por otra puerta.
 *
 * Un reinicio sólo se autoriza con una sesión de heartbeat de cliente FRESCO.
 * El caso del arranque en vuelo lo evalúa el llamador, que es quien conoce el
 * estado de `transcodeInFlight`.
 */
export function hasFreshClientViewer(input: {
  sessions: SessionTruth[]
  streamPath: string
  nowMs: number
  ttl: SessionTtl
}): boolean {
  const { sessions, streamPath, nowMs, ttl } = input
  return sessions.some(s =>
    s.streamPath === streamPath &&
    nowMs - s.lastClientHeartbeatMs <= ttlForStreamType(s.streamType, ttl)
  )
}

// ─── Índices auxiliares ──────────────────────────────────────────────────────

/**
 * PURA. Índices auxiliares que quedan sin dueño tras eliminar sesiones. Sin
 * esta poda, un `viewCameras` huérfano vuelve a aparecer como demanda en el
 * monitor de pipeline aunque la sesión ya no exista.
 */
export function orphanViewKeys(input: {
  /** Todas las claves `${userId}:${viewId}` con índice auxiliar registrado. */
  knownViewKeys: string[]
  /** Sesiones que siguen vivas después de la limpieza. */
  surviving: SessionTruth[]
  viewHeartbeats: Map<string, number>
  nowMs: number
  ttl: SessionTtl
}): string[] {
  const { knownViewKeys, surviving, viewHeartbeats, nowMs, ttl } = input
  const alive = new Set(surviving.map(s => `${s.userId}:${s.viewId}`))
  return knownViewKeys.filter(vk => {
    if (alive.has(vk)) return false
    const beat = viewHeartbeats.get(vk)
    // Un view sin sesiones pero con heartbeat fresco es una grilla recién
    // montada que todavía no arrancó cámaras: no es huérfano.
    if (beat != null && nowMs - beat <= ttl.standardTtlMs) return false
    return true
  })
}
