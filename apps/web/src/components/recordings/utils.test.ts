// Tests de los helpers puros del módulo Grabaciones.
// La convención de hora de pared del NVR es el invariante más delicado del
// módulo: estos tests la fijan por contrato.
import { describe, it, expect } from 'vitest'
import {
  localInputToNvrIso, nvrTimeMs, formatNvrTime,
  classifyError, formatDuration, formatSize,
} from './utils'

describe('localInputToNvrIso', () => {
  it('agrega segundos y Z a un valor de datetime-local', () => {
    expect(localInputToNvrIso('2026-07-09T14:30')).toBe('2026-07-09T14:30:00Z')
  })
  it('agrega solo Z si ya trae segundos', () => {
    expect(localInputToNvrIso('2026-07-09T14:30:15')).toBe('2026-07-09T14:30:15Z')
  })
  it('devuelve vacío tal cual', () => {
    expect(localInputToNvrIso('')).toBe('')
  })
})

describe('nvrTimeMs / formatNvrTime', () => {
  it('muestra los componentes UTC del timestamp sin importar la TZ del navegador', () => {
    // 2026-07-09T14:30:00Z debe SIEMPRE renderizar 14:30 (hora de pared NVR)
    const iso = '2026-07-09T14:30:00.000Z'
    expect(formatNvrTime(iso, 'HH:mm')).toBe('14:30')
    expect(formatNvrTime(new Date(iso).getTime(), 'dd/MM/yyyy HH:mm:ss')).toBe('09/07/2026 14:30:00')
  })
  it('nvrTimeMs compensa exactamente el offset local', () => {
    const ms = Date.UTC(2026, 6, 9, 14, 30)
    const shifted = new Date(nvrTimeMs(ms))
    expect(shifted.getHours()).toBe(14)
    expect(shifted.getMinutes()).toBe(30)
  })
})

describe('classifyError', () => {
  it('detecta ISAPI no soportado', () => {
    expect(classifyError({ message: 'El NVR no soporta ISAPI' })).toBe('ISAPI_UNSUPPORTED')
  })
  it('detecta fallo de credenciales', () => {
    expect(classifyError({ response: { data: { message: 'HTTP 401 Unauthorized' } } })).toBe('AUTH_FAILED')
  })
  it('detecta NVR offline', () => {
    expect(classifyError({ message: 'connect ECONNREFUSED 10.0.0.5:80' })).toBe('NVR_OFFLINE')
  })
  it('cae a UNKNOWN', () => {
    expect(classifyError({ message: 'algo raro' })).toBe('UNKNOWN')
  })
})

describe('formatDuration / formatSize', () => {
  it('formatea duración mm:ss', () => {
    expect(formatDuration('2026-07-09T14:00:00Z', '2026-07-09T14:05:30Z')).toBe('5:30')
  })
  it('formatea tamaños', () => {
    expect(formatSize(0)).toBe('—')
    expect(formatSize(50 * 1048576)).toBe('50 MB')
    expect(formatSize(2 * 1073741824)).toBe('2.0 GB')
  })
})

// ── selectRecordingForPlayhead — P1 selección de bloque/playhead ─────────────
import { selectRecordingForPlayhead } from './utils'

const ms = (iso: string) => new Date(iso).getTime()
const rec = (startTime: string, endTime: string) => ({ startTime, endTime })

describe('selectRecordingForPlayhead', () => {
  const SEARCH_START = ms('2026-07-28T14:14:00Z')
  const SEARCH_END   = ms('2026-07-28T15:14:00Z')

  // A. Bloque que empieza ANTES del rango → effectiveStart recortado a searchStart.
  it('A) bloque que empieza antes del rango => effectiveStart=14:14:00, nunca 12:54:40', () => {
    const recs = [rec('2026-07-28T12:54:40Z', '2026-07-28T14:14:18Z')]
    const r = selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START)
    expect(r.reason).toBe('covering')
    expect(r.targetRecording).toBe(recs[0])
    expect(r.effectiveStartMs).toBe(ms('2026-07-28T14:14:00Z'))
    expect(r.effectiveEndMs).toBe(ms('2026-07-28T14:14:18Z'))
    expect(r.effectiveStartMs).not.toBe(ms('2026-07-28T12:54:40Z'))
  })

  // B. Varios bloques, sin seek → cubre 14:14, nunca el último 14:58:45.
  it('B) varios bloques sin seek => cubre 14:14, nunca auto-selecciona el último', () => {
    const recs = [
      rec('2026-07-28T14:58:45Z', '2026-07-28T15:14:41Z'),  // desordenado a propósito
      rec('2026-07-28T12:54:40Z', '2026-07-28T14:14:18Z'),
      rec('2026-07-28T14:20:00Z', '2026-07-28T14:40:00Z'),
    ]
    const r = selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START)
    expect(r.targetRecording).toBe(recs[1])   // el que cubre 14:14
    expect(r.effectiveStartMs).toBe(SEARCH_START)
    expect(r.effectiveStartMs).not.toBe(ms('2026-07-28T14:58:45Z'))
  })

  // C. Hueco al inicio → siguiente bloque.
  it('C) hueco al inicio => target=14:20, effectiveStart=14:20', () => {
    const recs = [rec('2026-07-28T14:20:00Z', '2026-07-28T14:40:00Z')]
    const r = selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START)
    expect(r.reason).toBe('next')
    expect(r.effectiveStartMs).toBe(ms('2026-07-28T14:20:00Z'))
    expect(r.effectiveEndMs).toBe(ms('2026-07-28T14:40:00Z'))
  })

  // D. Bloque que excede el final → effectiveEnd recortado a searchEnd.
  it('D) bloque que excede el final => effectiveEnd=15:14:00, no 15:14:41', () => {
    const recs = [rec('2026-07-28T14:58:45Z', '2026-07-28T15:14:41Z')]
    const playhead = ms('2026-07-28T15:00:00Z')
    const r = selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, playhead)
    expect(r.effectiveEndMs).toBe(ms('2026-07-28T15:14:00Z'))
    expect(r.effectiveEndMs).not.toBe(ms('2026-07-28T15:14:41Z'))
  })

  // E. Deep-link en 14:35 dentro de un bloque.
  it('E) deep-link 14:35 en bloque 14:20-14:40 => effectiveStart=14:35', () => {
    const recs = [rec('2026-07-28T14:20:00Z', '2026-07-28T14:40:00Z')]
    const r = selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, ms('2026-07-28T14:35:00Z'))
    expect(r.reason).toBe('covering')
    expect(r.effectiveStartMs).toBe(ms('2026-07-28T14:35:00Z'))
  })

  it('sin bloques dentro del rango => none (no iniciar preview)', () => {
    const recs = [rec('2026-07-28T10:00:00Z', '2026-07-28T11:00:00Z')]  // todo antes del rango
    expect(selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START).reason).toBe('none')
  })

  it('bloque demasiado corto tras recorte => none', () => {
    // sólo se solapa 2s con el rango (< MIN 3s)
    const recs = [rec('2026-07-28T14:00:00Z', '2026-07-28T14:14:02Z')]
    expect(selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START).reason).toBe('none')
  })

  it('no muta el arreglo de entrada', () => {
    const recs = [rec('2026-07-28T14:58:45Z', '2026-07-28T15:14:41Z'), rec('2026-07-28T14:20:00Z', '2026-07-28T14:40:00Z')]
    const copy = [...recs]
    selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START)
    expect(recs).toEqual(copy)
  })
})

describe('selectRecordingForPlayhead — review Codex #121 (saltar candidatos cortos)', () => {
  const SEARCH_START = ms('2026-07-28T14:14:00Z')
  const SEARCH_END   = ms('2026-07-28T15:14:00Z')

  it('bloque solapado corto + otro solapado con metraje => elige el útil, no none', () => {
    const recs = [
      rec('2026-07-28T14:00:00Z', '2026-07-28T14:14:02Z'),  // cubre 14:14 pero sólo 2s tras recorte
      rec('2026-07-28T14:10:00Z', '2026-07-28T14:40:00Z'),  // también cubre 14:14, metraje útil
    ]
    const r = selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START)
    expect(r.targetRecording).toBe(recs[1])
    expect(r.reason).toBe('covering')
    expect(r.effectiveStartMs).toBe(SEARCH_START)
    expect(r.effectiveEndMs).toBe(ms('2026-07-28T14:40:00Z'))
  })

  it('primer bloque siguiente demasiado corto => salta al posterior con metraje', () => {
    const recs = [
      rec('2026-07-28T14:20:00Z', '2026-07-28T14:20:02Z'),  // next pero 2s
      rec('2026-07-28T14:30:00Z', '2026-07-28T14:50:00Z'),  // next con metraje
    ]
    const r = selectRecordingForPlayhead(recs, SEARCH_START, SEARCH_END, SEARCH_START)
    expect(r.targetRecording).toBe(recs[1])
    expect(r.reason).toBe('next')
    expect(r.effectiveStartMs).toBe(ms('2026-07-28T14:30:00Z'))
  })
})
