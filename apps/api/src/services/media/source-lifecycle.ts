// apps/api/src/services/media/source-lifecycle.ts
//
// N1 — Lifecycle de FUENTE de medios (MediaMTX source add/remove) → registro de
// instancia del plano de grants. Cierra el hueco honesto de C22.2: hasta ahora
// `registerSource`/`retireSource` existían pero NADA los conducía desde el
// lifecycle real, así que `issue` siempre se negaba (NO_MEDIA_INSTANCE).
//
//   - Recibe eventos MediaMTX (onReady/onNotReady) y reconcilia contra la lista
//     VIVA de paths (`/v3/paths/list`, ready=true) para tolerar eventos perdidos.
//   - INVARIANTE CLAVE: nunca re-registra un path ya vivo (eso ROTARÍA la
//     instancia e invalidaría grants en curso). Un `ready` duplicado sin un
//     `notReady` intermedio es keepalive ⇒ `refreshSource` (extiende TTL, mismo
//     token). Sólo un ciclo notReady→ready rota (reconexión ⇒ INSTANCE_MISMATCH
//     para grants viejos, que es lo deseado).
//   - Si la lista viva no está disponible (API caída), NO retira nada (evita
//     rotaciones/expulsiones espurias por una lectura fallida).
//   - Detrás de NATIVE_SOURCE_LIFECYCLE_ENABLED (OFF por defecto). Con la flag
//     apagada el controlador no existe, ningún path se registra ⇒ `issue` sigue
//     negándose ⇒ comportamiento idéntico a C22.2.
//
// NO toca la config de MediaMTX: `/v3/paths/list` es de sólo lectura. El naming y
// la URL se derivan de las MISMAS env vars que services/stream.ts.

import axios from 'axios'

/** Puerto mínimo del store para gestionar instancias de fuente. */
export interface SourceRegistryPort {
  registerSource(streamPath: string, ttlMs: number): Promise<string>
  refreshSource(streamPath: string, ttlMs: number): Promise<void>
  retireSource(streamPath: string): Promise<void>
  currentInstance(streamPath: string): Promise<string | null>
}

/** Lista de paths con fuente VIVA en MediaMTX (ready=true). null ⇒ API no disponible. */
export interface MediaMtxPathLister {
  listReadyPaths(): Promise<string[] | null>
}

export interface SourceLifecycleOptions {
  /** TTL de la instancia; el reconcile la refresca antes de vencer. Default 90s. */
  instanceTtlMs?: number
  /** Sólo gestiona paths que matcheen (default: naming VMS nvr_*_(sub|main|main_h264)). */
  pathFilter?: (streamPath: string) => boolean
  log?: (msg: string) => void
}

// TTL de la instancia de fuente. NO confundir con el TTL de seguridad de 90s del
// stream-manager (C1–C21): es independiente y aquí sólo acota cuánto vive el
// registro de instancia entre refrescos del reconcile.
const DEFAULT_INSTANCE_TTL_MS = 90_000
const VMS_PATH = /^nvr_.+_(sub|main|main_h264)$/

export class SourceLifecycleController {
  private readonly known = new Set<string>()
  private readonly ttl: number
  private readonly accept: (p: string) => boolean
  private readonly log: (m: string) => void

  constructor(private readonly store: SourceRegistryPort, opts: SourceLifecycleOptions = {}) {
    this.ttl = Math.max(1, opts.instanceTtlMs ?? DEFAULT_INSTANCE_TTL_MS)
    this.accept = opts.pathFilter ?? ((p) => VMS_PATH.test(p))
    this.log = opts.log ?? (() => {})
  }

  /** Paths que el controlador considera vivos (diagnóstico/pruebas). */
  knownPaths(): string[] { return [...this.known] }

  /** Evento MediaMTX: la fuente del path quedó lista (source add / (re)conexión). */
  async onReady(streamPath: string): Promise<void> {
    if (!this.accept(streamPath)) return
    // Duplicado sin notReady intermedio ⇒ keepalive, NO rotar (no invalida grants vivos).
    if (this.known.has(streamPath)) { await this.safeRefresh(streamPath); return }
    await this.safeRegister(streamPath)
  }

  /** Evento MediaMTX: la fuente del path se cayó (source remove / desconexión). */
  async onNotReady(streamPath: string): Promise<void> {
    if (!this.known.has(streamPath)) return
    this.known.delete(streamPath)
    try { await this.store.retireSource(streamPath); this.log(`source_retired path=${streamPath}`) }
    catch { this.log(`source_retire_failed path=${streamPath}`) }
  }

  /**
   * Reconciliación robusta contra la lista viva de MediaMTX (tolera eventos
   * perdidos). Registra nuevas, refresca vigentes, retira ausentes. Si la lista
   * es null (API caída) NO retira nada.
   */
  async reconcile(readyPaths: string[] | null): Promise<void> {
    if (readyPaths === null) { this.log('reconcile_skipped reason=lister_unavailable'); return }
    const ready = new Set(readyPaths.filter((p) => this.accept(p)))
    for (const p of ready) {
      if (this.known.has(p)) await this.safeRefresh(p)
      else await this.safeRegister(p)
    }
    for (const p of [...this.known]) {
      if (!ready.has(p)) await this.onNotReady(p)
    }
  }

  private async safeRegister(streamPath: string): Promise<void> {
    try {
      await this.store.registerSource(streamPath, this.ttl)
      this.known.add(streamPath)  // sólo se marca vivo si el registro tuvo éxito
      this.log(`source_registered path=${streamPath}`)
    } catch {
      // No se marca known ⇒ el próximo reconcile lo reintenta (fail-open al retry).
      this.log(`source_register_failed path=${streamPath} — reintenta`)
    }
  }

  private async safeRefresh(streamPath: string): Promise<void> {
    try { await this.store.refreshSource(streamPath, this.ttl) }
    catch { this.log(`source_refresh_failed path=${streamPath}`) }
  }
}

export interface SourceLifecyclePoller { stop(): void }

/**
 * Reconcile periódico contra MediaMTX. Se invoca SÓLO con la flag activa.
 * `unref()` para no mantener vivo el proceso por sí solo.
 */
export function startSourceLifecyclePoller(
  controller: SourceLifecycleController,
  lister: MediaMtxPathLister,
  intervalMs = 30_000,
  log: (m: string) => void = () => {},
): SourceLifecyclePoller {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    try { await controller.reconcile(await lister.listReadyPaths()) }
    catch (e) { log(`source_lifecycle_tick_error ${e}`) }
  }
  void tick()  // pasada inicial inmediata
  const timer = setInterval(() => { void tick() }, Math.max(1000, intervalMs))
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  return { stop() { stopped = true; clearInterval(timer) } }
}

/** Tamaño de página al recorrer `/v3/paths/list`. */
const LIST_ITEMS_PER_PAGE = 1000
/** Cota dura de páginas para no colgarse si el servidor devuelve pageCount absurdo. */
const LIST_MAX_PAGES = 1000

/**
 * B3 — Lister real contra la API de MediaMTX (sólo lectura). Devuelve los nombres
 * de paths con `ready=true`. Mismas env vars que services/stream.ts.
 *
 * AUTORIDAD DE LA LISTA (invariante clave de N1): `reconcile` RETIRA las fuentes
 * ausentes de esta lista. Por eso una lista TRUNCADA jamás puede devolverse como
 * verdad: retiraría fuentes VIVAS con espectadores → INSTANCE_MISMATCH y caída de
 * la reproducción nativa. Por eso:
 *   - Se PAGINA `/v3/paths/list` (`page`/`itemsPerPage`) usando `pageCount`.
 *   - Ante cualquier duda (no-200, error, o página LLENA sin `pageCount` fiable que
 *     confirme que es la última) se devuelve `null` ⇒ NO-autoritativa ⇒ reconcile
 *     no retira nada.
 * NO VALIDADO en vivo en este entorno (sin MediaMTX); la lógica de paginación/
 * truncado sí está cubierta por tests con un cliente HTTP falso.
 */
export function createMediaMtxPathLister(baseUrl = process.env.MEDIAMTX_URL || 'http://mediamtx:9997'): MediaMtxPathLister {
  const api = axios.create({ baseURL: baseUrl, timeout: 5000 })
  return {
    async listReadyPaths(): Promise<string[] | null> {
      try {
        const collected: string[] = []
        for (let page = 0; page < LIST_MAX_PAGES; page++) {
          const res = await api.get('/v3/paths/list', {
            params: { page, itemsPerPage: LIST_ITEMS_PER_PAGE },
            validateStatus: () => true,
          })
          if (res.status !== 200) return null
          const data = (res.data ?? {}) as { items?: unknown; pageCount?: unknown }
          const items: unknown[] = Array.isArray(data.items) ? data.items : []
          for (const p of items) {
            if (!!p && typeof (p as any).name === 'string' && (p as any).ready === true) collected.push((p as any).name)
          }
          const pageCount = Number(data.pageCount)
          if (Number.isFinite(pageCount) && pageCount >= 1) {
            // Metadatos fiables: recorremos hasta la última página.
            if (page + 1 >= pageCount) return collected
            continue
          }
          // Sin `pageCount` fiable: si la página vino INCOMPLETA, es la última
          // (lista completa). Si vino LLENA, podría estar truncada ⇒ NO-autoritativa.
          if (items.length < LIST_ITEMS_PER_PAGE) return collected
          return null
        }
        // Se agotó la cota de páginas sin cerrar: no podemos garantizar completitud.
        return null
      } catch { return null }
    },
  }
}
