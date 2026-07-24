// apps/api/src/jobs/healthWorker.ts
// Verifica el estado de todos los NVRs y cámaras cada 60 segundos
import cron from 'node-cron'
import type { FastifyInstance } from 'fastify'
import { getNVRStatus, getNvrChannelHealth } from '../services/hikvision'
import { broadcastAlert } from '../routes/websocket'
import {
  publishStream, getStreamPath, listRegisteredConfigPaths, clearRegisteredPath,
  getMediaMtxRuntimePaths, probeHlsManifest,
} from '../services/stream'
import { sendAlertNotification } from '../services/notification.service'
import { cleanupIdleSessions, getActiveSessions } from '../services/stream-manager'
import {
  observeCameraPaths, applyProbeResult, selectProbeTargets,
  type DemandedPathState, type CameraPipelineResult, type EffectiveStreamType,
} from '../services/stream-observation'
import { resolveCameraAlertQuiet } from '../services/camera-alerts'
import { decryptNvrPasswordOrNull as decryptPass } from '../services/credentials'
import {
  stepDebounce, initialDebounceState, isCameraInMaintenance,
  type DebounceState, type HealthObservation, type DebounceConfig,
} from '../services/camera-health-debounce'
import { shouldFeedStreamDebounce } from '../services/camera-stream-diagnostics'
import { raiseCameraAlert, recoverCameraAlert } from '../services/camera-alerts'

// Estado de debounce por cámara (en memoria; se pierde al reiniciar el API, lo que
// sólo re-arma la confirmación — nunca crea alertas de más). Dos dominios
// independientes: señal física (InputProxy) y pipeline de streaming (RTSP/HLS).
const cameraOfflineDebounce = new Map<string, DebounceState>()
const cameraStreamDebounce  = new Map<string, DebounceState>()

// Nº de comprobaciones consecutivas para CONFIRMAR (además del umbral por tiempo).
const OFFLINE_CONFIRM_CHECKS = Number(process.env.CAMERA_OFFLINE_CONFIRM_CHECKS ?? 3)
const STREAM_ERROR_CONFIRM_CHECKS = Number(process.env.CAMERA_STREAM_ERROR_CONFIRM_CHECKS ?? 3)
const HEALTH_INTERVAL_SEC = 60
// Ventana de demanda para el pipeline: un start-stream fallido dentro de esta
// ventana cuenta como "alguien pidió video y no salió" (evidencia de fallo real).
const STREAM_DEMAND_WINDOW_MS = Number(process.env.CAMERA_STREAM_DEMAND_WINDOW_MS ?? 10 * 60 * 1000)
// Sondas HLS activas por ciclo (cada sonda a un path on-demand dispara una conexión
// RTSP al NVR — acotado para no abrir RTSP contra las 144 cámaras).
const HLS_PROBE_MAX_PER_CYCLE = Number(process.env.CAMERA_STREAM_HLS_PROBE_MAX_PER_CYCLE ?? 3)
// Timeout de cada sonda HLS (configurable).
const HLS_PROBE_TIMEOUT_MS = Number(process.env.CAMERA_STREAM_HLS_PROBE_TIMEOUT_MS ?? 4000)
// Alertas STREAM_DEGRADED (sub caído, fallback main/main_h264 entregando).
// OPCIONAL: off por defecto — el estado degradado SIEMPRE se loguea igual.
const STREAM_DEGRADED_ALERTS = process.env.CAMERA_STREAM_DEGRADED_ALERTS === 'true'

// Fairness round-robin del presupuesto de sondas: última sonda por cámara.
const probeLastAt = new Map<string, number>()
// Historial de bytes por PATH (detecta streams CONGELADOS entre ciclos: path
// ready con lectores pero bytes sin progresar — siempre sobre el path efectivo).
const pathBytesHistory = new Map<string, { bytes: number; atMs: number }>()

// Exportado sólo para tests/diagnóstico: lee el estado de debounce actual.
export function getCameraDebounceSnapshot(cameraId: string) {
  return {
    offline: cameraOfflineDebounce.get(cameraId) ?? null,
    stream:  cameraStreamDebounce.get(cameraId) ?? null,
  }
}

// Nombre del path de MediaMTX (SIN credenciales — es sólo el identificador del
// path, p.ej. nvr_xxx_ch09_sub). Nunca expone RTSP con user/pass.
function safeStreamPath(nvr: any, camera: any): string {
  try { return getStreamPath(nvr, camera) } catch { return `nvr_${nvr.id}_ch${String(camera.channel).padStart(2, '0')}_sub` }
}

// La observación de pipeline vive en services/stream-observation.ts (PURA):
// estado RUNTIME de MediaMTX + evidencia de demanda. Ya NO se confía en
// rtspMainOk/rtspSubOk persistidos (podían quedar true indefinidamente — caso
// real: Sala Recuperación Endoscopía HEALTHY en DB con MediaMTX sin video).

// Throttle DECRYPT_ERROR logs: solo una vez cada 10 minutos por NVR
const decryptErrorLastLog = new Map<string, number>()
const DECRYPT_ERROR_LOG_INTERVAL_MS = 10 * 60 * 1000

function logDecryptError(server: FastifyInstance, nvrId: string, nvrName: string, context: string) {
  const now = Date.now()
  const last = decryptErrorLastLog.get(nvrId) ?? 0
  if (now - last >= DECRYPT_ERROR_LOG_INTERVAL_MS) {
    decryptErrorLastLog.set(nvrId, now)
    server.log.error(`[${context}] DECRYPT_ERROR para NVR ${nvrName} (${nvrId}) — contraseña no descifrable. Verifica NVR_CREDENTIAL_KEY y vuelve a guardar las credenciales del NVR.`)
  }
}

export function startHealthWorker(server: FastifyInstance) {
  // Guard de reentrancia: un ciclo puede superar los 60s (ISAPI lentos + sondas
  // HLS). Si el anterior sigue corriendo, saltar este tick — solapar ciclos
  // duplicaría observaciones del debounce y sondas contra los mismos NVRs.
  let healthCycleRunning = false

  // Verificar estado de NVRs cada 60 segundos
  cron.schedule('*/60 * * * * *', async () => {
    if (healthCycleRunning) {
      server.log.warn('[camera-health] health_cycle_skipped reason=previous_cycle_still_running')
      return
    }
    healthCycleRunning = true
    try {
      const nvrs = await server.prisma.nVR.findMany({
        where: { active: true },
        include: { cameras: { where: { active: true } } },
      })

      // ── Snapshot del pipeline (UNA VEZ por ciclo, no por cámara) ──
      // Estado RUNTIME real de MediaMTX (/v3/paths/list), paths configurados y
      // sesiones activas por cámara. null = API caída → observaciones UNKNOWN.
      const mtxRuntime = await getMediaMtxRuntimePaths()
      const mtxConfig  = await listRegisteredConfigPaths()
      if (mtxRuntime === null) {
        server.log.warn('[camera-health] mediamtx_api_unavailable — pipeline observations => UNKNOWN este ciclo')
      }
      // Sesiones COMPLETAS por cámara (userId/viewId/streamType/streamPath): la
      // observación debe evaluar los paths REALMENTE demandados, no un único _sub
      // calculado (evidencia real: Salida UTI reproducía _main_h264 por fallback y
      // se sondeaba _sub → CAMERA_STREAM_ERROR falso).
      const sessionsByCamera = new Map<string, Array<{ userId: string; viewId: string; streamType: string; streamPath: string }>>()
      for (const s of getActiveSessions()) {
        const list = sessionsByCamera.get(s.cameraId) ?? []
        list.push({ userId: s.userId, viewId: s.viewId, streamType: s.streamType, streamPath: s.streamPath })
        sessionsByCamera.set(s.cameraId, list)
      }
      const mtxReadyCameraIds: string[] = []
      // Evaluaciones de pipeline recolectadas en la fase A; las sondas (con
      // fairness round-robin) y el debounce corren en la fase B tras el loop.
      interface StreamEval {
        camera: any
        camCtx: { id: string; name: string; channel: number }
        nvrCtx: { id: string; name: string }
        maint: boolean
        cfg: DebounceConfig
        paths: DemandedPathState[]
        result: CameraPipelineResult
        primaryProbePath: string
        anyPathReady: boolean
        hardStartFailure: boolean
        hlsStatus: string
      }
      const streamEvals: StreamEval[] = []

      for (const nvr of nvrs) {
        try {
          const plainPass = decryptPass(nvr.password)
          if (!plainPass) {
            logDecryptError(server, nvr.id, nvr.name, 'healthWorker')
            continue
          }
          const nvrDecrypted = { ...nvr, password: plainPass }
          const status = await getNVRStatus(nvrDecrypted as any)

          if (!status.online) {
            // Crear alerta si el NVR está offline
            const existingAlert = await server.prisma.alert.findFirst({
              where: { nvrId: nvr.id, type: 'NVR_OFFLINE', resolved: false },
            })

            if (!existingAlert) {
              const alert = await server.prisma.alert.create({
                data: {
                  nvrId: nvr.id,
                  type: 'NVR_OFFLINE',
                  severity: 'HIGH',
                  message: `NVR ${nvr.name} está offline`,
                  detail: { ipAddress: nvr.ipAddress },
                },
              })

              broadcastAlert({
                type: 'alert',
                alert: {
                  id: alert.id,
                  type: alert.type,
                  severity: alert.severity,
                  message: alert.message,
                  nvrName: nvr.name,
                  createdAt: alert.createdAt,
                },
              })

              // Enviar email automático (no bloquea el worker)
              sendAlertNotification(server.prisma, {
                id: alert.id,
                type: alert.type,
                severity: alert.severity,
                message: alert.message,
                detail: alert.detail,
                nvrId: alert.nvrId,
              }).catch((e) => server.log.error(`Email NVR_OFFLINE: ${e}`))
            }

            // Marcar NVR offline; no tocar camera.online — el validador RTSP lo gestiona
            await server.prisma.nVR.update({
              where: { id: nvr.id },
              data: { online: false },
            })
            await server.prisma.camera.updateMany({
              where: { nvrId: nvr.id },
              data: { onlineInNvr: false } as any,
            })
          } else {
            // NVR online: resolver alerta si existía
            await server.prisma.alert.updateMany({
              where: { nvrId: nvr.id, type: 'NVR_OFFLINE', resolved: false },
              data: { resolved: true, resolvedAt: new Date() },
            })

            // Verificar HDD lleno
            if (status.diskUsage >= 90) {
              const existingDiskAlert = await server.prisma.alert.findFirst({
                where: { nvrId: nvr.id, type: 'HDD_FULL', resolved: false },
              })

              if (!existingDiskAlert) {
                const alert = await server.prisma.alert.create({
                  data: {
                    nvrId: nvr.id,
                    type: 'HDD_FULL',
                    severity: status.diskUsage >= 95 ? 'CRITICAL' : 'HIGH',
                    message: `HDD de ${nvr.name} al ${status.diskUsage}% de capacidad`,
                    detail: { diskUsage: status.diskUsage },
                  },
                })

                broadcastAlert({
                  type: 'alert',
                  alert: { ...alert, nvrName: nvr.name },
                })

                sendAlertNotification(server.prisma, {
                  id: alert.id,
                  type: alert.type,
                  severity: alert.severity,
                  message: alert.message,
                  detail: alert.detail,
                  nvrId: alert.nvrId,
                }).catch((e) => server.log.error(`Email HDD_FULL: ${e}`))
              }
            }

            // Salud por cámara desde InputProxy (fuente FIABLE), con DEBOUNCE.
            // getNVRChannels() marcaba online=true a todo canal → nunca detectaba
            // una IP-cam físicamente caída. Ahora UNKNOWN no toca onlineInNvr ni los
            // contadores; OFFLINE/ONLINE se confirman con histéresis.
            const healthList = await getNvrChannelHealth(nvrDecrypted as any)
            const nowMs = Date.now()
            const checkedAt = new Date(nowMs)
            const onlineCameraIds: string[] = []
            const offlineCameraIds: string[] = []
            const nvrCtx = { id: nvr.id, name: nvr.name }

            for (const camera of nvr.cameras) {
              const health = healthList.find((h) => h.channel === camera.channel)
              const status: HealthObservation = health?.status ?? 'UNKNOWN'
              const camCtx = { id: camera.id, name: camera.name, channel: camera.channel }
              server.log.info(
                `[camera-health] camera_health_check cameraId=${camera.id} channel=${camera.channel}` +
                ` status=${status} source=${health?.source ?? 'none'} chanDetect=${health?.chanDetectResult ?? 'n/a'}`
              )

              const maint = isCameraInMaintenance(camera, nowMs)
              const cfg: DebounceConfig = {
                offlineConfirmChecks: OFFLINE_CONFIRM_CHECKS,
                offlineConfirmMs: ((camera as any).offlineConfirmSec ?? 90) * 1000,
                recoveryConfirmChecks: Math.max(1, Math.round(((camera as any).recoveryConfirmSec ?? 120) / HEALTH_INTERVAL_SEC)),
              }

              if (status === 'UNKNOWN') {
                // Evidencia física insuficiente: NO tocar onlineInNvr ni contadores del
                // debounce físico, NO alertar CAMERA_OFFLINE. El pipeline SÍ se evalúa
                // más abajo (físico ONLINE o UNKNOWN alimentan el debounce de stream).
                server.log.info(`[camera-health] camera_health_unknown cameraId=${camera.id} channel=${camera.channel} — sin actualizar onlineInNvr`)
              } else {
              if (status === 'ONLINE') onlineCameraIds.push(camera.id)
              else offlineCameraIds.push(camera.id)

              const prev = cameraOfflineDebounce.get(camera.id) ?? initialDebounceState()
              const { state, action } = stepDebounce(prev, status, nowMs, cfg)
              cameraOfflineDebounce.set(camera.id, state)

              if (action === 'offline_pending') {
                server.log.info(`[camera-health] camera_offline_pending cameraId=${camera.id} channel=${camera.channel} firstFailureAt=${new Date(state.firstFailureAt ?? nowMs).toISOString()}`)
              } else if (action === 'confirm_offline') {
                if ((camera as any).offlineAlertEnabled === false || maint) {
                  server.log.info(`[camera-health] camera_offline_confirmed_suppressed cameraId=${camera.id} reason=${maint ? 'maintenance' : 'alert_disabled'}`)
                } else {
                  server.log.warn(`[camera-health] camera_offline_confirmed cameraId=${camera.id} nvrId=${nvr.id} channel=${camera.channel} firstFailureAt=${new Date(state.firstFailureAt ?? nowMs).toISOString()} confirmedAt=${new Date(state.confirmedAt ?? nowMs).toISOString()}`)
                  await raiseCameraAlert(server, {
                    camera: camCtx, nvr: nvrCtx, type: 'CAMERA_OFFLINE',
                    severity: (camera as any).offlineSeverity ?? 'HIGH',
                    message: `Cámara ${camera.name} sin señal en ${nvr.name}`,
                    detail: {
                      channel: camera.channel, nvrName: nvr.name, detectedBy: 'inputproxy',
                      firstFailureAt: new Date(state.firstFailureAt ?? nowMs).toISOString(),
                      confirmedAt: new Date(state.confirmedAt ?? nowMs).toISOString(),
                      isapiEvidence: { status: health?.status, source: health?.source, onlineRaw: health?.onlineRaw, chanDetectResult: health?.chanDetectResult, passwordStatus: health?.passwordStatus, ipAddress: health?.ipAddress },
                    },
                    sendEmail: (camera as any).sendEmailOnOffline !== false,
                  })
                }
              } else if (action === 'recover') {
                server.log.info(`[camera-health] camera_signal_recovered cameraId=${camera.id} channel=${camera.channel} nvrId=${nvr.id}`)
                await recoverCameraAlert(server, {
                  camera: camCtx, nvr: nvrCtx, offlineType: 'CAMERA_OFFLINE', recoveredType: 'CAMERA_RECOVERED',
                  message: `Cámara ${camera.name} recuperó señal en ${nvr.name}`,
                  detail: { channel: camera.channel, nvrName: nvr.name },
                  sendEmail: (camera as any).sendEmailOnRecovery !== false,
                })
              }
              }  // fin del bloque físico (status !== UNKNOWN)

              // ── Pipeline de streaming — FASE A: evaluar los paths REALMENTE
              //    demandados (sesiones con streamType/streamPath), no un único
              //    _sub calculado. Las sondas + debounce corren en la FASE B con
              //    fairness round-robin. Sólo si el físico NO es OFFLINE confirmado.
              if (shouldFeedStreamDebounce(status)) {
                const c = camera as any
                const subPath = safeStreamPath(nvrDecrypted, camera)
                const camSessions = sessionsByCamera.get(camera.id) ?? []
                // Paths efectivamente demandados: los de las sesiones activas; sin
                // sesiones, el _sub por defecto (es el que pediría el grid).
                const pathGroups = new Map<string, { streamType: EffectiveStreamType; sessions: number }>()
                for (const s of camSessions) {
                  const g = pathGroups.get(s.streamPath) ?? {
                    streamType: (['sub', 'main', 'main_h264'].includes(s.streamType) ? s.streamType : 'unknown') as EffectiveStreamType,
                    sessions: 0,
                  }
                  g.sessions++
                  pathGroups.set(s.streamPath, g)
                }
                if (pathGroups.size === 0) pathGroups.set(subPath, { streamType: 'sub', sessions: 0 })

                const paths: DemandedPathState[] = [...pathGroups.entries()].map(([path, g]) => {
                  const runtime = mtxRuntime?.get(path) ?? null
                  const prevBytes = pathBytesHistory.get(path)
                  const bytes = runtime?.bytesReceived ?? 0
                  // Progresión de bytes entre ciclos (sólo con historial previo).
                  const bytesProgressed = prevBytes ? bytes > prevBytes.bytes : null
                  if (runtime) pathBytesHistory.set(path, { bytes, atMs: nowMs })
                  return {
                    path, streamType: g.streamType, sessions: g.sessions,
                    configured: mtxConfig === null ? null : mtxConfig.has(path),
                    runtimeFound: mtxRuntime === null ? null : runtime !== null,
                    ready: runtime?.ready === true,
                    bytesReceived: bytes,
                    readers: runtime?.readers ?? 0,
                    bytesProgressed,
                  }
                })
                const demand = {
                  activeSessions: camSessions.length,
                  lastStreamFailureAt: c.lastStreamFailureAt ? new Date(c.lastStreamFailureAt).getTime() : null,
                  lastStreamStartAcceptedAt: c.lastStreamStartAcceptedAt ? new Date(c.lastStreamStartAcceptedAt).getTime() : null,
                  lastHlsSuccessAt: c.lastHlsSuccessAt ? new Date(c.lastHlsSuccessAt).getTime() : null,
                }
                const subKnownDown = c.rtspSubOk === false || c.streamHealthStatus === 'RTSP_SUB_NOT_FOUND'
                const result = observeCameraPaths(paths, demand, subKnownDown, nowMs, STREAM_DEMAND_WINDOW_MS)
                // Mismo criterio que observeCameraPaths: el fallo debe ser posterior
                // a la última evidencia POSITIVA (start aceptado o HLS verificado).
                const hardStartFailure =
                  demand.lastStreamFailureAt != null &&
                  nowMs - demand.lastStreamFailureAt <= STREAM_DEMAND_WINDOW_MS &&
                  demand.lastStreamFailureAt >= Math.max(demand.lastStreamStartAcceptedAt ?? 0, demand.lastHlsSuccessAt ?? 0)

                if (paths.some(p => p.ready)) mtxReadyCameraIds.push(camera.id)
                streamEvals.push({
                  camera: c, camCtx, nvrCtx, maint, cfg, paths, result,
                  // Sondear el path con MÁS sesiones (el que el usuario realmente ve).
                  primaryProbePath: [...pathGroups.entries()].sort((a, b) => b[1].sessions - a[1].sessions)[0][0],
                  anyPathReady: paths.some(p => p.ready),
                  hardStartFailure,
                  hlsStatus: 'not_probed',
                })
              }
            }

            // Only update onlineInNvr — never overwrite RTSP-based online field
            // here. UNKNOWN quedó excluido de ambas listas (no se toca su estado).
            if (onlineCameraIds.length > 0) {
              await server.prisma.camera.updateMany({
                where: { id: { in: onlineCameraIds } },
                data: { onlineInNvr: true, lastCheck: checkedAt } as any,
              })
            }
            if (offlineCameraIds.length > 0) {
              await server.prisma.camera.updateMany({
                where: { id: { in: offlineCameraIds } },
                data: { onlineInNvr: false, lastCheck: checkedAt } as any,
              })
            }

            await server.prisma.nVR.update({
              where: { id: nvr.id },
              data: { online: true, lastSeen: new Date(), firmware: status.firmware },
            })
          }
        } catch (err) {
          server.log.error(`Health check error para NVR ${nvr.name}: ${err}`)
        }
      }

      // ── FASE B: sondas HLS con fairness round-robin + debounce + alertas ──
      const nowMsB = Date.now()
      // Candidatas a sonda: sospecha OFFLINE (confirmar antes de contar) o error ya
      // confirmado en UNKNOWN (detectar recuperación aunque no haya demanda).
      const wantProbe = streamEvals.filter(e => {
        const st = cameraStreamDebounce.get(e.camera.id) ?? initialDebounceState()
        return e.result.observation === 'OFFLINE' ||
          (e.result.observation === 'UNKNOWN' && st.phase === 'OFFLINE_CONFIRMED')
      })
      // Round-robin: prioridad a las sondeadas hace MÁS tiempo — con más candidatas
      // que presupuesto, todas reciben sonda en ciclos sucesivos.
      const probeTargets = new Set(selectProbeTargets(wantProbe.map(e => e.camera.id), probeLastAt, HLS_PROBE_MAX_PER_CYCLE))
      for (const e of wantProbe) {
        if (!probeTargets.has(e.camera.id)) continue
        probeLastAt.set(e.camera.id, nowMsB)
        const probe = await probeHlsManifest(e.primaryProbePath, HLS_PROBE_TIMEOUT_MS)
        e.hlsStatus = probe.playable ? 'playable' : (probe.reachable ? `reachable_status_${probe.status}` : `unreachable_status_${probe.status}`)
        server.log.info(
          `[camera-health] camera_stream_probe cameraId=${e.camera.id} path=${e.primaryProbePath}` +
          ` playable=${probe.playable} status=${probe.status} priorObs=${e.result.observation} reason=${e.result.reason}`
        )
        // status=0 aislado NO fuerza OFFLINE (regla 6): sólo con evidencia adicional.
        const upd = applyProbeResult(e.result, probe, { anyPathReady: e.anyPathReady, hardStartFailure: e.hardStartFailure })
        e.result = { ...e.result, observation: upd.observation, reason: upd.reason }
        if (probe.playable) {
          // Éxito REAL verificado (frames HLS) — no un start aceptado.
          await server.prisma.camera.update({
            where: { id: e.camera.id },
            data: { lastHlsSuccessAt: new Date(nowMsB), lastStreamSuccessAt: new Date(nowMsB) } as any,
          }).catch(() => {})
        }
      }

      // Debounce + alertas para TODAS las evaluaciones.
      for (const e of streamEvals) {
        const { observation, reason, degraded } = e.result
        const c = e.camera
        // Estado DEGRADED (sub caído, fallback entregando): informar sin contar
        // como pérdida total. Alerta opcional (env), log siempre.
        if (observation === 'ONLINE' && degraded) {
          server.log.info(`[camera-health] camera_stream_degraded cameraId=${c.id} channel=${e.camCtx.channel} reason=${reason} — substream no disponible, usando flujo principal`)
          if (STREAM_DEGRADED_ALERTS && c.streamErrorAlertEnabled !== false && !e.maint) {
            await raiseCameraAlert(server, {
              camera: e.camCtx, nvr: e.nvrCtx, type: 'STREAM_DEGRADED',
              severity: 'LOW',
              message: `Substream no disponible en ${e.camCtx.name}; usando flujo principal`,
              detail: { channel: e.camCtx.channel, paths: e.paths.map(p => ({ path: p.path, streamType: p.streamType, ready: p.ready })) },
              sendEmail: false,
            })
          }
        } else if (observation === 'ONLINE' && !degraded) {
          await resolveCameraAlertQuiet(server, c.id, 'STREAM_DEGRADED').catch(() => {})
        }

        if (observation === 'UNKNOWN') continue
        const sPrev = cameraStreamDebounce.get(c.id) ?? initialDebounceState()
        const sCfg: DebounceConfig = { offlineConfirmChecks: STREAM_ERROR_CONFIRM_CHECKS, offlineConfirmMs: e.cfg.offlineConfirmMs, recoveryConfirmChecks: e.cfg.recoveryConfirmChecks }
        const s = stepDebounce(sPrev, observation, nowMsB, sCfg)
        cameraStreamDebounce.set(c.id, s.state)
        if (observation === 'OFFLINE') {
          server.log.info(
            `[camera-health] camera_stream_failure cameraId=${c.id} channel=${e.camCtx.channel}` +
            ` reason=${reason} paths=[${e.paths.map(p => `${p.path}:${p.streamType}:${p.ready ? 'ready' : 'not_ready'}`).join(',')}]` +
            ` sessions=${e.paths.reduce((n, p) => n + p.sessions, 0)} lastErrorCode=${c.lastStreamErrorCode ?? 'n/a'} hls=${e.hlsStatus} streak=${s.state.offlineStreak}`
          )
        }
        if (s.action === 'confirm_offline') {
          // El fallback murió del todo: la condición de degradación ya no existe —
          // resolver STREAM_DEGRADED para que no quede activa junto al stream-error
          // indefinidamente (review Codex #116).
          await resolveCameraAlertQuiet(server, c.id, 'STREAM_DEGRADED').catch(() => {})
          if (c.streamErrorAlertEnabled === false || e.maint) {
            server.log.info(`[camera-health] camera_stream_error_suppressed cameraId=${c.id} reason=${e.maint ? 'maintenance' : 'alert_disabled'}`)
          } else {
            server.log.warn(`[camera-health] camera_stream_error_confirmed cameraId=${c.id} channel=${e.camCtx.channel} nvrId=${e.nvrCtx.id} reason=${reason}`)
            await raiseCameraAlert(server, {
              camera: e.camCtx, nvr: e.nvrCtx, type: 'CAMERA_STREAM_ERROR',
              severity: c.streamErrorSeverity ?? 'MEDIUM',
              message: `Error de pipeline de streaming en ${e.camCtx.name} (${e.nvrCtx.name})`,
              detail: {
                channel: e.camCtx.channel,
                effectivePaths: e.paths.map(p => ({ path: p.path, streamType: p.streamType, sessions: p.sessions, ready: p.ready, readers: p.readers, bytesProgressed: p.bytesProgressed })),
                streamPath: e.primaryProbePath,
                hlsStatus: e.hlsStatus,
                observationReason: reason,
                rtspMainStatus: c.rtspMainOk, rtspSubStatus: c.rtspSubOk,
                lastErrorCode: c.lastStreamErrorCode ?? c.lastRtspError ?? null,
                lastStreamFailureAt: c.lastStreamFailureAt ?? null,
                lastStreamStartAcceptedAt: c.lastStreamStartAcceptedAt ?? null,
                consecutiveFailures: s.state.offlineStreak,
                firstFailureAt: new Date(s.state.firstFailureAt ?? nowMsB).toISOString(),
              },
              sendEmail: false,   // el stream-error no spamea email por defecto
            })
          }
        } else if (s.action === 'recover') {
          server.log.info(`[camera-health] camera_stream_recovered cameraId=${c.id} channel=${e.camCtx.channel} reason=${reason}`)
          await recoverCameraAlert(server, {
            camera: e.camCtx, nvr: e.nvrCtx, offlineType: 'CAMERA_STREAM_ERROR', recoveredType: 'CAMERA_STREAM_RECOVERED',
            message: `Pipeline de streaming recuperado en ${e.camCtx.name}`,
            detail: { channel: e.camCtx.channel, streamPath: e.primaryProbePath, hlsStatus: e.hlsStatus, recoveredBy: reason },
            sendEmail: false,
          })
        }
      }

      // Evidencia persistida: cámaras cuyo path estuvo READY en MediaMTX este ciclo.
      if (mtxReadyCameraIds.length > 0) {
        await server.prisma.camera.updateMany({
          where: { id: { in: mtxReadyCameraIds } },
          data: { lastMediaMtxReadyAt: new Date() } as any,
        }).catch(() => {})
      }
    } catch (err) {
      server.log.error(`Health worker error: ${err}`)
    } finally {
      healthCycleRunning = false
    }
  })

  // Re-registrar paths en MediaMTX cada 5 minutos (recupera reinicios de mediamtx)
  // Solo registra paths que faltan en MediaMTX — evita spam "path already exists" /
  // "reloading configuration" cuando los paths ya existen con la config correcta.
  cron.schedule('*/5 * * * *', async () => {
    try {
      // Obtener qué paths tiene MediaMTX configurados actualmente.
      // Si la API no responde (null), saltar este ciclo sin hacer nada.
      const mediamtxPaths = await listRegisteredConfigPaths()
      if (mediamtxPaths === null) return  // MediaMTX no disponible

      const nvrs = await server.prisma.nVR.findMany({
        where: { active: true },
        include: { cameras: { where: { active: true } } },
      })

      let registered = 0
      for (const nvr of nvrs) {
        const plainPass = decryptPass(nvr.password)
        if (!plainPass) {
          logDecryptError(server, nvr.id, nvr.name, 'healthWorker:streams')
          continue
        }
        const nvrDecrypted = { ...nvr, password: plainPass }
        for (const camera of nvr.cameras) {
          // Skip cameras where RTSP is confirmed down — don't register paths that will 500
          const camRtspSubOk = (camera as any).rtspSubOk as boolean | null
          if (camera.online === false || camRtspSubOk === false) continue
          const path = getStreamPath(nvrDecrypted as any, camera)
          if (!mediamtxPaths.has(path)) {
            // Path ausente en MediaMTX (p.ej. reinicio de MediaMTX) — re-registrar
            clearRegisteredPath(path)  // invalidar cache local para forzar POST
            await publishStream(nvrDecrypted as any, camera)
            registered++
          }
        }
      }

      if (registered > 0) {
        server.log.info(`[healthWorker] ${registered} path(s) re-registrados en MediaMTX tras reinicio`)
      }
    } catch {
      // Silencioso — mediamtx puede estar temporalmente caído
    }
  })

  // Limpiar sesiones de stream idle cada 2 minutos
  cron.schedule('*/2 * * * *', async () => {
    const removed = await cleanupIdleSessions(server)
    if (removed > 0) server.log.info(`[stream-manager] ${removed} sesiones idle eliminadas`)
  })

  // Limpiar sesiones expiradas cada hora
  cron.schedule('0 * * * *', async () => {
    await server.prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
  })

  // Retención de datos: purga diaria (03:30) de tablas que crecen sin límite.
  // Plazos configurables por env; 0 desactiva la purga de esa tabla.
  const ALERTS_RETENTION_DAYS     = Number(process.env.ALERTS_RETENTION_DAYS ?? 90)
  const DELIVERIES_RETENTION_DAYS = Number(process.env.DELIVERIES_RETENTION_DAYS ?? 90)
  const AUDIT_RETENTION_DAYS      = Number(process.env.AUDIT_RETENTION_DAYS ?? 365)
  const ANALYTICS_RETENTION_DAYS  = Number(process.env.ANALYTICS_RETENTION_DAYS ?? 30)
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)

  cron.schedule('30 3 * * *', async () => {
    try {
      let purged = { alerts: 0, deliveries: 0, audit: 0 }
      if (ALERTS_RETENTION_DAYS > 0) {
        // Solo alertas ya resueltas — las activas nunca se purgan
        const r = await server.prisma.alert.deleteMany({
          where: { resolved: true, createdAt: { lt: daysAgo(ALERTS_RETENTION_DAYS) } },
        })
        purged.alerts = r.count
      }
      if (DELIVERIES_RETENTION_DAYS > 0) {
        const r = await server.prisma.notificationDelivery.deleteMany({
          where: { createdAt: { lt: daysAgo(DELIVERIES_RETENTION_DAYS) } },
        })
        purged.deliveries = r.count
      }
      if (AUDIT_RETENTION_DAYS > 0) {
        const r = await server.prisma.auditLog.deleteMany({
          where: { createdAt: { lt: daysAgo(AUDIT_RETENTION_DAYS) } },
        })
        purged.audit = r.count
      }
      let purgedAnalytics = 0
      if (ANALYTICS_RETENTION_DAYS > 0) {
        const r = await server.prisma.analyticsEvent.deleteMany({
          where: { occurredAt: { lt: daysAgo(ANALYTICS_RETENTION_DAYS) } },
        })
        purgedAnalytics = r.count
      }
      if (purged.alerts + purged.deliveries + purged.audit + purgedAnalytics > 0) {
        server.log.info(
          `[retention] purga diaria: alerts=${purged.alerts} (${ALERTS_RETENTION_DAYS}d)` +
          ` deliveries=${purged.deliveries} (${DELIVERIES_RETENTION_DAYS}d)` +
          ` auditLogs=${purged.audit} (${AUDIT_RETENTION_DAYS}d)` +
          ` analyticsEvents=${purgedAnalytics} (${ANALYTICS_RETENTION_DAYS}d)`
        )
      }
    } catch (err) {
      server.log.error(`[retention] error en purga diaria: ${err}`)
    }
  })

  server.log.info('Health worker iniciado (intervalo: 60s)')
}
