// apps/api/src/services/stream-reregister.ts
//
// Re-registro de streams en MediaMTX al arranque. MediaMTX pierde los paths
// dinámicos al reiniciarse; este helper los restaura.
//
// Extraído de server.ts para poder probar el AISLAMIENTO POR CÁMARA: un fallo
// puntual de publishStream (una cámara) NO debe abortar el re-registro del
// resto del lote. El comportamiento y los mensajes de log son idénticos al
// bloque inline previo; sólo se envolvió cada publishStream en try/catch.

export interface ReRegisterLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export interface ReRegisterCamera {
  id: string
}

export interface ReRegisterNvr {
  id: string
  name: string
  password: string
  cameras: ReRegisterCamera[]
}

export interface ReRegisterDeps {
  /** Descifra la contraseña del NVR; null/'' ⇒ se omite el NVR completo. */
  decryptPass: (enc: string) => string | null
  /** Publica (registra) el path on-demand de una cámara en MediaMTX. */
  publishStream: (nvr: unknown, camera: ReRegisterCamera) => Promise<unknown>
  log: ReRegisterLogger
}

export interface ReRegisterResult {
  count: number          // cámaras registradas OK
  skipped: number        // NVRs omitidos por DECRYPT_ERROR
  publishFailed: number  // cámaras con fallo puntual (aisladas)
}

export async function reRegisterStreams(
  nvrs: ReRegisterNvr[],
  deps: ReRegisterDeps,
): Promise<ReRegisterResult> {
  const { decryptPass, publishStream, log } = deps
  let count = 0
  let skipped = 0
  let publishFailed = 0

  for (const nvr of nvrs) {
    const plainPass = decryptPass(nvr.password)
    if (!plainPass) {
      log.error(`[startup] DECRYPT_ERROR para NVR ${nvr.name} (${nvr.id}) — streams omitidos. Verifica NVR_CREDENTIAL_KEY y vuelve a guardar las credenciales del NVR.`)
      skipped++
      continue
    }
    const nvrDecrypted = { ...nvr, password: plainPass }
    for (const camera of nvr.cameras) {
      // Aislamiento por cámara: un fallo puntual no aborta el resto del lote.
      try {
        await publishStream(nvrDecrypted, camera)
        count++
      } catch (camErr) {
        publishFailed++
        log.warn(`[startup] publishStream falló para cámara ${camera.id} (nvr=${nvr.id}) — se continúa con las demás: ${camErr instanceof Error ? camErr.message : String(camErr)}`)
      }
    }
  }

  log.info(`[startup] ${count} paths on-demand registrados en MediaMTX (RTSP inactivo hasta primer viewer — sourceOnDemand=true)${skipped > 0 ? ` | ${skipped} NVR(s) omitidos por DECRYPT_ERROR` : ''}${publishFailed > 0 ? ` | ${publishFailed} cámara(s) con fallo puntual` : ''}`)

  return { count, skipped, publishFailed }
}
