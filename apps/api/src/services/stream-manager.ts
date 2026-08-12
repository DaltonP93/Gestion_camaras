// Stream Manager — controla sesiones de viewers y libera streams sin uso
// Los streams en MediaMTX ya tienen sourceOnDemand: true (se conectan solos cuando hay requests HLS)
// Este manager trackea quién está mirando para informar al frontend y aplicar límites.
import type { FastifyInstance } from 'fastify'
import type { ChildProcess } from 'child_process'
import { getStreamPath, getHlsUrl, getWebRtcUrl, publishStream, removeStream, getStreamStatus, publishTranscodedStream, getTranscodedStreamPath, isTranscodingEnabled, getFfmpegCapabilities, waitForHlsReady, spawnTranscodeProcess, stopTranscodeProcess, isTranscodeProcessAlive, getTranscodeStderr, getStreamDetails, getActiveTranscodesList, getTranscodeRawStderr, getTranscodeRtspMasked } from './stream'
import type { NVR, Camera } from '@prisma/client'
import { decryptNvrPassword as decryptPass } from './credentials'
import { resolveGridProfile } from './transcode-profile'
import {
  getSessionTtl, decideSessionExpiry, decideProcessTermination, orphanViewKeys,
  hasFreshClientViewer,
  type SessionTruth, type SessionTtl,
} from './session-lifecycle'

// Límites configurables
const MAX_STREAMS_PER_USER   = Number(process.env.MAX_STREAMS_PER_USER   || 32)
const MAX_STREAMS_GLOBAL     = Number(process.env.MAX_STREAMS_GLOBAL     || 50)
// TTL de sesiones: lo resuelve session-lifecycle (fuente única, con normalización
// y log de los valores EFECTIVOS). STREAM_IDLE_TIMEOUT se conserva sólo como
// compatibilidad para los llamadores que reportan el umbral en segundos.
const STREAM_IDLE_TIMEOUT    = Number(process.env.STREAM_IDLE_TIMEOUT    || 90)  // segundos
export const MAX_TRANSCODE_SESSIONS = Number(process.env.MAX_TRANSCODE_SESSIONS || 2)
// How long to wait for HLS manifest after FFmpeg starts (default 60s to allow first segment)
const TRANSCODE_HLS_READY_TIMEOUT_MS = Number(process.env.TRANSCODE_HLS_READY_TIMEOUT_MS || 60_000)

// Health statuses that unconditionally block all stream requests
// (USING_MAIN_STREAM and CODEC_UNSUPPORTED_HEVC are handled by codec redirect logic instead)
const BLOCKED_HEALTH_STATUSES = new Set([
  'RTSP_SUB_NOT_FOUND',
  'AUTH_FAILED',
  'OFFLINE',
])

// Per-path in-flight transcode state — prevents duplicate FFmpeg startups
// during the waitForHlsReady window (heartbeat can fire multiple times during 10s wait).
// Key: streamPath (e.g. nvr_xxx_ch09_main_h264)
interface TranscodeInFlight {
  state: 'starting' | 'ready' | 'failed'
  promise: Promise<boolean>        // resolves true=ready, false=failed
  resolve: (v: boolean) => void    // called by the starter when done
}
const transcodeInFlight = new Map<string, TranscodeInFlight>()

// ─── Auto-restart supervisor state ──────────────────────────────────────────
// Tracks restart history per stream path and source info needed to re-spawn FFmpeg.

interface TranscodeRestartInfo {
  count:          number       // restarts performed within current window
  windowStart:    number       // ms — window resets if >2 min has passed since last restart
  lastExitCode:   number | null
  lastExitReason: string       // e.g. 'RTSP_INPUT_EOF', 'exit_224', 'sig_SIGKILL'
  lastExitAt:     number       // ms timestamp
}

interface TranscodeSourceRef {
  nvr:      any               // NVR with decrypted password — needed for FFmpeg restart
  camera:   any
  userId:   string
  cameraId: string
}

const transcodeRestarts   = new Map<string, TranscodeRestartInfo>()
const transcodeSourceInfo = new Map<string, TranscodeSourceRef>()
// DIAGNÓSTICO ÚNICAMENTE. Última actividad de MEDIO observada sobre este path.
// NO es un heartbeat y NO puede mantener viva una sesión de usuario: que el medio
// se mueva sólo prueba que FFmpeg tira del RTSP, no que alguien esté mirando.
// Antes se llamaba lastMediaActivity y sí participaba en la decisión de
// vigencia; ese uso fue eliminado (ver session-lifecycle.ts).
const lastMediaActivity      = new Map<string, number>()  // ms
const SUPERVISOR_GRACE_MS    = 60_000  // restart if viewer was active within this window

const SUPERVISOR_MAX_RESTARTS = 3
const SUPERVISOR_WINDOW_MS    = 2 * 60_000          // 2 minutes
const SUPERVISOR_BACKOFFS     = [2_000, 5_000, 10_000] as const

// Reasons that explicitly allow FFmpeg to be killed when stopping a main_h264 session.
// Any other reason (e.g. 'retry', 'hls_error') keeps FFmpeg alive so the next startStream
// call can detect the live process via isTranscodeProcessAlive and reuse it.
const TRANSCODE_KILL_REASONS = new Set([
  'exit_focus', 'switch_to_sub', 'cleanup_unmount', 'idle_timeout',
  'force_stop', 'logout', 'session_cleanup', 'viewport_change',
  'layout_change', 'nvr_change', 'page_change', 'stop_all',
  'exit_fullscreen',
])

// Desglose de cupos de transcodificación: activos (sesiones main_h264 registradas),
// iniciando (paths en waitForHlsReady aún sin registrar) y total (lo que cuenta contra
// el límite). Expuesto para el diagnóstico ADMIN y el contrato de TRANSCODE_LIMIT_REACHED.
export function getTranscodeCounts(): { active: number; starting: number; total: number; max: number } {
  const active   = Array.from(sessions.values()).filter(s => s.streamType === 'main_h264').length
  const starting = Array.from(transcodeInFlight.values()).filter(f => f.state === 'starting').length
  return { active, starting, total: active + starting, max: MAX_TRANSCODE_SESSIONS }
}

function getActiveTranscodeCount(): number {
  return getTranscodeCounts().total
}

interface StreamSession {
  cameraId: string
  userId: string
  viewId: string                  // identificador de pestaña/view del navegador
  streamType: 'sub' | 'main' | 'main_h264'  // sub=grid H264, main=HD (puede HEVC), main_h264=transcodificado
  streamPath: string
  startedAt: Date
  /**
   * ÚNICA evidencia de que hay un espectador. Hora del SERVIDOR al recibir
   * actividad explícita de un cliente autenticado (touchSession/touchView/
   * reconcileView). Jamás se deriva de un timestamp enviado por el navegador,
   * ni del proceso FFmpeg, ni de la actividad de medio.
   */
  lastClientHeartbeat: Date
  /**
   * Generación de la sesión. Se incrementa en cada apertura, de modo que un
   * heartbeat en vuelo emitido antes de un cierre no pueda resucitar la sesión
   * ya cerrada (ni volver a levantar su FFmpeg sin espectador).
   */
  generation: number
}

// Contador monótono de generaciones. Una sesión reabierta sobre la misma clave
// recibe una generación mayor; todo lo emitido contra la anterior es tardío.
let sessionGenerationCounter = 0
function nextGeneration(): number {
  sessionGenerationCounter += 1
  return sessionGenerationCounter
}

// En memoria — se pierde al reiniciar (intencional: el frontend reconecta)
// key: `${userId}:${cameraId}:${streamType}` — permite sub y main simultáneos
const sessions = new Map<string, StreamSession>()

// Per-view tracking: qué cámaras pertenecen a qué view (solo sub streams — main es explícito)
const viewCameras   = new Map<string, Set<string>>() // key: `${userId}:${viewId}`
const viewHeartbeat = new Map<string, Date>()         // key: `${userId}:${viewId}` → last heartbeat

// La PERTENENCIA de una sesión es (usuario, pestaña). Antes la clave era
// `userId:cameraId:streamType`, con lo que dos pestañas del mismo usuario
// viendo la misma cámara con el mismo tipo colapsaban en UNA fila: la segunda
// se apropiaba de la primera reescribiendo su viewId, y cerrar en una cerraba
// la de la otra. El proceso FFmpeg se sigue compartiendo por `streamPath`
// (eso lo resuelve decideProcessTermination), pero la fila es de cada pestaña.
// Parámetros NOMBRADOS a propósito: la firma anterior era (userId, cameraId,
// streamType), todos string, así que agregar viewId posicionalmente habría
// compilado sin error en cada llamador mientras construía claves equivocadas.
function sessionKey(k: {
  userId: string
  viewId: string
  cameraId: string
  streamType: 'sub' | 'main' | 'main_h264'
}) {
  return `${k.userId}::${k.viewId}::${k.cameraId}::${k.streamType}`
}

/** viewId por defecto cuando un llamador antiguo no lo envía. */
const DEFAULT_VIEW_ID = 'default'

/**
 * Resuelve a qué sesión se refiere una petición que NO trae viewId.
 *
 * Una pestaña no puede tocar ni cerrar la sesión de otra pestaña del mismo
 * usuario. Si hay ambigüedad (varias pestañas con esa cámara y tipo), la
 * petición se rechaza en vez de elegir una al azar.
 */
function resolveOwnedSessionKey(
  userId: string,
  viewId: string | undefined,
  cameraId: string,
  streamType: 'sub' | 'main' | 'main_h264',
): { key: string | null; ambiguous: boolean } {
  if (viewId) return { key: sessionKey({ userId, viewId, cameraId, streamType }), ambiguous: false }
  const matches = Array.from(sessions.entries()).filter(([, s]) =>
    s.userId === userId && s.cameraId === cameraId && s.streamType === streamType)
  if (matches.length === 1) return { key: matches[0][0], ambiguous: false }
  return { key: null, ambiguous: matches.length > 1 }
}

function vKey(userId: string, viewId: string) {
  return `${userId}:${viewId}`
}

export function getActiveSessions(): StreamSession[] {
  return Array.from(sessions.values())
}

export function getSessionsForUser(userId: string): StreamSession[] {
  return Array.from(sessions.values()).filter(s => s.userId === userId)
}

// ─── Test seams ───────────────────────────────────────────────────────────────
// Exclusivos para tests unitarios del ciclo de vida de sesiones (poblar el mapa
// sin prisma/MediaMTX). No usar en runtime.
export function __seedSessionForTest(s: {
  cameraId: string; userId: string; viewId: string
  streamType: 'sub' | 'main' | 'main_h264'; streamPath: string
  startedAt: Date; lastClientHeartbeat: Date; generation?: number
}): void {
  sessions.set(sessionKey({ userId: s.userId, viewId: s.viewId, cameraId: s.cameraId, streamType: s.streamType }), {
    ...s, generation: s.generation ?? nextGeneration(),
  })
  if (s.streamType === 'sub') {
    const vk = vKey(s.userId, s.viewId)
    if (!viewCameras.has(vk)) viewCameras.set(vk, new Set())
    viewCameras.get(vk)!.add(s.cameraId)
  }
}
export function __setViewHeartbeatForTest(userId: string, viewId: string, at: Date): void {
  viewHeartbeat.set(vKey(userId, viewId), at)
}
/** Sólo tests: marca actividad de MEDIO (que NO debe mantener viva una sesión). */
export function __setMediaActivityForTest(streamPath: string, atMs: number): void {
  lastMediaActivity.set(streamPath, atMs)
}
export function __resetSessionsForTest(): void {
  sessions.clear()
  lastMediaActivity.clear()
  viewCameras.clear()
  viewHeartbeat.clear()
}

// ─── Purga liviana de sesiones vencidas ──────────────────────────────────────
// El límite global (MAX_STREAMS_GLOBAL) se rechazaba contando TODAS las sesiones
// en memoria, incluidas las que quedaron huérfanas por pestañas cerradas, recargas,
// errores HLS o cambios de vista cuyo heartbeat ya venció. Eso hacía que sessions.size
// llegara al tope sin que hubiera esa cantidad de cámaras realmente visibles.
//
// Esta función elimina de forma síncrona (sin tocar MediaMTX — de eso se encarga el
// cron cleanupIdleSessions) las sesiones cuyo heartbeat de CLIENTE venció, y se
// llama ANTES de evaluar el límite global.
//
// CAMBIO A1: antes conservaba sesiones main_h264 cuyo FFmpeg siguiera vivo o con
// actividad de medio reciente. Esa excepción convertía al proceso en su propio
// justificante y hacía inmortal la sesión. Ahora la vigencia la decide sólo el
// heartbeat de cliente; el proceso se termina cuando ya no queda ningún
// espectador válido sobre su path.
export function pruneStaleSessions(): number {
  const nowMs = Date.now()
  const ttl = getSessionTtl(msg => console.info(msg))
  const { expired, surviving } = decideSessionExpiry({
    sessions: toSessionTruths(),
    viewHeartbeats: viewHeartbeatsAsMs(),
    nowMs,
    ttl,
  })
  if (expired.length === 0) return 0

  const termination = decideProcessTermination(expired.map(e => e.session), surviving)

  for (const { session, reason, clientHeartbeatAgeMs } of expired) {
    const vk = vKey(session.userId, session.viewId)
    if (session.streamType === 'sub') viewCameras.get(vk)?.delete(session.cameraId)
    sessions.delete(session.key)
    console.info(
      `[stream-manager] view_session_expired cameraId=${session.cameraId}` +
      ` streamType=${session.streamType} viewId=${session.viewId}` +
      ` reason=${reason} clientHeartbeatAgeMs=${clientHeartbeatAgeMs}` +
      ` generation=${session.generation}`
    )
  }

  terminateProcesses(termination, 'prune_stale')
  pruneOrphanViewIndexes(surviving, nowMs, ttl)

  console.info(`[stream-manager] pruned_stale_sessions count=${expired.length}`)
  return expired.length
}

// ─── Puentes entre el estado en memoria y el módulo PURO ─────────────────────

/** Proyección del mapa de sesiones a la forma que consume session-lifecycle. */
function toSessionTruths(): SessionTruth[] {
  return Array.from(sessions.entries()).map(([key, s]) => ({
    key,
    userId: s.userId,
    viewId: s.viewId,
    cameraId: s.cameraId,
    streamType: s.streamType,
    streamPath: s.streamPath,
    lastClientHeartbeatMs: s.lastClientHeartbeat.getTime(),
    generation: s.generation,
  }))
}

/** Proyección de UNA sesión (ya sacada del mapa) a la forma pura. */
function sessionTruthOf(key: string, s: StreamSession): SessionTruth {
  return {
    key,
    userId: s.userId,
    viewId: s.viewId,
    cameraId: s.cameraId,
    streamType: s.streamType,
    streamPath: s.streamPath,
    lastClientHeartbeatMs: s.lastClientHeartbeat.getTime(),
    generation: s.generation,
  }
}

function viewHeartbeatsAsMs(): Map<string, number> {
  const out = new Map<string, number>()
  for (const [vk, at] of viewHeartbeat.entries()) out.set(vk, at.getTime())
  return out
}

/**
 * Aplica la decisión de terminación. Idempotente: `stopTranscodeProcess` tolera
 * un path ya detenido, y los índices se borran con `delete` (no-op si no están).
 */
function terminateProcesses(
  decision: { terminate: string[]; keepAlive: Array<{ streamPath: string; remainingViewers: number }> },
  reason: string,
): void {
  for (const { streamPath, remainingViewers } of decision.keepAlive) {
    console.info(
      `[stream-manager] transcode_keepalive path=${streamPath}` +
      ` remainingViewers=${remainingViewers} reason=${reason}`
    )
  }
  for (const streamPath of decision.terminate) {
    stopTranscodeProcess(streamPath)
    transcodeInFlight.delete(streamPath)
    transcodeRestarts.delete(streamPath)
    transcodeSourceInfo.delete(streamPath)
    lastMediaActivity.delete(streamPath)
    console.info(`[stream-manager] transcode_killed path=${streamPath} reason=${reason}_refcount_zero`)
  }
}

/** Poda de índices auxiliares sin dueño (si no, reaparecen como demanda). */
function pruneOrphanViewIndexes(surviving: SessionTruth[], nowMs: number, ttl: SessionTtl): void {
  const knownViewKeys = new Set<string>([...viewCameras.keys(), ...viewHeartbeat.keys()])
  const orphans = orphanViewKeys({
    knownViewKeys: [...knownViewKeys],
    surviving,
    viewHeartbeats: viewHeartbeatsAsMs(),
    nowMs,
    ttl,
  })
  for (const vk of orphans) {
    viewCameras.delete(vk)
    viewHeartbeat.delete(vk)
  }
}

// ─── Contadores rodantes de resultados de start-stream (últimos 15 min) ─────
// Para diagnosticar por qué a un usuario "solo le abren N cámaras": cuántos
// start-stream fueron aceptados, rechazados por límite, rechazados por permiso
// o fallaron por otra causa, con desglose por código de error. En memoria,
// se pierde al reiniciar (intencional — es diagnóstico operativo).
export type StreamOutcome = 'accepted' | 'rejected_limit' | 'rejected_permission' | 'failed_other'

interface OutcomeEvent {
  at: number            // ms epoch
  outcome: StreamOutcome
  code?: string         // código de error (p.ej. STREAM_LIMIT_REACHED, NO_PERMISSION)
}

const OUTCOME_WINDOW_MS = 15 * 60_000
const startOutcomes = new Map<string, OutcomeEvent[]>()  // key: userId

function pruneOutcomes(events: OutcomeEvent[]): OutcomeEvent[] {
  const cutoff = Date.now() - OUTCOME_WINDOW_MS
  return events.filter(e => e.at >= cutoff)
}

export function recordStreamOutcome(userId: string, outcome: StreamOutcome, code?: string): void {
  const events = pruneOutcomes(startOutcomes.get(userId) ?? [])
  events.push({ at: Date.now(), outcome, code })
  startOutcomes.set(userId, events)
}

// Códigos que cuentan como "rechazado por límite" en los contadores.
const LIMIT_ERROR_CODES = new Set(['STREAM_LIMIT_REACHED', 'STREAM_LIMIT_GLOBAL', 'TRANSCODE_LIMIT_REACHED'])

// Clasifica y registra el resultado de un startStream según su error (o éxito).
// Punto único de registro — lo usan tanto el handler HTTP como reconcileView
// (vía el wrapper startStream), así los heartbeats que recrean sesiones podadas
// o chocan con límites también quedan contabilizados.
function recordStartResult(userId: string, error?: { code: string } | null): void {
  // Una cancelación por cierre de pestaña no es un resultado del arranque: no
  // cuenta como aceptado ni como fallo. Contarla como `failed_other` ensuciaría
  // el diagnóstico de "por qué a este usuario sólo le abren N cámaras".
  if (error?.code === 'VIEW_CLOSED') return
  if (!error) {
    recordStreamOutcome(userId, 'accepted')
  } else {
    recordStreamOutcome(userId, LIMIT_ERROR_CODES.has(error.code) ? 'rejected_limit' : 'failed_other', error.code)
  }
}

export interface StreamOutcomeCounters {
  windowMs:           number
  accepted:           number
  rejectedLimit:      number
  rejectedPermission: number
  failedOther:        number
  byCode:             Record<string, number>  // conteo por código de error
}

export function getStreamOutcomeCounters(userId: string): StreamOutcomeCounters {
  const events = pruneOutcomes(startOutcomes.get(userId) ?? [])
  // No dejar claves vacías en el índice — un usuario sin eventos vigentes
  // no debe seguir apareciendo en getUserIdsWithOutcomes para siempre.
  if (events.length === 0) startOutcomes.delete(userId)
  else startOutcomes.set(userId, events)
  const byCode: Record<string, number> = {}
  for (const e of events) {
    if (e.code) byCode[e.code] = (byCode[e.code] ?? 0) + 1
  }
  return {
    windowMs:           OUTCOME_WINDOW_MS,
    accepted:           events.filter(e => e.outcome === 'accepted').length,
    rejectedLimit:      events.filter(e => e.outcome === 'rejected_limit').length,
    rejectedPermission: events.filter(e => e.outcome === 'rejected_permission').length,
    failedOther:        events.filter(e => e.outcome === 'failed_other').length,
    byCode,
  }
}

export function getUserIdsWithOutcomes(): string[] {
  // Podar el índice completo y eliminar claves sin eventos vigentes — evita
  // reportar usuarios "fantasma" (todo expirado) y las consultas de permisos
  // que cada uno costaría en el endpoint de diagnóstico.
  for (const [uid, events] of startOutcomes.entries()) {
    const pruned = pruneOutcomes(events)
    if (pruned.length === 0) startOutcomes.delete(uid)
    else startOutcomes.set(uid, pruned)
  }
  return Array.from(startOutcomes.keys())
}

// Seam de tests: limpiar los contadores rodantes.
export function __resetOutcomesForTest(): void {
  startOutcomes.clear()
}

// Timeout efectivo de expiración de sesiones (mismo umbral que usa
// pruneStaleSessions/cleanupIdleSessions) — en ms, para que el diagnóstico
// marque como "huérfana" exactamente lo que la limpieza real consideraría vencido.
export function getStreamIdleTimeoutMs(): number {
  return getSessionTtl().standardTtlMs
}

/** Timeout efectivo de sesiones HD/transcodificadas (ms). */
export function getStreamHdIdleTimeoutMs(): number {
  return getSessionTtl().hdTtlMs
}

// ─── Guarda contra respuestas tardías ────────────────────────────────────────
// Un heartbeat puede estar EN VUELO cuando el usuario cierra la pestaña o cambia
// de cámara. Si el servidor lo procesa después del cierre, recrearía la sesión y
// volvería a levantar FFmpeg sin espectador. Se registra el instante del cierre
// explícito de cada view y se descarta toda actividad recibida ANTES de él.
const viewClosedAt = new Map<string, number>()
// Cierres de UNA cámara concreta dentro de un view. Clave: la clave de sesión.
const targetClosedAt = new Map<string, number>()
const CLOSED_VIEW_MEMORY_MS = 5 * 60_000

/**
 * Arranques EN VUELO por `streamPath`, con su dueño y el instante en que llegó
 * la petición. Permite saber si un arranque quedó huérfano porque su pestaña se
 * cerró mientras corrían las operaciones asíncronas (DB, publishStream,
 * waitForHlsReady…), que es la ventana por la que todavía podía nacer una
 * sesión fantasma (revisión de #146).
 */
interface InFlightStart {
  userId: string
  viewId: string
  cameraId: string
  streamType: 'sub' | 'main' | 'main_h264'
  receivedAtMs: number
}
const inFlightStarts = new Map<string, InFlightStart>()

/**
 * Cuántas peticiones están ESPERANDO el arranque compartido de cada path.
 *
 * Si el iniciador cierra su pestaña pero el medio ya arrancó bien, el proceso
 * NO puede derribarse: hay espectadores válidos aguardando para adoptarlo. Sin
 * este contador, la cancelación del iniciador resolvía el single-flight en
 * `false` y los que esperaban recibían TRANSCODE_NOT_READY sobre un FFmpeg
 * perfectamente sano (revisión de #147).
 */
const transcodeWaiters = new Map<string, number>()

function addWaiter(streamPath: string): void {
  transcodeWaiters.set(streamPath, (transcodeWaiters.get(streamPath) ?? 0) + 1)
}
function removeWaiter(streamPath: string): void {
  const n = (transcodeWaiters.get(streamPath) ?? 1) - 1
  if (n > 0) transcodeWaiters.set(streamPath, n)
  else transcodeWaiters.delete(streamPath)
}
function hasWaiters(streamPath: string): boolean {
  return (transcodeWaiters.get(streamPath) ?? 0) > 0
}

/**
 * Elimina TODAS las sesiones que apuntan a un `streamPath` cuyo proceso ya no
 * puede sostenerse. Con la clave por pestaña, un mismo path puede tener varias
 * filas (una por viewer): borrar sólo la del `sourceRef` dejaría las demás
 * apuntando a un proceso muerto.
 */
function dropSessionsByStreamPath(streamPath: string, reason: string): void {
  for (const [key, s] of Array.from(sessions.entries())) {
    if (s.streamPath !== streamPath) continue
    sessions.delete(key)
    console.info(
      `[stream-manager] view_session_closed cameraId=${s.cameraId} streamType=${s.streamType}` +
      ` viewId=${s.viewId} generation=${s.generation} reason=${reason}`
    )
  }
}

/**
 * Deshace lo que un arranque abortado alcanzó a crear, SIN tocar lo que otro
 * espectador válido siga usando.
 *
 * Reglas: no matar un proceso compartido con otro viewer fresco, no dejar
 * `transcodeInFlight` colgado, y sólo retirar el path de MediaMTX si ninguna
 * sesión de nadie apunta a esa cámara.
 */
async function releaseUnownedStream(
  server: FastifyInstance,
  cameraId: string,
  streamPath: string,
  reason: string,
): Promise<void> {
  inFlightStarts.delete(streamPath)
  transcodeInFlight.delete(streamPath)

  const survivors = toSessionTruths()
  const stillOwned = survivors.some(s => s.streamPath === streamPath) || hasWaiters(streamPath)
  if (stillOwned) {
    console.info(`[live] start_aborted_keepalive path=${streamPath} reason=${reason} — otro viewer lo usa`)
    return
  }

  if (isTranscodeProcessAlive(streamPath)) {
    stopTranscodeProcess(streamPath)
    transcodeRestarts.delete(streamPath)
    transcodeSourceInfo.delete(streamPath)
    lastMediaActivity.delete(streamPath)
    console.info(`[stream-manager] transcode_killed path=${streamPath} reason=${reason}`)
  }

  // El path de MediaMTX sólo se retira si NINGUNA sesión mira esa cámara.
  if (survivors.some(s => s.cameraId === cameraId)) return
  const camera = await server.prisma.camera.findUnique({
    where: { id: cameraId }, include: { nvr: true },
  }).catch(() => null)
  if (camera?.nvr) removeStream(camera.nvr, camera).catch(() => {})
}

/** ¿El arranque en vuelo de este path perdió a su dueño? */
function isStartCancelled(streamPath: string): boolean {
  const st = inFlightStarts.get(streamPath)
  if (!st) return false
  return isTargetClosedAfter(st.userId, st.viewId, st.cameraId, st.streamType, st.receivedAtMs)
}

/**
 * Marca el cierre de TODO un view (pestaña). Reservado para
 * `cleanupUserSessions`: desmontaje, `pagehide`, cierre de la vista entera.
 *
 * NO debe usarse al cerrar una sola cámara. `stopStream` lo hacía, y como la
 * guarda de cancelación es por (usuario, view), cerrar la cámara A abortaba con
 * VIEW_CLOSED un arranque en vuelo de la cámara B de la misma grilla: cambiar
 * de cámara mataba el arranque de las demás (revisión de #147).
 */
export function markViewClosed(userId: string, viewId: string): void {
  const nowMs = Date.now()
  viewClosedAt.set(vKey(userId, viewId), nowMs)
  // Poda perezosa: no conservar cierres viejos para siempre.
  for (const [vk, at] of viewClosedAt.entries()) {
    if (nowMs - at > CLOSED_VIEW_MEMORY_MS) viewClosedAt.delete(vk)
  }
  for (const [k, at] of targetClosedAt.entries()) {
    if (nowMs - at > CLOSED_VIEW_MEMORY_MS) targetClosedAt.delete(k)
  }
}

/**
 * Marca el cierre de UNA cámara concreta de un view. Sólo cancela heartbeats y
 * arranques en vuelo de ESA cámara y tipo; el resto de la grilla sigue.
 */
function markTargetClosed(key: string): void {
  targetClosedAt.set(key, Date.now())
}

/**
 * ¿Esta petición quedó obsoleta por un cierre explícito posterior a su llegada?
 * `receivedAtMs` es la hora del SERVIDOR al recibir la petición, no un dato del
 * cliente.
 */
export function isViewClosedAfter(userId: string, viewId: string, receivedAtMs: number): boolean {
  const closedAt = viewClosedAt.get(vKey(userId, viewId))
  return closedAt !== undefined && closedAt >= receivedAtMs
}

/**
 * ¿Quedó obsoleta una petición para UNA cámara concreta? Cubre los dos niveles:
 * el cierre de la pestaña entera y el cierre puntual de esa cámara y tipo.
 */
export function isTargetClosedAfter(
  userId: string, viewId: string,
  cameraId: string, streamType: 'sub' | 'main' | 'main_h264',
  receivedAtMs: number,
): boolean {
  if (isViewClosedAfter(userId, viewId, receivedAtMs)) return true
  const closedAt = targetClosedAt.get(sessionKey({ userId, viewId, cameraId, streamType }))
  return closedAt !== undefined && closedAt >= receivedAtMs
}

/** Sólo tests: limpia la memoria de cierres. */
export function __resetClosedViewsForTest(): void {
  viewClosedAt.clear()
  targetClosedAt.clear()
}

// Límites efectivos resueltos (env → número) — para el endpoint de diagnóstico.
export function getStreamLimits(): { maxStreamsPerUser: number; maxStreamsGlobal: number; maxTranscodeSessions: number } {
  return {
    maxStreamsPerUser:    MAX_STREAMS_PER_USER,
    maxStreamsGlobal:     MAX_STREAMS_GLOBAL,
    maxTranscodeSessions: MAX_TRANSCODE_SESSIONS,
  }
}

// Conteos actuales de streams — expuestos al frontend para que muestre "X/Y" en el
// error de límite en vez de un mensaje genérico, y para el endpoint de diagnóstico.
export interface StreamCounts {
  currentGlobalStreams: number
  maxGlobalStreams:     number
  currentUserStreams:   number
  maxUserStreams:       number
}

export function getStreamCounts(userId: string): StreamCounts {
  const all = Array.from(sessions.values())
  return {
    currentGlobalStreams: all.length,
    maxGlobalStreams:     MAX_STREAMS_GLOBAL,
    currentUserStreams:   all.filter(s => s.userId === userId && s.streamType === 'sub').length,
    maxUserStreams:       MAX_STREAMS_PER_USER,
  }
}

// Tocar una sola sesión (backward compat para touch-stream endpoint individual).
//
// `receivedAtMs` es la hora del SERVIDOR al recibir la petición. Se usa para
// descartar heartbeats en vuelo que llegan después de un cierre explícito: sin
// esa guarda, una respuesta tardía resucitaría una sesión ya cerrada.
export function touchSession(
  userId: string,
  cameraId: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
  receivedAtMs: number = Date.now(),
  viewId?: string,
) {
  // Sin viewId la pertenencia es ambigua. Se resuelve sólo si el usuario tiene
  // EXACTAMENTE una sesión para esa cámara y tipo; con dos pestañas abiertas se
  // rechaza, porque una pestaña no puede tocar la sesión de la otra.
  const { key, ambiguous } = resolveOwnedSessionKey(userId, viewId, cameraId, streamType)
  if (ambiguous) {
    console.info(
      `[stream-manager] touch_ignored_ambiguous cameraId=${cameraId} streamType=${streamType}` +
      ` reason=multiple_views_without_viewId`
    )
    return
  }
  if (!key) return
  const s = sessions.get(key)
  if (!s) return                                    // sesión inexistente: nada que resucitar
  if (isTargetClosedAfter(userId, s.viewId, cameraId, streamType, receivedAtMs)) {
    console.info(
      `[stream-manager] heartbeat_ignored_stale cameraId=${cameraId}` +
      ` streamType=${streamType} viewId=${s.viewId} reason=closed_after_request`
    )
    return
  }
  // Hora del SERVIDOR, nunca un timestamp enviado por el navegador.
  s.lastClientHeartbeat = new Date()
}

// Tocar todas las sesiones de un view de una vez — toca sub, main y main_h264
// para que el idle cleanup no mate streams HD durante un heartbeat legítimo.
export function touchView(userId: string, viewId: string, receivedAtMs: number = Date.now()) {
  if (isViewClosedAfter(userId, viewId, receivedAtMs)) {
    console.info(`[stream-manager] heartbeat_ignored_stale viewId=${viewId} reason=view_closed_after_request`)
    return
  }
  const vk = vKey(userId, viewId)
  viewHeartbeat.set(vk, new Date())
  const vCams = viewCameras.get(vk)
  if (!vCams) return
  const now = new Date()
  for (const cameraId of vCams) {
    for (const st of ['sub', 'main', 'main_h264'] as const) {
      const s = sessions.get(sessionKey({ userId, viewId, cameraId, streamType: st }))
      if (s) s.lastClientHeartbeat = now
    }
  }
}

/**
 * Registra actividad de MEDIO sobre un path. Es DIAGNÓSTICO: no prolonga la
 * vigencia de ninguna sesión. Se conserva porque el supervisor de reinicio lo
 * usa para decidir si vale la pena re-spawnear FFmpeg tras una caída.
 */
export function recordMediaActivity(streamPath: string): void {
  lastMediaActivity.set(streamPath, Date.now())
}

// ─── Transcode supervisor ────────────────────────────────────────────────────
// When FFmpeg exits unexpectedly and a session is still active, this supervisor
// automatically restarts it with exponential backoff (2s/5s/10s).
// After SUPERVISOR_MAX_RESTARTS in a 2-minute window it gives up and marks the
// session failed so the frontend shows a permanent error instead of looping.

function attachTranscodeSupervisor(
  streamPath: string,
  proc: ChildProcess,
  sourceRef: TranscodeSourceRef,
): void {
  proc.once('exit', (code, signal) => {
    const stderr     = getTranscodeRawStderr(streamPath)
    const isEof      = stderr.includes('End of file') || stderr.includes('Failed reading RTSP data')
    const exitReason = isEof ? 'RTSP_INPUT_EOF'
      : code !== null ? `exit_${code}`
      : `sig_${signal}`
    void runTranscodeSupervisor(streamPath, sourceRef, code, signal, exitReason)
  })
}

async function runTranscodeSupervisor(
  streamPath: string,
  sourceRef: TranscodeSourceRef,
  exitCode: number | null,
  _exitSignal: NodeJS.Signals | null,
  exitReason: string,
): Promise<void> {
  // AUTORIZACIÓN DEL REINICIO (corrección de la revisión de #146).
  //
  // Antes bastaba `recentViewer = now - lastMediaActivity < SUPERVISOR_GRACE_MS`
  // para re-spawnear. Eso contradice la regla del módulo: la actividad de medio
  // es DIAGNÓSTICO y no prueba que haya un espectador, así que el supervisor
  // podía resucitar un FFmpeg sin propietario — la misma sesión fantasma que A1
  // eliminó, entrando por otra puerta.
  //
  // Sólo autorizan un reinicio:
  //   · una sesión con heartbeat de CLIENTE fresco sobre este streamPath, o
  //   · un arranque en vuelo todavía válido (no cancelado).
  //
  // La búsqueda es por `streamPath`, no por clave de sesión: el proceso es
  // compartido y su dueño puede ser cualquier pestaña, no la del sourceRef.
  const nowMs = Date.now()
  const ttl = getSessionTtl()
  const freshViewer = hasFreshClientViewer({
    sessions: toSessionTruths(), streamPath, nowMs, ttl,
  })
  const inFlightState = transcodeInFlight.get(streamPath)?.state
  const inFlightValid = inFlightState === 'starting' && !isStartCancelled(streamPath)

  if (!freshViewer && !inFlightValid) {
    const lastActivity = lastMediaActivity.get(streamPath) ?? 0
    console.info(
      `[supervisor] skip path=${streamPath} reason=no_valid_viewer` +
      ` inFlight=${inFlightState ?? 'none'}` +
      // Se registra como OBSERVACIÓN: no participó de la decisión.
      ` observed_mediaActivityMsAgo=${lastActivity ? nowMs - lastActivity : 'n/a'}`
    )
    transcodeRestarts.delete(streamPath)
    return
  }

  const now  = Date.now()
  let info   = transcodeRestarts.get(streamPath)

  if (!info || (now - info.windowStart) > SUPERVISOR_WINDOW_MS) {
    info = { count: 0, windowStart: now, lastExitCode: exitCode, lastExitReason: exitReason, lastExitAt: now }
  } else {
    info.lastExitCode   = exitCode
    info.lastExitReason = exitReason
    info.lastExitAt     = now
  }
  transcodeRestarts.set(streamPath, info)

  if (info.count >= SUPERVISOR_MAX_RESTARTS) {
    console.warn(
      `[supervisor] exhausted path=${streamPath} count=${info.count}/${SUPERVISOR_MAX_RESTARTS}` +
      ` reason=${exitReason} — dropping session`
    )
    dropSessionsByStreamPath(streamPath, 'supervisor_exhausted')
    transcodeInFlight.set(streamPath, { state: 'failed', promise: Promise.resolve(false), resolve: () => {} })
    return
  }

  const backoffMs = SUPERVISOR_BACKOFFS[info.count] ?? 10_000
  info.count++
  transcodeRestarts.set(streamPath, info)

  console.info(
    `[supervisor] restart_pending path=${streamPath} reason=${exitReason}` +
    ` attempt=${info.count}/${SUPERVISOR_MAX_RESTARTS} backoffMs=${backoffMs}`
  )

  await new Promise(r => setTimeout(r, backoffMs))

  // Mismo criterio que antes del backoff: durante la espera el espectador pudo
  // irse. La actividad de medio sigue sin autorizar nada.
  const nowAfter = Date.now()
  const freshViewerAfter = hasFreshClientViewer({
    sessions: toSessionTruths(), streamPath, nowMs: nowAfter, ttl: getSessionTtl(),
  })
  const inFlightStateAfter = transcodeInFlight.get(streamPath)?.state
  const inFlightValidAfter = inFlightStateAfter === 'starting' && !isStartCancelled(streamPath)
  if (!freshViewerAfter && !inFlightValidAfter) {
    console.info(
      `[supervisor] restart_cancelled path=${streamPath} reason=no_valid_viewer_after_backoff` +
      ` inFlight=${inFlightStateAfter ?? 'none'}`
    )
    return
  }

  if (isTranscodeProcessAlive(streamPath)) {
    console.info(`[supervisor] restart_skipped path=${streamPath} reason=process_already_alive`)
    return
  }

  const proc = spawnTranscodeProcess(sourceRef.nvr, sourceRef.camera, streamPath)
  if (!proc) {
    console.error(`[supervisor] restart_spawn_failed path=${streamPath} attempt=${info.count}`)
    dropSessionsByStreamPath(streamPath, 'supervisor_spawn_failed')
    transcodeInFlight.set(streamPath, { state: 'failed', promise: Promise.resolve(false), resolve: () => {} })
    return
  }

  console.info(`[supervisor] restarted path=${streamPath} pid=${proc.pid ?? 'pending'} attempt=${info.count}`)
  lastMediaActivity.set(streamPath, Date.now())

  const existing = transcodeInFlight.get(streamPath)
  if (existing && existing.state !== 'ready') {
    existing.state = 'ready'
  } else if (!existing) {
    transcodeInFlight.set(streamPath, { state: 'ready', promise: Promise.resolve(true), resolve: () => {} })
  }

  attachTranscodeSupervisor(streamPath, proc, sourceRef)
}

// Iniciar stream para un usuario
interface StreamError {
  code: string
  message: string
  details?: string
}

const HEALTH_STATUS_ERRORS: Record<string, StreamError> = {
  RTSP_SUB_NOT_FOUND:    { code: 'RTSP_SUB_NOT_FOUND',    message: 'Substream RTSP no disponible' },
  CODEC_UNSUPPORTED_HEVC:{ code: 'CODEC_UNSUPPORTED_HEVC', message: 'Codec HEVC/H.265 no compatible para reproducción web' },
  AUTH_FAILED:           { code: 'AUTH_FAILED',            message: 'Credenciales inválidas en cámara' },
  OFFLINE:               { code: 'OFFLINE',                message: 'Cámara offline' },
  RTSP_MAIN_NOT_FOUND:   { code: 'RTSP_MAIN_NOT_FOUND',   message: 'Stream RTSP principal no disponible' },
  USING_MAIN_STREAM:     { code: 'RTSP_SUB_NOT_FOUND',    message: 'Substream no disponible — doble clic para ver en pantalla completa' },
}

// Wrapper público: delega en startStreamCore y registra el resultado en los
// contadores rodantes UNA sola vez, sin importar quién llame (handler HTTP o
// reconcileView). El rechazo por permiso (403) se registra solo en el handler,
// porque el chequeo de permisos ocurre antes de llegar aquí.
export async function startStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
  viewId?: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
): Promise<{ hlsUrl: string; webrtcUrl: string; streamPath: string; transcoded?: boolean; error?: StreamError; warning?: StreamError }> {
  try {
    const result = await startStreamCore(server, userId, cameraId, viewId, streamType)
    recordStartResult(userId, result.error)
    return result
  } catch (err) {
    recordStreamOutcome(userId, 'failed_other', 'EXCEPTION')
    throw err
  }
}

async function startStreamCore(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
  viewId?: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
  receivedAtMs: number = Date.now(),
): Promise<{ hlsUrl: string; webrtcUrl: string; streamPath: string; transcoded?: boolean; error?: StreamError; warning?: StreamError }> {
  const effectiveViewId = viewId || DEFAULT_VIEW_ID

  // GUARDA REPETIDA. Cada operación asíncrona de este arranque (consulta a la
  // base, publishStream, spawn de FFmpeg, waitForHlsReady, espera de
  // transcodeInFlight) es una ventana en la que puede llegar el `pagehide` de
  // la pestaña. Comprobar sólo al entrar no alcanza: había que volver a
  // comprobar antes de registrar, reutilizar o devolver una sesión.
  const cancelled = () =>
    isTargetClosedAfter(userId, effectiveViewId, cameraId, streamType, receivedAtMs)
  const abortResult = (stage: string) => {
    console.info(
      `[live] start_aborted cameraId=${cameraId} streamType=${streamType}` +
      ` viewId=${effectiveViewId} stage=${stage} reason=view_closed_during_start`
    )
    return {
      hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: { code: 'VIEW_CLOSED', message: 'La vista se cerró durante el arranque' } as StreamError,
    }
  }
  if (cancelled()) return abortResult('entry')
  const existingKey = sessionKey({ userId, viewId: effectiveViewId, cameraId, streamType })
  const hasExisting = sessions.has(existingKey)
  console.info(`[live] start_stream cameraId=${cameraId} streamType=${streamType} existingSession=${hasExisting} userId=${userId}`)

  // Buscar cámara en DB con NVR
  const camera = await server.prisma.camera.findUnique({
    where: { id: cameraId },
    include: { nvr: true },
  })
  if (cancelled()) return abortResult('after_db_lookup')

  if (!camera || !camera.nvr) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_NOT_FOUND', message: 'Cámara no encontrada' } }
  }

  if (!camera.active) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_DISABLED', message: 'Cámara desactivada' } }
  }

  if ((camera as any).online === false) {
    console.info(`[startStream] skip offline cameraId=${cameraId} reason=camera_online_false`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_OFFLINE', message: 'Cámara offline' } }
  }

  const rtspSubOk  = (camera as any).rtspSubOk  as boolean | null
  const rtspMainOk = (camera as any).rtspMainOk as boolean | null
  if (rtspSubOk === false && rtspMainOk === false) {
    console.info(`[startStream] skip offline cameraId=${cameraId} reason=rtsp_both_down`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_OFFLINE', message: 'Cámara offline — sin RTSP disponible' } }
  }

  const healthStatus = (camera as any).streamHealthStatus as string | undefined
  const mainCodecStr = ((camera as any).mainCodec || '').toLowerCase()
  const subCodecStr  = ((camera as any).subCodec  || '').toLowerCase()
  const mainIsH264   = !!(mainCodecStr && (mainCodecStr.includes('h264') || mainCodecStr.includes('avc') || mainCodecStr.includes('h.264')))
  const mainIsHevc   = !!(mainCodecStr && (mainCodecStr.includes('hevc') || mainCodecStr.includes('h265') || mainCodecStr.includes('h.265') || mainCodecStr.includes('hvc1')))
  const subIsHevc    = !!(subCodecStr  && (subCodecStr.includes('hevc')  || subCodecStr.includes('h265')  || subCodecStr.includes('h.265')  || subCodecStr.includes('hvc1')))
  const ch = (camera as any).channel

  // ── Determine effective stream type ─────────────────────────────────────
  let effectiveType: 'sub' | 'main' | 'main_h264' = streamType

  if (streamType === 'main') {
    if (mainIsHevc) {
      if (!isTranscodingEnabled()) {
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'CODEC_UNSUPPORTED_HEVC', message: 'El flujo principal es H.265/HEVC. Configura ENABLE_HEVC_TRANSCODING=true para habilitar transcodificación.' } }
      }
      console.info(`[transcode] requested cameraId=${cameraId} ch=${ch} streamType=main codec=${mainCodecStr}`)
      effectiveType = 'main_h264'
    }
  } else if (streamType === 'sub') {
    // Sub HEVC: redirect to main H264 if available, otherwise transcode, otherwise error
    if (subIsHevc) {
      if (mainIsH264 && rtspMainOk !== false) {
        effectiveType = 'main'
        console.info(`[stream] sub HEVC redirect → main cameraId=${cameraId} ch=${ch} subCodec=${subCodecStr} mainCodec=${mainCodecStr}`)
      } else if (isTranscodingEnabled()) {
        console.info(`[transcode] requested cameraId=${cameraId} ch=${ch} streamType=sub reason=sub_hevc`)
        effectiveType = 'main_h264'
      } else {
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'CODEC_UNSUPPORTED_HEVC', message: 'Sub stream en H.265/HEVC. Habilita ENABLE_HEVC_TRANSCODING=true para transcodificar.' } }
      }
    }
    // Sub failed but main H264 works (USING_MAIN_STREAM status) — redirect to main
    else if (healthStatus === 'USING_MAIN_STREAM' && mainIsH264 && rtspMainOk !== false) {
      effectiveType = 'main'
      console.info(`[stream] USING_MAIN_STREAM redirect → main cameraId=${cameraId} ch=${ch} mainCodec=${mainCodecStr}`)
    }
  }

  // ── Transcoded stream (main_h264) ──────────────────────────────────────
  if (effectiveType === 'main_h264') {
    if (!isTranscodingEnabled()) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=HEVC_DISABLED`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODING_DISABLED', message: 'La transcodificación HEVC no está habilitada. Configura ENABLE_HEVC_TRANSCODING=true.' } }
    }
    if (!getFfmpegCapabilities().available) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=FFMPEG_NOT_AVAILABLE`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'MEDIA_SERVER_ERROR', message: 'FFmpeg no disponible en el servidor.' } }
    }

    const transcodeKey = sessionKey({ userId, viewId: effectiveViewId, cameraId, streamType: 'main_h264' })
    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const streamPath = getTranscodedStreamPath(nvr as any, camera as any)


    // Resolución del single-flight tolerante al orden: la primera ruta de
    // registro ocurre ANTES de que exista el `resolveInFlight` del arranque
    // nuevo. Un arranque abortado debe resolver la promesa igual, o cualquier
    // otra petición que la esté esperando quedaría colgada para siempre.
    let resolveInFlightRef: ((v: boolean) => void) | null = null
    const resolveInFlightSafe = (v: boolean) => {
      transcodeInFlight.set(streamPath, {
        state: v ? 'ready' : 'failed',
        promise: Promise.resolve(v),
        resolve: () => {},
      })
      resolveInFlightRef?.(v)
    }

    // Registrador ÚNICO de la sesión transcodificada. Comprueba la cancelación
    // inmediatamente antes de escribir: entre el inicio del arranque y este
    // punto hubo publishTranscodedStream, spawn y waitForHlsReady, cualquiera
    // de los cuales pudo solaparse con el `pagehide` de la pestaña.
    const registerTranscodeSession = (): boolean => {
      if (cancelled()) return false
      sessions.set(transcodeKey, {
        cameraId, userId, viewId: effectiveViewId, streamType: 'main_h264',
        streamPath, startedAt: new Date(), lastClientHeartbeat: new Date(),
        generation: nextGeneration(),
      })
      return true
    }

    // ── 1. Reuse already-registered session ──────────────────
    const existingSession = sessions.get(transcodeKey)
    if (existingSession) {
      existingSession.lastClientHeartbeat = new Date()
      if (viewId) existingSession.viewId = viewId
      lastMediaActivity.set(existingSession.streamPath, Date.now())
      console.info(`[userLimit] reuse existing cameraId=${cameraId} streamType=main_h264`)
      return { hlsUrl: getHlsUrl(existingSession.streamPath), webrtcUrl: getWebRtcUrl(existingSession.streamPath), streamPath: existingSession.streamPath, transcoded: true }
    }

    // ── 2. If this path is already starting, await it ────────
    // Prevents duplicate FFmpeg processes when heartbeat fires during
    // the 10-12s waitForHlsReady window.
    const inFlight = transcodeInFlight.get(streamPath)
    if (inFlight?.state === 'starting') {
      console.info(`[transcode] awaiting in-progress cameraId=${cameraId} path=${streamPath}`)
      // Este arranque queda EN VUELO también para el que espera: si su pestaña
      // se cierra mientras aguarda, el supervisor no debe tomar la espera ajena
      // como autorización propia.
      addWaiter(streamPath)
      let ready: boolean
      try {
        ready = await inFlight.promise
      } finally {
        removeWaiter(streamPath)
      }
      if (ready) {
        // El proceso arrancó bien. CADA pestaña que esperaba necesita SU PROPIA
        // fila: la clave es por view, así que buscar `transcodeKey` sin haberla
        // creado devolvía siempre vacío y respondía TRANSCODE_NOT_READY aunque
        // FFmpeg estuviera perfecto (revisión de #147). Además, sin fila propia
        // la cancelación de la pestaña iniciadora se llevaba por delante un
        // proceso que este espectador sí estaba usando.
        const own = sessions.get(transcodeKey)
        if (own) {
          own.lastClientHeartbeat = new Date()
          return { hlsUrl: getHlsUrl(own.streamPath), webrtcUrl: getWebRtcUrl(own.streamPath), streamPath: own.streamPath, transcoded: true }
        }
        if (!registerTranscodeSession()) {
          // El que esperaba también se fue: no se registra nada, y se libera el
          // proceso sólo si no quedó ningún otro dueño.
          await releaseUnownedStream(server, cameraId, streamPath, 'view_closed_while_waiting')
          return abortResult('waiting_shared_transcode')
        }
        console.info(`[transcode] waiter_registered cameraId=${cameraId} path=${streamPath} viewId=${effectiveViewId}`)
        return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
      }
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODE_NOT_READY', message: 'El stream transcodificado no pudo iniciar. Intenta de nuevo.' } }
    }

    // Clear failed state so the caller can retry
    if (inFlight?.state === 'failed') transcodeInFlight.delete(streamPath)

    // ── 2b. Reuse live FFmpeg even if session was cleared ────────
    // Happens when stopStream was called with a non-kill reason (e.g. 'retry', 'hls_error')
    // which removed the session but kept FFmpeg running. Re-register the session and return
    // the existing URL immediately without spawning a new process.
    if (isTranscodeProcessAlive(streamPath)) {
      console.info(`[transcode] reuse_live_process path=${streamPath} cameraId=${cameraId} — session cleared but FFmpeg alive`)
      if (!registerTranscodeSession()) {
        // El medio SÍ arrancó; sólo se fue quien lo pidió. Si hay pestañas
        // esperando este mismo path, el arranque se resuelve como EXITOSO para
        // que lo adopten, y el proceso no se toca. Sin nadie esperando, se
        // libera.
        const adopters = hasWaiters(streamPath)
        if (!adopters) await releaseUnownedStream(server, cameraId, streamPath, 'view_closed_during_start')
        resolveInFlightSafe(adopters)
        return abortResult('before_register_transcode')
      }
      lastMediaActivity.set(streamPath, Date.now())
      // Supervisor is still attached from the original spawn — no need to re-attach.
      transcodeInFlight.set(streamPath, { state: 'ready', promise: Promise.resolve(true), resolve: () => {} })
      return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
    }

    // ── 3. Check limits (count starting + registered) ────────
    const counts = getTranscodeCounts()
    if (counts.total >= MAX_TRANSCODE_SESSIONS) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=MAX_TRANSCODE_SESSIONS active=${counts.active} starting=${counts.starting} max=${counts.max}`)
      const startingTxt = counts.starting ? `, ${counts.starting} iniciando` : ''
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        // El contrato incluye el desglose para que el frontend muestre el cupo real
        // (activeCount/startingCount/maxTranscodes) en vez de "Error desconocido".
        error: { code: 'TRANSCODE_LIMIT_REACHED',
          message: `Límite de transcodificaciones alcanzado (${counts.active}/${counts.max} activas${startingTxt})`,
          activeCount: counts.active, startingCount: counts.starting, maxTranscodes: counts.max,
          current: counts.active, max: counts.max } as any }
    }
    if (sessions.size >= MAX_STREAMS_GLOBAL) pruneStaleSessions()
    if (sessions.size >= MAX_STREAMS_GLOBAL) {
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'STREAM_LIMIT_GLOBAL', message: 'Límite global de streams alcanzado', current: sessions.size, max: MAX_STREAMS_GLOBAL } as any }
    }

    // ── 4. Start new transcode with in-flight guard ──────────
    let resolveInFlight!: (v: boolean) => void
    const readyPromise = new Promise<boolean>(r => { resolveInFlight = r })
    resolveInFlightRef = resolveInFlight
    transcodeInFlight.set(streamPath, { state: 'starting', promise: readyPromise, resolve: resolveInFlight })
    // El arranque queda registrado con su dueño: si la pestaña se cierra, el
    // supervisor sabrá que este in-flight ya no autoriza ningún reinicio.
    inFlightStarts.set(streamPath, { userId, viewId: effectiveViewId, cameraId, streamType, receivedAtMs })

    try {
      // Register passive RTSP receiver path in MediaMTX (no runOnDemand)
      const published = await publishTranscodedStream(nvr as any, camera as any)
      if (!published) {
        transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
        resolveInFlight(false)
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'MEDIA_SERVER_ERROR', message: 'Error al registrar path transcodificado en MediaMTX' } }
      }

      // Spawn FFmpeg in the API container — MediaMTX container doesn't have FFmpeg
      // spawnTranscodeProcess returns null if password is empty or RTSP URL is invalid.
      // The spawn_abort log in stream.ts explains the reason; show it in the error detail too.
      const proc = spawnTranscodeProcess(nvr as any, camera as any, streamPath)
      if (!proc) {
        transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
        resolveInFlight(false)
        console.error(`[transcode] spawn_null cameraId=${cameraId} ch=${ch} path=${streamPath} — spawnTranscodeProcess returned null (see spawn_abort log above)`)
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'TRANSCODE_PROCESS_EXITED',
            message: 'FFmpeg no pudo iniciarse. Verifica credenciales NVR y que FFmpeg esté instalado en el contenedor API.',
            details: `path=${streamPath} — ver logs [transcode] spawn_abort para causa exacta` } }
      }
      console.info(`[transcode] spawn_ok cameraId=${cameraId} ch=${ch} path=${streamPath} pid=${proc.pid ?? 'pending'}`)

      // Store source info for supervisor restarts and attach the supervisor
      const sourceRef: TranscodeSourceRef = { nvr: nvr as any, camera: camera as any, userId, cameraId }
      transcodeSourceInfo.set(streamPath, sourceRef)
      attachTranscodeSupervisor(streamPath, proc, sourceRef)

      // Poll HLS manifest — abort early if FFmpeg exits before producing segments.
      // manifestVisible=true means status=200+#EXTM3U was seen; FFmpeg is alive
      // and MediaMTX is muxing — don't kill FFmpeg on timeout in that case.
      const { ready, lastStatus, elapsedMs, processExited, manifestVisible } = await waitForHlsReady(
        streamPath, TRANSCODE_HLS_READY_TIMEOUT_MS, 300,
        () => isTranscodeProcessAlive(streamPath),
      )

      if (!ready) {
        const stderrSnippet = getTranscodeStderr(streamPath)
        if (processExited) {
          stopTranscodeProcess(streamPath)
          transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
          resolveInFlight(false)
          console.error(`[transcode] process_exited_early path=${streamPath} stderr=${stderrSnippet}`)
          return { hlsUrl: '', webrtcUrl: '', streamPath: '',
            error: { code: 'TRANSCODE_PROCESS_EXITED',
              message: 'FFmpeg finalizó antes de que HLS estuviese listo. Verifica la conexión RTSP al NVR.',
              details: stderrSnippet.slice(-200) } }
        }
        if (manifestVisible) {
          // MediaMTX is serving a manifest (status=200 + #EXTM3U) but segment
          // indicators were not detected — likely fMP4/LL-HLS format or master playlist.
          // FFmpeg IS alive and MediaMTX IS muxing; return the URL and let VideoPlayer retry.
          console.warn(`[transcode] hls_partial_ready path=${streamPath} manifestVisible=true elapsedMs=${elapsedMs} — returning url for VideoPlayer retry`)
          if (!registerTranscodeSession()) {
            await releaseUnownedStream(server, cameraId, streamPath, 'view_closed_during_start')
            resolveInFlightSafe(false)
            return abortResult('before_register_transcode')
          }
          lastMediaActivity.set(streamPath, Date.now())
          transcodeInFlight.set(streamPath, { state: 'ready', promise: readyPromise, resolve: resolveInFlight })
          resolveInFlight(true)
          return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
        }
        // Final safety net: even without HLS manifest evidence, check if MediaMTX
        // actually has the RTSP publisher live (FFmpeg connected and pushing frames).
        // waitForHlsReady already does this check, but we do it once more here as a
        // last resort before killing FFmpeg.
        const liveDetails = await getStreamDetails(streamPath).catch(() => null)
        const rtspActive  = liveDetails?.sourceType === 'rtspSession' || liveDetails?.active === true
        if (rtspActive) {
          console.warn(
            `[transcode] hls_partial_ready path=${streamPath} elapsedMs=${elapsedMs}` +
            ` sourceType=${liveDetails?.sourceType} active=${liveDetails?.active}` +
            ` — publisher active, HLS muxer slow; returning URL for VideoPlayer retry`
          )
          if (!registerTranscodeSession()) {
            await releaseUnownedStream(server, cameraId, streamPath, 'view_closed_during_start')
            resolveInFlightSafe(false)
            return abortResult('before_register_transcode')
          }
          lastMediaActivity.set(streamPath, Date.now())
          transcodeInFlight.set(streamPath, { state: 'ready', promise: readyPromise, resolve: resolveInFlight })
          resolveInFlight(true)
          return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
        }
        stopTranscodeProcess(streamPath)
        transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
        resolveInFlight(false)
        console.error(`[transcode] hls_not_ready_killing path=${streamPath} elapsedMs=${elapsedMs} lastStatus=${lastStatus} rtspActive=${rtspActive}`)
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'TRANSCODE_NOT_READY',
            message: 'El stream transcodificado no pudo iniciar a tiempo. Intenta de nuevo.',
            details: `lastStatus=${lastStatus} elapsed=${elapsedMs}ms` } }
      }

      if (!registerTranscodeSession()) {
        // El medio SÍ arrancó; sólo se fue quien lo pidió. Si hay pestañas
        // esperando este mismo path, el arranque se resuelve como EXITOSO para
        // que lo adopten, y el proceso no se toca. Sin nadie esperando, se
        // libera.
        const adopters = hasWaiters(streamPath)
        if (!adopters) await releaseUnownedStream(server, cameraId, streamPath, 'view_closed_during_start')
        resolveInFlightSafe(adopters)
        return abortResult('before_register_transcode')
      }
      lastMediaActivity.set(streamPath, Date.now())
      transcodeInFlight.set(streamPath, { state: 'ready', promise: readyPromise, resolve: resolveInFlight })
      resolveInFlight(true)
      console.info(`[transcode] ready cameraId=${cameraId} ch=${ch} path=${streamPath}`)
      return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
    } catch (err) {
      stopTranscodeProcess(streamPath)
      transcodeInFlight.delete(streamPath)
      resolveInFlight(false)
      throw err
    } finally {
      // El arranque dejó de estar en vuelo por cualquier vía (éxito, error o
      // aborto): sin esto el supervisor seguiría viéndolo como autorización.
      inFlightStarts.delete(streamPath)
    }
  }

  // ── Sub early exit if confirmed down ──────────────────────────────────
  if (effectiveType === 'sub' && rtspSubOk === false) {
    console.info(`[startStream] skip cameraId=${cameraId} reason=rtsp_sub_down`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'RTSP_SUB_NOT_FOUND', message: 'Substream RTSP no disponible' } }
  }

  // ── Health status blocking (hard failures only) ───────────────────────
  if (healthStatus && BLOCKED_HEALTH_STATUSES.has(healthStatus)) {
    const knownError = HEALTH_STATUS_ERRORS[healthStatus]
    return { hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: knownError ?? { code: healthStatus, message: `Stream no disponible: ${healthStatus}` } }
  }

  // ── Session reuse: return existing session without counting toward limit ─
  const key = sessionKey({ userId, viewId: effectiveViewId, cameraId, streamType: effectiveType as 'sub' | 'main' })
  const existingSession = sessions.get(key)
  if (existingSession) {
    existingSession.lastClientHeartbeat = new Date()
    if (viewId) existingSession.viewId = viewId
    console.info(`[userLimit] reuse existing cameraId=${cameraId} streamType=${effectiveType}`)
    return { hlsUrl: getHlsUrl(existingSession.streamPath), webrtcUrl: getWebRtcUrl(existingSession.streamPath), streamPath: existingSession.streamPath }
  }

  // ── Stream limits (only sub counts toward per-user limit) ─────────────
  // Purgar sesiones vencidas ANTES de calcular AMBOS límites y los conteos, para
  // que sesiones huérfanas (pestañas muertas, recargas) no disparen ni el límite
  // por usuario ni el global.
  pruneStaleSessions()
  const userSessions = getSessionsForUser(userId)
  const userSubSessions = userSessions.filter(s => s.streamType === 'sub')
  if (effectiveType === 'sub' && userSubSessions.length >= MAX_STREAMS_PER_USER) {
    console.info(`[userLimit] reject reason=limit cameraId=${cameraId} current=${userSubSessions.length} max=${MAX_STREAMS_PER_USER}`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'STREAM_LIMIT_REACHED', message: 'Límite de streams por usuario alcanzado', current: userSubSessions.length, max: MAX_STREAMS_PER_USER } as any }
  }
  if (sessions.size >= MAX_STREAMS_GLOBAL) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: { code: 'STREAM_LIMIT_GLOBAL', message: 'Límite global de streams alcanzado', current: sessions.size, max: MAX_STREAMS_GLOBAL } as any }
  }

  // ── Publish to MediaMTX ───────────────────────────────────────────────
  const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
  const streamPath = getStreamPath(nvr as NVR, camera as Camera, effectiveType as 'sub' | 'main')
  const rtspMasked = `rtsp://${nvr.username}:***@${nvr.ipAddress}:${nvr.rtspPort}/...`
  console.info(
    `[startStream] publish cameraId=${cameraId} nvrId=${camera.nvr.id} ch=${camera.channel}` +
    ` streamType=${effectiveType} path=${streamPath} rtsp=${rtspMasked}`
  )
  if (cancelled()) return abortResult('before_publish')
  inFlightStarts.set(streamPath, { userId, viewId: effectiveViewId, cameraId, streamType, receivedAtMs })
  const published = await publishStream(nvr as NVR, camera as Camera, effectiveType as 'sub' | 'main')
  inFlightStarts.delete(streamPath)
  if (!published) {
    console.error(
      `[startStream] publish_failed cameraId=${cameraId} nvrId=${camera.nvr.id} ch=${camera.channel} path=${streamPath}`
    )
    return { hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: { code: 'MEDIA_SERVER_ERROR', message: 'Error al registrar stream en el servidor de medios' } }
  }

  // Última comprobación ANTES de registrar: si la pestaña se cerró durante el
  // publish, se deshace lo recién creado en vez de dejar una sesión huérfana.
  if (cancelled()) {
    await releaseUnownedStream(server, cameraId, streamPath, 'view_closed_during_start')
    return abortResult('before_register')
  }

  // ── Register session ──────────────────────────────────────────────────
  sessions.set(key, {
    cameraId, userId, viewId: effectiveViewId, streamType: effectiveType as 'sub' | 'main',
    streamPath, startedAt: new Date(), lastClientHeartbeat: new Date(), generation: nextGeneration(),
  })
  if (effectiveType === 'sub') {
    const vk = vKey(userId, effectiveViewId)
    if (!viewCameras.has(vk)) viewCameras.set(vk, new Set())
    viewCameras.get(vk)!.add(cameraId)
    viewHeartbeat.set(vk, new Date())
  }
  return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath }
}

// Detener stream para un usuario
export async function stopStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
  reason?: string,
  viewId?: string,
): Promise<void> {
  // Una pestaña no puede cerrar la sesión de otra pestaña del mismo usuario:
  // sin viewId sólo se resuelve si la pertenencia es inequívoca.
  const { key, ambiguous } = resolveOwnedSessionKey(userId, viewId, cameraId, streamType)
  if (ambiguous) {
    console.info(
      `[live] stop_ignored_ambiguous cameraId=${cameraId} streamType=${streamType}` +
      ` reason=multiple_views_without_viewId`
    )
    return
  }
  const session = key ? sessions.get(key) : undefined
  // Marcar el cierre ANTES de mirar si la sesión existe. Si el arranque de esta
  // cámara sigue en vuelo todavía no hay fila que borrar, y sin esta marca el
  // arranque terminaría después registrando una sesión que el usuario ya cerró
  // — el mismo hueco que se tapó en `cleanupUserSessions`, aquí a nivel cámara.
  if (key) markTargetClosed(key)
  let killedFfmpeg = false
  let clearedInFlight = false

  if (session && key) {
    const generation = session.generation
    if (streamType === 'sub') {
      const vk = vKey(userId, session.viewId)
      viewCameras.get(vk)?.delete(cameraId)
    }
    sessions.delete(key)
    console.info(
      `[stream-manager] view_session_closed cameraId=${cameraId} streamType=${streamType}` +
      ` viewId=${session.viewId} generation=${generation} reason=${reason || 'unspecified'}`
    )
    if (streamType === 'main_h264') {
      // Only kill FFmpeg when the reason explicitly permits it.
      // Non-kill reasons (retry, hls_error, etc.) keep FFmpeg alive so the next
      // startStream call can detect the live process and reuse it without re-spawning.
      const shouldKill = !reason || TRANSCODE_KILL_REASONS.has(reason)
      // Refcount compartido: aunque toque matar, no se mata mientras otro
      // espectador siga usando EXACTAMENTE el mismo proceso/perfil.
      const decision = decideProcessTermination(
        [sessionTruthOf(key, session)],
        toSessionTruths(),
      )
      if (shouldKill && decision.terminate.length > 0) {
        terminateProcesses(decision, reason || 'stop_stream')
        killedFfmpeg = true
      } else if (shouldKill) {
        terminateProcesses({ terminate: [], keepAlive: decision.keepAlive }, reason || 'stop_stream')
      } else {
        console.info(`[live] stop_stream_keep_ffmpeg path=${session.streamPath} reason=${reason}`)
      }
      // Always clear inFlight — next startStream will re-register via isTranscodeProcessAlive check
      transcodeInFlight.delete(session.streamPath)
      clearedInFlight = true
    }
  } else {
    // Idempotencia: cerrar dos veces (pagehide + desmontaje + cambio de layout
    // concurrentes) no es un error y no debe producir efectos adicionales.
    console.info(`[live] stop_ignored_stale cameraId=${cameraId} streamType=${streamType} reason=${reason || 'unspecified'}`)
  }

  console.info(
    `[live] stop_stream cameraId=${cameraId} streamType=${streamType}` +
    ` sessionFound=${!!session} path=${session?.streamPath || 'n/a'}` +
    ` killedFfmpeg=${killedFfmpeg} clearedInFlight=${clearedInFlight}` +
    (reason ? ` reason=${reason}` : '')
  )

  const othersWatching = Array.from(sessions.values()).some(s => s.cameraId === cameraId)
  if (!othersWatching) {
    server.log.info(`[stream-manager] Todos los viewers salieron de cámara ${cameraId}`)
  }
}

// ─── Heartbeat de viewport: reconciliar cámaras visibles ────
// Recibe el set de cámaras visibles para un viewId.
// - Detiene cámaras que ese view ya no necesita
// - Inicia cámaras que ese view necesita pero no tienen sesión
// - Toca todas las sesiones existentes (keepalive)
// - Devuelve URLs para todas las cámaras visibles
export interface ReconcileResult {
  streams: Record<string, { hls: string; webrtc: string; streamPath: string; channel?: number; nvrName?: string; warning?: { code: string; message: string } }>
  errors: Record<string, { code: string; message: string }>
  startedIds: string[]  // cámaras que se iniciaron ahora (necesitan nuevo player)
  stoppedIds: string[]  // cámaras que se detuvieron
}

export async function reconcileView(
  server: FastifyInstance,
  userId: string,
  viewId: string,
  visibleCameraIds: string[],
  suppressStartCameraIds: string[] = [],
): Promise<ReconcileResult> {
  const visibleSet = new Set(visibleCameraIds)
  const suppressSet = new Set(suppressStartCameraIds)
  const vk = vKey(userId, viewId)
  const receivedAtMs = Date.now()

  console.info(`[live] heartbeat userId=${userId} viewId=${viewId} cameraIds=[${visibleCameraIds.join(',')}]`)

  // GUARDA DE RESPUESTA TARDÍA: si el view se cerró explícitamente después de
  // que llegó esta petición, reconciliar volvería a crear sesiones y a levantar
  // FFmpeg sin espectador. Se descarta el heartbeat entero.
  if (isViewClosedAfter(userId, viewId, receivedAtMs)) {
    console.info(`[live] heartbeat_ignored_stale viewId=${viewId} reason=view_closed_after_request`)
    return { streams: {}, errors: {}, startedIds: [], stoppedIds: [] }
  }

  // Actualizar heartbeat del view (hora del SERVIDOR)
  viewHeartbeat.set(vk, new Date())

  const streams: ReconcileResult['streams'] = {}
  const errors: ReconcileResult['errors']  = {}
  const startedIds: string[] = []
  const stoppedIds: string[] = []

  // Determinar qué cámaras tenía este view antes
  const previousCams = viewCameras.get(vk) || new Set<string>()

  // Detener cámaras que ya no son visibles en este view (solo sub — main/main_h264 tienen lifecycle explícito)
  const toStop = Array.from(previousCams).filter(id => !visibleSet.has(id))
  for (const cameraId of toStop) {
    await stopStream(server, userId, cameraId, 'sub', 'viewport_reconcile')
    stoppedIds.push(cameraId)
  }

  // Para cada cámara visible: iniciar si no tiene sesión sub, o tocar si ya existe
  for (const cameraId of visibleCameraIds) {
    const key = sessionKey({ userId, viewId, cameraId, streamType: 'sub' })
    const existing = sessions.get(key)

    if (existing) {
      // Ya está corriendo — tocar y devolver URL
      const now2 = new Date()
      existing.lastClientHeartbeat = now2
      existing.viewId = viewId
      // Touch co-located main/main_h264 sessions so idle cleanup doesn't kill active focus streams
      for (const st of ['main', 'main_h264'] as const) {
        const sOther = sessions.get(sessionKey({ userId, viewId, cameraId, streamType: st }))
        if (sOther) {
          sOther.lastClientHeartbeat = now2
          if (st === 'main_h264') lastMediaActivity.set(sOther.streamPath, Date.now())
          console.info(`[reconcileView] touch ${st} cameraId=${cameraId} path=${sOther.streamPath}`)
        }
      }
      streams[cameraId] = {
        hls: getHlsUrl(existing.streamPath),
        webrtc: getWebRtcUrl(existing.streamPath),
        streamPath: existing.streamPath,
      }
    } else if (suppressSet.has(cameraId)) {
      // Backoff de límite activo en el frontend: mantener visible pero NO iniciar
      // (no cuenta como started ni como error, no toca MediaMTX).
      console.info(`[reconcileView] suppress_start cameraId=${cameraId} reason=frontend_backoff`)
      continue
    } else {
      // No tiene sesión — iniciar
      const result = await startStream(server, userId, cameraId, viewId)
      if (result.error) {
        errors[cameraId] = result.error
      } else {
        // Lookup channel + nvrName for complete StreamInfo
        const cam = await server.prisma.camera.findUnique({
          where: { id: cameraId },
          select: { channel: true, nvr: { select: { name: true } } },
        })
        streams[cameraId] = {
          hls: result.hlsUrl,
          webrtc: result.webrtcUrl,
          streamPath: result.streamPath,
          channel: cam?.channel,
          nvrName: cam?.nvr?.name,
          warning: result.warning,
        }
        startedIds.push(cameraId)
      }
    }
  }

  // Actualizar viewCameras con el nuevo conjunto visible
  viewCameras.set(vk, new Set(visibleCameraIds.filter(id => streams[id])))

  console.info(
    `[live] heartbeat_done userId=${userId} viewId=${viewId}` +
    ` started=[${startedIds.join(',')}] stopped=[${stoppedIds.join(',')}]` +
    ` active=${visibleCameraIds.filter(id => streams[id]).length} errors=${Object.keys(errors).length}`
  )
  return { streams, errors, startedIds, stoppedIds }
}

// Limpiar sesiones de un usuario.
// viewId provided → only clean that view's sessions (safe for unmount, won't kill newly started sessions).
// no viewId → only clean orphaned sessions from views with expired heartbeats (stale tabs).
export async function cleanupUserSessions(
  server: FastifyInstance,
  userId: string,
  viewId?: string,
): Promise<number> {
  let targetSessions: StreamSession[]

  if (viewId) {
    // MARCAR EL CIERRE PRIMERO Y SIEMPRE, aunque no haya ninguna sesión todavía.
    //
    // El caso crítico de la revisión de #146: un start-stream entra, y antes de
    // que registre la sesión llega el `pagehide`. Si sólo marcáramos el cierre
    // al encontrar sesiones, acá habría cero, no se marcaría nada, y el
    // arranque terminaría después registrando una sesión y un FFmpeg sin
    // espectador — exactamente la sesión fantasma que A1 debía eliminar.
    markViewClosed(userId, viewId)
    targetSessions = getSessionsForUser(userId).filter(s => s.viewId === viewId)
    console.info(`[live] cleanup_view userId=${userId} viewId=${viewId} sessions=${targetSessions.length}`)
  } else {
    // Misma decisión centralizada y mismo TTL EFECTIVO por tipo que usa el cron.
    // Antes acá se leía STREAM_IDLE_TIMEOUT crudo y se aplicaba un único cutoff
    // a sub, main y main_h264 por igual, ignorando STREAM_HD_IDLE_TIMEOUT y el
    // clamping.
    const nowMs = Date.now()
    const ttl = getSessionTtl()
    const { expired } = decideSessionExpiry({
      sessions: toSessionTruths().filter(t => t.userId === userId),
      viewHeartbeats: viewHeartbeatsAsMs(),
      nowMs,
      ttl,
    })
    const expiredKeys = new Set(expired.map(e => e.session.key))
    targetSessions = Array.from(sessions.entries())
      .filter(([k]) => expiredKeys.has(k))
      .map(([, s]) => s)
    console.info(`[live] cleanup_stale userId=${userId} orphaned=${targetSessions.length}`)
  }

  let removed = 0

  // Snapshot ANTES de borrar: la decisión de qué procesos terminar se toma
  // sobre el conjunto completo, no sesión por sesión. Si no, la primera sesión
  // cerrada de un proceso compartido lo mataría para las demás.
  const closingTruths = targetSessions.map(s =>
    sessionTruthOf(sessionKey({ userId, viewId: s.viewId, cameraId: s.cameraId, streamType: s.streamType }), s))
  const closingKeys = new Set(closingTruths.map(t => t.key))
  const survivingTruths = toSessionTruths().filter(t => !closingKeys.has(t.key))
  const termination = decideProcessTermination(closingTruths, survivingTruths)

  for (const session of targetSessions) {
    const key = sessionKey({ userId, viewId: session.viewId, cameraId: session.cameraId, streamType: session.streamType })
    if (!sessions.has(key)) continue     // idempotente: ya cerrada por otra vía
    sessions.delete(key)
    removed++
    markViewClosed(userId, session.viewId)
    console.info(
      `[stream-manager] view_session_closed cameraId=${session.cameraId}` +
      ` streamType=${session.streamType} viewId=${session.viewId}` +
      ` generation=${session.generation} reason=${viewId ? 'cleanup_view' : 'cleanup_stale'}`
    )

    const othersWatching = Array.from(sessions.values()).some(s => s.cameraId === session.cameraId)
    if (!othersWatching) {
      const camera = await server.prisma.camera.findUnique({
        where: { id: session.cameraId },
        include: { nvr: true },
      })
      if (camera?.nvr) {
        removeStream(camera.nvr, camera).catch(() => {})
      }
    }
  }

  // Terminar los FFmpeg que quedaron sin ningún espectador válido.
  terminateProcesses(termination, viewId ? 'cleanup_view' : 'cleanup_stale')

  // Clean view maps
  if (viewId) {
    const vk = vKey(userId, viewId)
    viewCameras.delete(vk)
    viewHeartbeat.delete(vk)
  } else {
    // Con STREAM_HD_IDLE_TIMEOUT > STREAM_IDLE_TIMEOUT, una sesión HD cuya edad
    // cae entre ambos TTL sobrevive arriba; si acá se borrara su viewHeartbeat
    // con el cutoff estándar CRUDO, la siguiente limpieza la mataría por
    // `view_heartbeat_missing` y el TTL de HD configurado no serviría de nada
    // (revisión de #147). Se poda con la misma decisión de supervivencia.
    pruneOrphanViewIndexes(toSessionTruths(), Date.now(), getSessionTtl())
  }

  return removed
}

// Limpiar sesiones inactivas (llamar desde un cron).
//
// UNA SESIÓN ES IDLE CUANDO SU CLIENTE DEJÓ DE LATIR. Punto.
//
// Antes esta función tenía dos escapes que la volvían inofensiva justo en el
// caso que debía resolver:
//
//   if (ffmpegAlive)    { session.lastHeartbeat = new Date(); continue }
//   if (recentActivity) { session.lastHeartbeat = new Date(); continue }
//
// El primero es el bug de las 26 horas: el limpiador renovaba el heartbeat con
// evidencia del PROCESO, no del espectador, y así el proceso se mantenía vivo a
// sí mismo. El segundo hacía lo mismo con actividad de MEDIO. Ambos eliminados:
// `processAlive` y `lastMediaActivity` quedan como diagnóstico y no participan
// de ninguna decisión de vigencia.
//
// El efecto que aquellos escapes buscaban —que una pestaña con el heartbeat
// ralentizado no pierda el HD— se resuelve donde corresponde: el TTL de HD es
// configurable (STREAM_HD_IDLE_TIMEOUT, 90 s por defecto) y el frontend reanuda
// el heartbeat al volver a ser visible.
export async function cleanupIdleSessions(server: FastifyInstance): Promise<number> {
  const nowMs = Date.now()
  const ttl = getSessionTtl(msg => server.log.info(msg))
  const { expired, surviving } = decideSessionExpiry({
    sessions: toSessionTruths(),
    viewHeartbeats: viewHeartbeatsAsMs(),
    nowMs,
    ttl,
  })
  if (expired.length === 0) return 0

  // Decidir la terminación ANTES de borrar: qué procesos quedan sin espectador
  // se calcula sobre el conjunto completo, no sesión por sesión (si no, la
  // primera sesión vencida de un proceso compartido lo mataría).
  const termination = decideProcessTermination(expired.map(e => e.session), surviving)

  for (const { session, reason, clientHeartbeatAgeMs } of expired) {
    const vk = vKey(session.userId, session.viewId)
    if (session.streamType === 'sub') viewCameras.get(vk)?.delete(session.cameraId)
    sessions.delete(session.key)
    // Diagnóstico: se registra el estado del proceso y del medio, pero como
    // OBSERVACIÓN — no intervinieron en la decisión.
    const processAlive = session.streamType === 'main_h264'
      ? isTranscodeProcessAlive(session.streamPath)
      : null
    const mediaAgeMs = lastMediaActivity.has(session.streamPath)
      ? nowMs - (lastMediaActivity.get(session.streamPath) as number)
      : null
    server.log.info(
      `[stream-manager] view_session_expired cameraId=${session.cameraId}` +
      ` streamType=${session.streamType} viewId=${session.viewId}` +
      ` reason=${reason} clientHeartbeatAgeMs=${clientHeartbeatAgeMs}` +
      ` generation=${session.generation}` +
      ` observed_processAlive=${processAlive ?? 'n/a'}` +
      ` observed_mediaActivityAgeMs=${mediaAgeMs ?? 'n/a'}`
    )
  }

  terminateProcesses(termination, 'idle_cleanup')
  pruneOrphanViewIndexes(surviving, nowMs, ttl)

  return expired.length
}

// Resumen de todas las sesiones activas (para panel admin)
export function getAdminSessionsSummary(): Array<{
  cameraId: string
  userId: string
  viewId: string
  streamPath: string
  startedAt: Date
  lastHeartbeat: Date
}> {
  return Array.from(sessions.values()).map(s => ({
    cameraId:      s.cameraId,
    userId:        s.userId,
    viewId:        s.viewId,
    streamPath:    s.streamPath,
    startedAt:     s.startedAt,
    lastHeartbeat: s.lastClientHeartbeat,
  }))
}

// Diagnóstico de sesiones de streaming (para panel de diagnóstico del frontend).
// Sin credenciales — solo identificadores y tiempos. Purga vencidas antes de listar
// para reflejar el estado real (no las huérfanas ya expiradas).
export function getSessionsDiagnostic(): {
  counts: { total: number; maxGlobal: number; bySub: number; byMain: number; byMainH264: number }
  sessions: Array<{
    cameraId: string; userId: string; viewId: string; streamType: string
    startedAt: Date; lastHeartbeat: Date; ageSec: number; idleSec: number
  }>
} {
  pruneStaleSessions()
  const now = Date.now()
  const all = Array.from(sessions.values())
  return {
    counts: {
      total:       all.length,
      maxGlobal:   MAX_STREAMS_GLOBAL,
      bySub:       all.filter(s => s.streamType === 'sub').length,
      byMain:      all.filter(s => s.streamType === 'main').length,
      byMainH264:  all.filter(s => s.streamType === 'main_h264').length,
    },
    sessions: all.map(s => ({
      cameraId:      s.cameraId,
      userId:        s.userId,
      viewId:        s.viewId,
      streamType:    s.streamType,
      startedAt:     s.startedAt,
      lastHeartbeat: s.lastClientHeartbeat,
      ageSec:        Math.round((now - s.startedAt.getTime()) / 1000),
      idleSec:       Math.round((now - s.lastClientHeartbeat.getTime()) / 1000),
    })),
  }
}

// Enhanced diagnostic for /api/live-view/transcodes — one entry per active FFmpeg process
export async function getTranscodesDiagnostic(): Promise<Array<{
  streamPath:              string
  pid:                     number | undefined
  alive:                   boolean
  restartCount:            number
  lastExitCode:            number | null
  lastExitReason:          string
  stderrLast20k:           string
  sourceRtspMasked:        string | undefined
  mediaMtxPublisherActive: boolean
}>> {
  const procs = getActiveTranscodesList()
  return Promise.all(procs.map(async (p) => {
    const restartInfo = transcodeRestarts.get(p.streamPath)
    const details     = await getStreamDetails(p.streamPath).catch(() => null)
    return {
      streamPath:              p.streamPath,
      pid:                     p.pid,
      alive:                   p.alive,
      restartCount:            restartInfo?.count ?? 0,
      lastExitCode:            restartInfo?.lastExitCode ?? null,
      lastExitReason:          restartInfo?.lastExitReason ?? '',
      stderrLast20k:           getTranscodeRawStderr(p.streamPath),
      sourceRtspMasked:        getTranscodeRtspMasked(p.streamPath),
      mediaMtxPublisherActive: details?.active === true,
    }
  }))
}

// Diagnóstico ADMIN de CUPOS de transcodificación — identifica exactamente qué ocupa
// cada cupo contra MAX_TRANSCODE_SESSIONS, sin secretos (sólo IDs, tiempos y perfil).
// El `reason` explica por qué la fila cuenta contra el límite (proceso vivo, iniciando,
// o sesión registrada sin proceso). cameraName lo resuelve la ruta (necesita DB).
export interface TranscodeSlot {
  cameraId:      string
  userId:        string
  viewId:        string
  streamPath:    string
  pid:           number | undefined
  processAlive:  boolean
  startedAt:     Date
  lastHeartbeat: Date
  profile:       { width: string; fps: string; bitrate: string; encoder: string }
  reason:        string
}

export function getTranscodeSlots(): {
  maxTranscodes:      number
  activeProcessCount: number
  startingCount:      number
  slots:              TranscodeSlot[]
} {
  const counts = getTranscodeCounts()
  const procByPath = new Map(getActiveTranscodesList().map(p => [p.streamPath, p]))
  const cfg = resolveGridProfile()
  const profile = { width: cfg.width, fps: cfg.fps, bitrate: cfg.bitrate, encoder: cfg.encoder }

  const slots: TranscodeSlot[] = Array.from(sessions.values())
    .filter(s => s.streamType === 'main_h264')
    .map(s => {
      const proc     = procByPath.get(s.streamPath)
      const alive    = proc?.alive ?? false
      const inFlight = transcodeInFlight.get(s.streamPath)
      const reason = alive
        ? 'proceso FFmpeg activo con sesión registrada'
        : inFlight?.state === 'starting'
          ? 'iniciando — esperando manifest HLS'
          : 'sesión registrada sin proceso FFmpeg vivo (posible reinicio del supervisor)'
      return {
        cameraId:      s.cameraId,
        userId:        s.userId,
        viewId:        s.viewId,
        streamPath:    s.streamPath,
        pid:           proc?.pid,
        processAlive:  alive,
        startedAt:     s.startedAt,
        lastHeartbeat: s.lastClientHeartbeat,
        profile,
        reason,
      }
    })

  return {
    maxTranscodes:      counts.max,
    activeProcessCount: counts.active,
    startingCount:      counts.starting,
    slots,
  }
}

// Estado global de streams (para panel admin)
export async function getStreamManagerStatus(server: FastifyInstance) {
  const activeSessions = getActiveSessions()
  const uniqueCameras = new Set(activeSessions.map(s => s.cameraId))

  const cameraStatuses: Record<string, { readers: number; ready: boolean }> = {}
  for (const camId of uniqueCameras) {
    const session = activeSessions.find(s => s.cameraId === camId)
    if (session) {
      const st = await getStreamStatus(session.streamPath).catch(() => ({ active: false, readers: 0, bytesReceived: 0 }))
      cameraStatuses[camId] = { readers: st.readers, ready: st.active }
    }
  }

  return {
    totalSessions: activeSessions.length,
    uniqueCameras: uniqueCameras.size,
    activeViews: viewHeartbeat.size,
    maxPerUser: MAX_STREAMS_PER_USER,
    maxGlobal: MAX_STREAMS_GLOBAL,
    sessions: activeSessions.map(s => ({
      cameraId:     s.cameraId,
      userId:       s.userId,
      viewId:       s.viewId,
      streamPath:   s.streamPath,
      startedAt:    s.startedAt,
      lastHeartbeat: s.lastClientHeartbeat,
      mediaStatus:  cameraStatuses[s.cameraId],
    })),
  }
}
