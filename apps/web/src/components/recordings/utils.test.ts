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
