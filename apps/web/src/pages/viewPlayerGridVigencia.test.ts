// A1 (post #160, correctivo 10) · vigencia del re-arranque de grilla de
// ViewPlayerPage.
//
// El defecto que corrige: `handleStreamError` cancelaba el `setTimeout` antes de
// que disparara, pero NO cubría el caso en que el callback ya había iniciado el
// POST y el usuario cambiaba de página. La respuesta vieja hacía `activeSessions.add`
// y `setSlots` de una cámara que ya no se ve —un FFmpeg sin espectador—.
//
// La corrección: una GENERACIÓN de trabajo de grilla (vista + página + montaje)
// que se compara ANTES del POST y DESPUÉS de recibir la respuesta; lo que dejó
// de ser vigente se cierra por identidad con cola, sin registrar ni tocar `slots`.
//
// Los DOS arranques de grilla de la página comparten este cableado: el
// re-arranque de `handleStreamError` y el cargador de página
// (`Promise.allSettled` sobre `pageIds`). La guarda estructural de
// `heartbeatGuards.test.ts` afirma que ambos lo implementan; acá se ejercita la
// LÓGICA contra stubs —vigente, cambio antes del POST, cambio tras la respuesta,
// con redirección de tipo— usando el mismo `closeStaleStart` real que la página.
import { describe, it, expect, beforeEach } from 'vitest'
import { closeStaleStart } from '@/lib/viewportSessionClose'
import { createSessionRegistry, type SessionRegistry } from '@/lib/sessionRegistry'
import { createPendingCloseQueue, type PendingCloseQueue } from '@/lib/pendingCloses'
import { createScopeGuard } from '@/lib/scopeGuard'
import { resolveCreatedType, type StreamKind } from '@/lib/streamTypes'
import { STALE_RESPONSE } from '@/lib/closeReasons'

interface Info { streamPath?: string; transcoded?: boolean; streamType?: string }

/** Banco: modela el backend por identidad y el cableado de `handleStreamError`. */
function makeBench() {
  /** Sesiones vivas del backend: `${cam}:${tipo}` → dueño (intento). */
  const duenos = new Map<string, string>()
  const registry: SessionRegistry = createSessionRegistry()
  const pending: PendingCloseQueue = createPendingCloseQueue()
  /** Cámaras cuyo `slots.stream` se actualizó (lo que NO debe pasar si es viejo). */
  const slotsAplicados: string[] = []
  const eventos: string[] = []

  // Scope de trabajo de grilla: se PUBLICA uno nuevo al cambiar página/vista/
  // montaje (lo que el componente hace síncronamente en el commit), invalidando
  // el anterior en el acto.
  const gridScope = createScopeGuard()
  const bumpGeneracion = () => { gridScope.publish() }

  /** Réplica del backend real: un cierre por identidad suelta sólo su lease. */
  const close = (cam: string, tipo: StreamKind, reason: string, _v: string, expected?: string) => {
    eventos.push(`close:${cam}:${tipo}:${reason}:${expected ?? 'none'}`)
    const clave = `${cam}:${tipo}`
    if (!expected || duenos.get(clave) !== expected) {
      return { emitted: true, status: 200, outcome: 'ignored' as const, reason: 'attempt_not_registered' }
    }
    duenos.delete(clave)
    return { emitted: true, status: 200, outcome: 'session_closed' as const, attemptId: expected }
  }

  /**
   * Mismo cableado que `handleStreamError`: captura la generación al programar,
   * comprueba vigencia antes del POST y tras recibir la respuesta.
   */
  async function reArranqueDeGrilla(cam: string, startAttemptId: string, respuesta: Promise<Info>) {
    const scope = gridScope.current()             // capturado al PROGRAMAR
    // (el timer disparó; en la página acá va el `gridRestartTimers.delete`)
    if (!gridScope.isCurrent(scope)) return        // vigencia ANTES del POST
    // El backend crea la sesión del tipo que sirvió, con este intento de dueño.
    const info = await respuesta
    const created = resolveCreatedType(info, 'sub')
    duenos.set(`${cam}:${created}`, startAttemptId)
    // Vigencia DESPUÉS de recibir la respuesta.
    if (!gridScope.isCurrent(scope)) {
      await closeStaleStart({
        cameraId: cam, info, requested: 'sub', startAttemptId,
        viewId: 'v1', close, registry, pending,
      })
      eventos.push(`descarte:${cam}:${startAttemptId}`)
      return
    }
    registry.add({ cameraId: cam, streamType: created, startAttemptId })
    slotsAplicados.push(cam)
    eventos.push(`aplica:${cam}:${created}`)
  }

  return { registry, pending, duenos, slotsAplicados, eventos, bumpGeneracion, reArranqueDeGrilla }
}

let bench: ReturnType<typeof makeBench>
beforeEach(() => { bench = makeBench() })

describe('vigencia del re-arranque de grilla (correctivo 10, parte 2)', () => {
  it('sin cambios: la respuesta se aplica y la sesión queda registrada', async () => {
    const info = Promise.resolve<Info>({ streamPath: '/c1_sub' })
    await bench.reArranqueDeGrilla('c1', 'sa-1', info)

    expect(bench.slotsAplicados).toEqual(['c1'])
    expect(bench.registry.attemptsOf('c1', 'sub')).toEqual(['sa-1'])
    expect(bench.pending.size()).toBe(0)
  })

  it('timer disparado → cambio de página → respuesta tardía: no aplica ni registra, cierra por attemptId', async () => {
    let resolver!: (i: Info) => void
    const info = new Promise<Info>(r => { resolver = r })
    const enVuelo = bench.reArranqueDeGrilla('c1', 'sa-1', info)

    // El usuario cambia de página mientras la respuesta viaja.
    bench.bumpGeneracion()
    resolver({ streamPath: '/c1_sub' })
    await enVuelo

    // No se tocó `slots` ni el registro activo.
    expect(bench.slotsAplicados).toEqual([])
    expect(bench.registry.has('c1')).toBe(false)
    // Se cerró por IDENTIDAD (el attemptId propio), con `stale_response`.
    expect(bench.eventos).toContain('close:c1:sub:stale_response:sa-1')
    expect(bench.eventos).toContain('descarte:c1:sa-1')
    // La sesión que el backend alcanzó a crear quedó cerrada.
    expect(bench.duenos.has('c1:sub')).toBe(false)
  })

  it('respuesta tardía redirigida sub→main: cierra el tipo REAL, no `sub`', async () => {
    let resolver!: (i: Info) => void
    const info = new Promise<Info>(r => { resolver = r })
    const enVuelo = bench.reArranqueDeGrilla('c1', 'sa-1', info)

    bench.bumpGeneracion()
    resolver({ streamPath: '/c1_main' })   // el backend redirigió a main
    await enVuelo

    expect(bench.slotsAplicados).toEqual([])
    // Cerró `main` —el creado—, no `sub`: cerrar el pedido no habría cerrado nada.
    expect(bench.eventos).toContain('close:c1:main:stale_response:sa-1')
    expect(bench.duenos.has('c1:main')).toBe(false)
  })

  it('respuesta tardía redirigida sub→main_h264: cierra main_h264, no `sub`', async () => {
    let resolver!: (i: Info) => void
    const info = new Promise<Info>(r => { resolver = r })
    const enVuelo = bench.reArranqueDeGrilla('c1', 'sa-1', info)

    bench.bumpGeneracion()
    resolver({ transcoded: true, streamPath: '/c1_main_h264' })   // sub → main_h264
    await enVuelo

    expect(bench.slotsAplicados).toEqual([])
    expect(bench.registry.has('c1')).toBe(false)
    expect(bench.eventos).toContain('close:c1:main_h264:stale_response:sa-1')
    expect(bench.duenos.has('c1:main_h264')).toBe(false)
  })
})
