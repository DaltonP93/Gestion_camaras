// A1 (post #160, correctivo 12) · alcance de la carga de VISTA.
//
// La ruta `views/:id` conserva el componente montado. Una navegación A → B con B
// resolviendo primero y A después dejaba que A sobrescribiera `view`/`slots`
// mientras la URL seguía en B, y el cargador de grilla abría los streams de A.
//
// Se ejercita el CÓDIGO REAL que corre el componente (`runScopedViewLoad`) —no
// una réplica— con promesas que se resuelven en el orden que la prueba elige, y
// un `isCurrent` que refleja la navegación. Las guardas tras el `CameraView` y
// tras los GETs secundarios son lo que se verifica; quitar cualquiera hace fallar
// estas pruebas (cobertura de mutación pedida por el correctivo).
import { describe, it, expect } from 'vitest'
import { runScopedViewLoad } from './scopedViewLoad'

interface View { cameraSlots: Array<{ cameraId: string | null }> }

function diferida<T>() {
  let resolver!: (v: T) => void
  let rechazar!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolver = res; rechazar = rej })
  return { promise, resolver, rechazar }
}

/** Alcance compartido: la navegación cambia `actual`; cada carga trae su token. */
function alcance(inicial: string) {
  let actual = inicial
  return {
    navegar: (t: string) => { actual = t },
    isCurrentDe: (t: string) => () => actual === t,
  }
}

/** Registra qué efectos produjo una carga, para afirmar sobre ellos. */
function efectos() {
  const log: string[] = []
  return {
    log,
    deps: (id: string, isCurrent: () => boolean, extra: Partial<Parameters<typeof runScopedViewLoad>[0]> = {}) => ({
      id,
      isCurrent,
      fetchView: extra.fetchView!,
      assignedIds: (v: View) => v.cameraSlots.filter(s => s.cameraId).map(s => s.cameraId!),
      fetchCamera: extra.fetchCamera ?? (async () => ({})),
      fetchStream: extra.fetchStream ?? (async () => ({})),
      onView: () => log.push(`onView:${id}`),
      onSlots: () => log.push(`onSlots:${id}`),
      onError: () => log.push(`onError:${id}`),
      onSettled: () => log.push(`onSettled:${id}`),
    }),
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))
const vistaVacia: View = { cameraSlots: [] }

describe('runScopedViewLoad respeta el alcance de la carga', () => {
  it('A → B; B resuelve primero, A después: sólo B aplica', async () => {
    const nav = alcance('A')
    const dA = diferida<View>()
    const dB = diferida<View>()
    const ef = efectos()

    // Ambas cargas en vuelo. El usuario ya navegó a B.
    const runA = runScopedViewLoad(ef.deps('A', nav.isCurrentDe('A'), { fetchView: () => dA.promise }) as any)
    nav.navegar('B')
    const runB = runScopedViewLoad(ef.deps('B', nav.isCurrentDe('B'), { fetchView: () => dB.promise }) as any)

    dB.resolver(vistaVacia)   // B primero
    await runB
    dA.resolver(vistaVacia)   // A después
    await runA

    // B quedó renderizada; A no tocó nada (ni onView, ni onSlots, ni onSettled).
    expect(ef.log.filter(l => l.endsWith(':A'))).toEqual([])
    expect(ef.log).toContain('onView:B')
    expect(ef.log).toContain('onSlots:B')
    expect(ef.log).toContain('onSettled:B')
  })

  it('A pasa el CameraView pero sus GETs secundarios llegan tarde, ya en B', async () => {
    const nav = alcance('A')
    const dCamA = diferida<unknown>()
    const ef = efectos()

    // A es vigente cuando llega el CameraView: aplica su `view`. Sus cámaras
    // quedan pendientes.
    const runA = runScopedViewLoad(ef.deps('A', nav.isCurrentDe('A'), {
      fetchView: async () => ({ cameraSlots: [{ cameraId: 'c1' }] }),
      fetchCamera: () => dCamA.promise as any,
      fetchStream: async () => ({}),
    }) as any)
    await tick()   // deja que A pase el primer guard y arranque los secundarios

    // Ahora el usuario navega a B y B aplica sus slots.
    nav.navegar('B')
    const runB = runScopedViewLoad(ef.deps('B', nav.isCurrentDe('B'), {
      fetchView: async () => vistaVacia,
    }) as any)
    await runB

    // Recién ahora resuelven los GETs secundarios de A: NO deben pisar slots B.
    dCamA.resolver({})
    await runA

    expect(ef.log).toContain('onView:A')          // A alcanzó a poner su view…
    expect(ef.log).not.toContain('onSlots:A')     // …pero NUNCA sus slots
    expect(ef.log.filter(l => l === 'onSlots:B')).toHaveLength(1)
    expect(ef.log).not.toContain('onSettled:A')   // ni su loading=false
  })

  it('error y finally tardíos de A no alteran error/loading de B', async () => {
    const nav = alcance('A')
    const dA = diferida<View>()
    const ef = efectos()

    const runA = runScopedViewLoad(ef.deps('A', nav.isCurrentDe('A'), { fetchView: () => dA.promise }) as any)
    nav.navegar('B')
    dA.rechazar(new Error('A falló tarde'))
    await runA

    expect(ef.log).not.toContain('onError:A')
    expect(ef.log).not.toContain('onSettled:A')
  })

  it('desmontaje antes de responder A: ningún efecto', async () => {
    const nav = alcance('A')
    const dA = diferida<View>()
    const ef = efectos()

    const runA = runScopedViewLoad(ef.deps('A', nav.isCurrentDe('A'), { fetchView: () => dA.promise }) as any)
    nav.navegar('DESMONTADO')   // el cleanup incrementó el token
    dA.resolver(vistaVacia)
    await runA

    expect(ef.log).toEqual([])
  })

  it('camino feliz: vigente todo el tiempo, aplica view, slots y settled', async () => {
    const nav = alcance('A')
    const ef = efectos()
    await runScopedViewLoad(ef.deps('A', nav.isCurrentDe('A'), {
      fetchView: async () => ({ cameraSlots: [{ cameraId: 'c1' }] }),
      fetchCamera: async () => ({ id: 'c1' }),
      fetchStream: async () => ({ hls: 'x' }),
    }) as any)

    expect(ef.log).toEqual(['onView:A', 'onSlots:A', 'onSettled:A'])
  })
})
