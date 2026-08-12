// Tests (10)(11)(12)(13) de la revisión de #146: la readquisición de HD se
// concede una vez POR CICLO de ocultación, tolera eventos duplicados y no
// depende de estado de React.
import { describe, it, expect } from 'vitest'
import {
  decideHdReacquire, finishHdReacquire, initialHdReacquireState, decideHdFallback,
  type HdReacquireState,
} from './hdReacquire'

const TTL = 90_000
const base = {
  hdTtlMs: TTL,
  focusIsHd: true,
}

describe('(10) una readquisición por CICLO de ocultación', () => {
  it('el primer ciclo largo la concede', () => {
    const d = decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 1, state: initialHdReacquireState,
    })
    expect(d.shouldReacquire).toBe(true)
    expect(d.reason).toBe('reacquire')
    expect(d.nextState).toEqual({ handledCycle: 1_000, inFlight: true })
  })

  it('un SEGUNDO ciclo largo sobre la misma cámara vuelve a concederla', () => {
    // Éste es exactamente el caso que el ref por cámara bloqueaba para siempre.
    const first = decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 1, state: initialHdReacquireState,
    })
    const afterFirst = finishHdReacquire(first.nextState)

    const second = decideHdReacquire({
      ...base, hiddenAt: 500_000, hiddenMs: TTL + 1, state: afterFirst,
    })

    expect(second.shouldReacquire).toBe(true)
    expect(second.nextState.handledCycle).toBe(500_000)
  })

  it('tres ciclos largos consecutivos conceden tres intentos, uno por ciclo', () => {
    let state: HdReacquireState = initialHdReacquireState
    const granted: number[] = []
    for (const hiddenAt of [1_000, 2_000, 3_000]) {
      const d = decideHdReacquire({ ...base, hiddenAt, hiddenMs: TTL + 1, state })
      if (d.shouldReacquire) granted.push(hiddenAt)
      state = finishHdReacquire(d.nextState)
    }
    expect(granted).toEqual([1_000, 2_000, 3_000])
  })

  it('el MISMO ciclo no la concede dos veces', () => {
    const first = decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 1, state: initialHdReacquireState,
    })
    const afterFirst = finishHdReacquire(first.nextState)

    const repeat = decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 5, state: afterFirst,
    })

    expect(repeat.shouldReacquire).toBe(false)
    expect(repeat.reason).toBe('cycle_already_handled')
  })
})

describe('(11) eventos visibilitychange duplicados', () => {
  it('no producen dos arranques: el segundo ve el intento en vuelo', () => {
    const first = decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 1, state: initialHdReacquireState,
    })
    expect(first.shouldReacquire).toBe(true)

    // El evento se repite ANTES de que el primer intento termine.
    const duplicate = decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 1, state: first.nextState,
    })

    expect(duplicate.shouldReacquire).toBe(false)
    expect(duplicate.reason).toBe('in_flight')
  })

  it('un duplicado de OTRO ciclo tampoco se cuela mientras hay uno en vuelo', () => {
    const first = decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 1, state: initialHdReacquireState,
    })
    const other = decideHdReacquire({
      ...base, hiddenAt: 9_999, hiddenMs: TTL + 1, state: first.nextState,
    })
    expect(other.shouldReacquire).toBe(false)
    expect(other.reason).toBe('in_flight')
  })
})

describe('condiciones que no ameritan readquirir', () => {
  it('ocultación MENOR o igual al TTL: la sesión sigue viva en el servidor', () => {
    expect(decideHdReacquire({
      ...base, hiddenAt: 1_000, hiddenMs: TTL, state: initialHdReacquireState,
    }).reason).toBe('within_ttl')
  })

  it('sin foco en HD no se pide nada', () => {
    expect(decideHdReacquire({
      ...base, focusIsHd: false, hiddenAt: 1_000, hiddenMs: TTL + 1,
      state: initialHdReacquireState,
    }).reason).toBe('not_hd')
  })

  it('si la pestaña nunca se ocultó no hay ciclo que atender', () => {
    expect(decideHdReacquire({
      ...base, hiddenAt: null, hiddenMs: 0, state: initialHdReacquireState,
    }).reason).toBe('never_hidden')
  })

  it('usa el TTL EFECTIVO, no 90 s fijos', () => {
    // Con un TTL efectivo de 180 s, 100 s ocultos NO deben readquirir.
    expect(decideHdReacquire({
      ...base, hdTtlMs: 180_000, hiddenAt: 1_000, hiddenMs: 100_000,
      state: initialHdReacquireState,
    }).reason).toBe('within_ttl')
    // Con un TTL efectivo de 30 s, 40 s ocultos SÍ deben readquirir.
    expect(decideHdReacquire({
      ...base, hdTtlMs: 30_000, hiddenAt: 1_000, hiddenMs: 40_000,
      state: initialHdReacquireState,
    }).shouldReacquire).toBe(true)
  })
})

describe('(13) la decisión no depende de estado de React', () => {
  it('es una función pura del estado explícito: mismos argumentos, mismo resultado', () => {
    const args = {
      ...base, hiddenAt: 1_000, hiddenMs: TTL + 1, state: initialHdReacquireState,
    }
    const a = decideHdReacquire(args)
    const b = decideHdReacquire(args)
    expect(a).toEqual(b)
    // No muta el estado recibido: el llamador decide cuándo persistirlo.
    expect(initialHdReacquireState).toEqual({ handledCycle: null, inFlight: false })
  })

  it('finishHdReacquire libera el single-flight conservando el ciclo atendido', () => {
    const after = finishHdReacquire({ handledCycle: 1_000, inFlight: true })
    expect(after).toEqual({ handledCycle: 1_000, inFlight: false })
  })
})

describe('(12) el fallo de readquisición restaura sub sin overlay ni pantalla negra', () => {
  it('un 429 de límite deja la tarjeta en baja calidad, sin overlay', () => {
    const plan = decideHdFallback({ ok: false, errorCode: 'TRANSCODE_LIMIT_REACHED' })
    expect(plan.streamType).toBe('sub')
    expect(plan.showErrorOverlay).toBe(false)
    expect(plan.clearStreamInfo).toBe(true)
    expect(plan.remountPlayer).toBe(true)
  })

  it('cualquier otro fallo se trata igual: nunca se tapa el substream', () => {
    for (const code of ['CODEC_UNSUPPORTED', 'MEDIA_SERVER_ERROR', 'UNKNOWN', undefined]) {
      const plan = decideHdFallback({ ok: false, errorCode: code })
      expect(plan.streamType).toBe('sub')
      expect(plan.showErrorOverlay).toBe(false)
    }
  })

  it('un intento exitoso no toca la tarjeta', () => {
    const plan = decideHdFallback({ ok: true })
    expect(plan.showErrorOverlay).toBe(false)
    expect(plan.clearStreamInfo).toBe(false)
    expect(plan.remountPlayer).toBe(false)
  })
})
