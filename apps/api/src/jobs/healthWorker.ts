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
import { observeStreamPipeline } from '../services/stream-observation'
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
      const sessionsByCamera = new Map<string, number>()
      for (const s of getActiveSessions()) {
        sessionsByCamera.set(s.cameraId, (sessionsByCamera.get(s.cameraId) ?? 0) + 1)
      }
      // Presupuesto de sondas HLS activas del ciclo (compartido entre NVRs).
      const probeState = { remaining: HLS_PROBE_MAX_PER_CYCLE }
      const mtxReadyCameraIds: string[] = []

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

              // ── Pipeline de streaming (independiente): sólo si el físico NO es
              //    OFFLINE confirmado. Observación REAL: runtime de MediaMTX +
              //    evidencia de demanda + sonda HLS acotada. Server-side puro.
              if (shouldFeedStreamDebounce(status)) {
                const c = camera as any
                const streamPath = safeStreamPath(nvrDecrypted, camera)
                const runtime = mtxRuntime?.get(streamPath) ?? null
                const mtxSnapshot = {
                  configured: mtxConfig === null ? null : mtxConfig.has(streamPath),
                  runtimeFound: mtxRuntime === null ? null : runtime !== null,
                  ready: runtime?.ready === true,
                  bytesReceived: runtime?.bytesReceived ?? 0,
                  readers: runtime?.readers ?? 0,
                }
                const demand = {
                  activeSessions: sessionsByCamera.get(camera.id) ?? 0,
                  lastStreamFailureAt: c.lastStreamFailureAt ? new Date(c.lastStreamFailureAt).getTime() : null,
                  lastStreamSuccessAt: c.lastStreamSuccessAt ? new Date(c.lastStreamSuccessAt).getTime() : null,
                  lastHlsSuccessAt:    c.lastHlsSuccessAt    ? new Date(c.lastHlsSuccessAt).getTime()    : null,
                }
                let { observation: streamObs, reason: streamReason } = observeStreamPipeline(mtxSnapshot, demand, nowMs, STREAM_DEMAND_WINDOW_MS)
                let hlsStatus: string = 'not_probed'

                const sPrevState = cameraStreamDebounce.get(camera.id) ?? initialDebounceState()
                // Sonda HLS activa (presupuesto acotado) en dos casos:
                //  a) sospecha OFFLINE → confirmar antes de contar el fallo;
                //  b) error YA confirmado y sin demanda (UNKNOWN) → detectar la
                //     RECUPERACIÓN aunque los usuarios hayan dejado de intentar.
                const wantProbe =
                  (streamObs === 'OFFLINE') ||
                  (streamObs === 'UNKNOWN' && sPrevState.phase === 'OFFLINE_CONFIRMED')
                if (wantProbe && probeState.remaining > 0) {
                  probeState.remaining--
                  const probe = await probeHlsManifest(streamPath)
                  hlsStatus = probe.playable ? 'playable' : (probe.reachable ? `reachable_status_${probe.status}` : `unreachable_status_${probe.status}`)
                  server.log.info(
                    `[camera-health] camera_stream_probe cameraId=${camera.id} path=${streamPath}` +
                    ` playable=${probe.playable} status=${probe.status} priorObs=${streamObs} reason=${streamReason}`
                  )
                  if (probe.playable) {
                    streamObs = 'ONLINE'
                    streamReason = 'hls_probe_playable'
                    await server.prisma.camera.update({
                      where: { id: camera.id },
                      data: { lastHlsSuccessAt: new Date(nowMs) } as any,
                    }).catch(() => {})
                  } else {
                    // La sonda ES demanda: pedimos video y no salió → fallo real.
                    streamObs = 'OFFLINE'
                    streamReason = `${streamReason}+hls_probe_failed`
                  }
                }

                if (mtxSnapshot.ready) mtxReadyCameraIds.push(camera.id)

                if (streamObs !== 'UNKNOWN') {
                  const sCfg: DebounceConfig = { offlineConfirmChecks: STREAM_ERROR_CONFIRM_CHECKS, offlineConfirmMs: cfg.offlineConfirmMs, recoveryConfirmChecks: cfg.recoveryConfirmChecks }
                  const s = stepDebounce(sPrevState, streamObs, nowMs, sCfg)
                  cameraStreamDebounce.set(camera.id, s.state)
                  if (streamObs === 'OFFLINE') {
                    server.log.info(
                      `[camera-health] camera_stream_failure cameraId=${camera.id} channel=${camera.channel}` +
                      ` reason=${streamReason} mediaMtxReady=${mtxSnapshot.ready} configured=${mtxSnapshot.configured}` +
                      ` sessions=${demand.activeSessions} lastErrorCode=${c.lastStreamErrorCode ?? 'n/a'} hls=${hlsStatus} streak=${s.state.offlineStreak}`
                    )
                  }
                  if (s.action === 'confirm_offline') {
                    if (c.streamErrorAlertEnabled === false || maint) {
                      server.log.info(`[camera-health] camera_stream_error_suppressed cameraId=${camera.id} reason=${maint ? 'maintenance' : 'alert_disabled'}`)
                    } else {
                      server.log.warn(`[camera-health] camera_stream_error_confirmed cameraId=${camera.id} channel=${camera.channel} nvrId=${nvr.id} reason=${streamReason}`)
                      await raiseCameraAlert(server, {
                        camera: camCtx, nvr: nvrCtx, type: 'CAMERA_STREAM_ERROR',
                        severity: c.streamErrorSeverity ?? 'MEDIUM',
                        message: `Error de pipeline de streaming en ${camera.name} (${nvr.name})`,
                        detail: {
                          channel: camera.channel, streamPath,
                          hlsStatus,
                          mediaMtxStatus: mtxSnapshot.runtimeFound === null ? 'api_unavailable'
                            : mtxSnapshot.ready ? 'ready'
                            : mtxSnapshot.configured === false ? 'path_missing' : 'source_not_ready',
                          observationReason: streamReason,
                          rtspMainStatus: c.rtspMainOk, rtspSubStatus: c.rtspSubOk,
                          lastErrorCode: c.lastStreamErrorCode ?? c.lastRtspError ?? null,
                          lastStreamFailureAt: c.lastStreamFailureAt ?? null,
                          lastStreamSuccessAt: c.lastStreamSuccessAt ?? null,
                          consecutiveFailures: s.state.offlineStreak,
                          firstFailureAt: new Date(s.state.firstFailureAt ?? nowMs).toISOString(),
                        },
                        sendEmail: false,   // el stream-error no spamea email por defecto
                      })
                    }
                  } else if (s.action === 'recover') {
                    server.log.info(`[camera-health] camera_stream_recovered cameraId=${camera.id} channel=${camera.channel} reason=${streamReason}`)
                    await recoverCameraAlert(server, {
                      camera: camCtx, nvr: nvrCtx, offlineType: 'CAMERA_STREAM_ERROR', recoveredType: 'CAMERA_STREAM_RECOVERED',
                      message: `Pipeline de streaming recuperado en ${camera.name}`,
                      detail: { channel: camera.channel, streamPath, hlsStatus, recoveredBy: streamReason },
                      sendEmail: false,
                    })
                  }
                }
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
