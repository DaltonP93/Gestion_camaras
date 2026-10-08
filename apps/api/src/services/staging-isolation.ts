// Aislamiento de una copia de staging (p.ej. el servidor nuevo durante el ensayo de
// migración). Controla TODO lo que la API hace por sí sola contra el mundo exterior
// al arrancar:
//   - sondeo periódico de NVR/cámaras (healthWorker, ciclo de 60 s), que además
//     genera alertas;
//   - sincronización de metadatos de cámaras contra los NVR (syncWorker);
//   - registro automático de paths en MediaMTX (al arrancar y cada 5 min), que es
//     lo que le da a MediaMTX las URLs RTSP de los NVR;
//   - notificaciones externas: email (alertas, prueba de SMTP, recuperación de
//     contraseña) y webhooks Slack/Teams/genérico.
//
// NO toca autenticación, sesiones, revocación de permisos ni de medios, limpiezas
// internas ni WebSocket hacia navegadores: esos siguen activos en staging.
//
// Variable AUSENTE ⇒ comportamiento IDÉNTICO al actual (todo ON).
// Variable PRESENTE ⇒ debe ser exactamente `true` o `false` (sin distinguir
// mayúsculas). Vacía, sólo espacios, con espacios alrededor o cualquier otro valor
// ⇒ error de arranque: una línea `STAGING_ISOLATION=` o `STAGING_ISOLATION= true`
// en el .env de la copia de staging no puede degradar en silencio a "todo ON".
// STAGING_ISOLATION=true apaga los cuatro y NO puede ser re-habilitado por las
// flags individuales (fail-closed).

export interface IsolationConfig {
  stagingIsolation: boolean
  nvrPolling: boolean
  nvrSync: boolean
  streamAutoRegister: boolean
  outboundNotifications: boolean
}

export const ISOLATION_FLAGS = {
  stagingIsolation: 'STAGING_ISOLATION',
  nvrPolling: 'NVR_POLLING_ENABLED',
  nvrSync: 'NVR_SYNC_ENABLED',
  streamAutoRegister: 'STREAM_AUTO_REGISTER_ENABLED',
  outboundNotifications: 'OUTBOUND_NOTIFICATIONS_ENABLED',
} as const

function parseFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined) return fallback
  const v = raw.toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  const shown = raw.trim() === '' ? `vacía (${JSON.stringify(raw)})` : JSON.stringify(raw.slice(0, 32))
  throw new Error(`[startup] ${name} presente pero inválida: ${shown}. Usar exactamente true o false, o quitar la variable`)
}

/** Resuelve la configuración. Lanza ante valores inválidos (fail-fast). */
export function resolveIsolationConfig(env: NodeJS.ProcessEnv = process.env): IsolationConfig {
  const stagingIsolation = parseFlag(env, ISOLATION_FLAGS.stagingIsolation, false)
  const nvrPolling = parseFlag(env, ISOLATION_FLAGS.nvrPolling, true)
  const nvrSync = parseFlag(env, ISOLATION_FLAGS.nvrSync, true)
  const streamAutoRegister = parseFlag(env, ISOLATION_FLAGS.streamAutoRegister, true)
  const outboundNotifications = parseFlag(env, ISOLATION_FLAGS.outboundNotifications, true)
  if (stagingIsolation) {
    return { stagingIsolation, nvrPolling: false, nvrSync: false, streamAutoRegister: false, outboundNotifications: false }
  }
  return { stagingIsolation, nvrPolling, nvrSync, streamAutoRegister, outboundNotifications }
}

/** Advertencias de arranque: flags individuales en true ignoradas por STAGING_ISOLATION. */
export function isolationWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const cfg = resolveIsolationConfig(env)
  if (!cfg.stagingIsolation) return []
  const ignored = (['nvrPolling', 'nvrSync', 'streamAutoRegister', 'outboundNotifications'] as const)
    .filter(k => env[ISOLATION_FLAGS[k]]?.toLowerCase() === 'true')
    .map(k => ISOLATION_FLAGS[k])
  return ignored.length
    ? [`[startup] STAGING_ISOLATION=true ignora ${ignored.join(', ')}=true (el aislamiento no se puede re-habilitar por flag)`]
    : []
}

/** Línea de log de arranque con el estado efectivo (sin secretos). */
export function describeIsolation(cfg: IsolationConfig): string {
  const on = (b: boolean) => (b ? 'on' : 'OFF')
  return `[startup] isolation staging=${cfg.stagingIsolation} nvr_polling=${on(cfg.nvrPolling)}` +
    ` nvr_sync=${on(cfg.nvrSync)} stream_auto_register=${on(cfg.streamAutoRegister)}` +
    ` outbound_notifications=${on(cfg.outboundNotifications)}`
}

/** Para los proveedores de salida (email/webhook): leído en cada envío. */
export function outboundNotificationsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveIsolationConfig(env).outboundNotifications
}

export const OUTBOUND_DISABLED_CODE = 'OUTBOUND_DISABLED'
export const OUTBOUND_DISABLED_MESSAGE = 'Notificaciones externas deshabilitadas (aislamiento de staging)'
