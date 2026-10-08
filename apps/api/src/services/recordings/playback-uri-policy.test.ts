import { describe, it, expect } from 'vitest'
import {
  allowedTrackIdsForChannel,
  parsePlaybackUri,
  validatePlaybackUriForChannel,
  playbackUriErrorResponse,
  PLAYBACK_URI_MAX_LENGTH,
} from './playback-uri-policy'

const WINDOW = 'starttime=20260716T170000Z&endtime=20260716T172206Z'

describe('allowedTrackIdsForChannel', () => {
  it('canal N ⇒ pista principal N01 y subpista N02', () => {
    expect(allowedTrackIdsForChannel(1)).toEqual([101, 102])
    expect(allowedTrackIdsForChannel(3)).toEqual([301, 302])
    expect(allowedTrackIdsForChannel(64)).toEqual([6401, 6402])
  })
  it('canal inválido ⇒ ninguna pista', () => {
    for (const ch of [0, -1, 1.5, Number.NaN]) expect(allowedTrackIdsForChannel(ch)).toEqual([])
  })
})

describe('validatePlaybackUriForChannel — rutas válidas del propio canal', () => {
  const valid = [
    `/Streaming/tracks/301?${WINDOW}`,
    `/Streaming/tracks/301/?${WINDOW}&name=00010000027000300&size=290893180`,
    `/Streaming/tracks/302?${WINDOW}`,
    `/Streaming/tracks/301?starttime=20260716T170000Z`,
    `/streaming/TRACKS/301?${WINDOW}`,
  ]
  for (const uri of valid) {
    it(`acepta ${uri}`, () => {
      const r = validatePlaybackUriForChannel(uri, 3)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.pathQuery).toBe(uri)
    })
  }
})

describe('validatePlaybackUriForChannel — otro canal del mismo NVR', () => {
  it('pista de otro canal ⇒ channel_mismatch', () => {
    expect(validatePlaybackUriForChannel(`/Streaming/tracks/901?${WINDOW}`, 3)).toEqual({ ok: false, reason: 'channel_mismatch' })
    expect(validatePlaybackUriForChannel(`/Streaming/tracks/101?${WINDOW}`, 3)).toEqual({ ok: false, reason: 'channel_mismatch' })
  })
  it('pista vecina que no es principal/sub del canal ⇒ channel_mismatch', () => {
    for (const t of [300, 303, 3001, 31]) {
      expect(validatePlaybackUriForChannel(`/Streaming/tracks/${t}?${WINDOW}`, 3)).toEqual({ ok: false, reason: 'channel_mismatch' })
    }
  })
  it('ceros a la izquierda no colisionan con la pista legítima', () => {
    // 0301 ⇒ Number = 301: misma pista, mismo canal (no es otro recurso).
    expect(validatePlaybackUriForChannel(`/Streaming/tracks/0301?${WINDOW}`, 3).ok).toBe(true)
    expect(validatePlaybackUriForChannel(`/Streaming/tracks/0901?${WINDOW}`, 3)).toEqual({ ok: false, reason: 'channel_mismatch' })
  })
})

describe('validatePlaybackUriForChannel — entradas malformadas o codificadas', () => {
  const cases: Array<[string, unknown, string]> = [
    ['no string', 123, 'not_string'],
    ['vacía', '', 'too_long'],
    ['demasiado larga', `/Streaming/tracks/301?${WINDOW}&name=${'a'.repeat(PLAYBACK_URI_MAX_LENGTH)}`, 'too_long'],
    ['vivo en lugar de grabación', `/Streaming/Channels/301?${WINDOW}`, 'bad_path'],
    ['ruta ISAPI', `/ISAPI/System/deviceInfo?${WINDOW}`, 'bad_path'],
    ['traversal con ..', `/Streaming/tracks/301/../901?${WINDOW}`, 'bad_path'],
    ['traversal codificado %2e%2e', `/Streaming/tracks/301/%2e%2e/901?${WINDOW}`, 'illegal_characters'],
    ['barra codificada %2F', `/Streaming/tracks/301%2F..%2F901?${WINDOW}`, 'illegal_characters'],
    ['espacio', `/Streaming/tracks/301?starttime=20260716T170000Z &x=1`, 'illegal_characters'],
    ['CRLF', `/Streaming/tracks/301?${WINDOW}\r\nOPTIONS * RTSP/1.0`, 'illegal_characters'],
    ['NUL', `/Streaming/tracks/301?${WINDOW}\u0000`, 'illegal_characters'],
    ['no ASCII', `/Streaming/tracks/301?${WINDOW}&name=caméra`, 'illegal_characters'],
    ['backslash', `\\Streaming\\tracks\\301?${WINDOW}`, 'illegal_characters'],
    ['userinfo @', `/Streaming/tracks/301?${WINDOW}&name=a@b`, 'illegal_characters'],
    ['fragmento #', `/Streaming/tracks/301?${WINDOW}#x`, 'illegal_characters'],
    ['host embebido', `//attacker.example/Streaming/tracks/301?${WINDOW}`, 'bad_path'],
    ['URL absoluta', `rtsp://nvr/Streaming/tracks/301?${WINDOW}`, 'bad_path'],
    ['sin query', '/Streaming/tracks/301', 'bad_query'],
    ['query vacía', '/Streaming/tracks/301?', 'missing_starttime'],
    ['doble ?', `/Streaming/tracks/301?${WINDOW}?a=b`, 'bad_query'],
    ['parámetro desconocido', `/Streaming/tracks/301?${WINDOW}&transport=udp`, 'bad_query'],
    ['clave duplicada (HPP)', `/Streaming/tracks/301?starttime=20260716T170000Z&starttime=20260716T180000Z`, 'bad_query'],
    ['starttime con formato inválido', '/Streaming/tracks/301?starttime=2026-07-16', 'bad_query'],
    ['sin starttime', '/Streaming/tracks/301?endtime=20260716T172206Z', 'missing_starttime'],
    ['par sin "="', `/Streaming/tracks/301?${WINDOW}&name`, 'bad_query'],
    ['size no numérico', `/Streaming/tracks/301?${WINDOW}&size=1e9`, 'bad_query'],
    ['id de pista no numérico', `/Streaming/tracks/30a?${WINDOW}`, 'bad_path'],
  ]
  for (const [label, input, reason] of cases) {
    it(`${label} ⇒ ${reason}`, () => {
      expect(validatePlaybackUriForChannel(input, 3)).toEqual({ ok: false, reason })
    })
  }
})

describe('parsePlaybackUri / respuesta de error', () => {
  it('la sintaxis no depende del canal', () => {
    expect(parsePlaybackUri(`/Streaming/tracks/901?${WINDOW}`)).toMatchObject({ ok: true, trackId: 901 })
  })
  it('channel_mismatch ⇒ 403; el resto ⇒ 400, sin eco de la entrada', () => {
    expect(playbackUriErrorResponse('channel_mismatch').status).toBe(403)
    for (const r of ['not_string', 'too_long', 'illegal_characters', 'bad_path', 'bad_query', 'missing_starttime'] as const) {
      const e = playbackUriErrorResponse(r)
      expect(e.status).toBe(400)
      expect(JSON.stringify(e.body)).not.toContain('Streaming')
    }
  })
})

// Las claves de la query se buscan en la tabla de reglas. Una tabla `Record`
// normal hereda de Object.prototype: `constructor` y `__proto__` devolvían una
// función / el prototipo, `rule.test` no existía y la validación LANZABA
// (TypeError ⇒ 500) en lugar de rechazar. La tabla sólo debe ver sus propias
// claves, con cualquier mayúscula/minúscula y en cualquier posición.
describe('claves heredadas de Object.prototype en la query', () => {
  const START = 'starttime=20260716T170000Z'
  const inherited = [
    ...Object.getOwnPropertyNames(Object.prototype),
    'Constructor', 'CONSTRUCTOR', '__PROTO__', '__Proto__', 'prototype',
  ]
  const placements: Array<[string, (k: string) => string]> = [
    ['después de starttime', k => `/Streaming/tracks/301?${START}&${k}=x`],
    ['antes de starttime', k => `/Streaming/tracks/301?${k}=x&${START}`],
    ['única clave', k => `/Streaming/tracks/301?${k}=20260716T170000Z`],
    ['valor vacío', k => `/Streaming/tracks/301?${START}&${k}=`],
  ]
  for (const key of inherited) {
    for (const [where, build] of placements) {
      it(`${key} (${where}) ⇒ rechazo sin excepción`, () => {
        const uri = build(key)
        let r: ReturnType<typeof validatePlaybackUriForChannel> | undefined
        expect(() => { r = validatePlaybackUriForChannel(uri, 3) }).not.toThrow()
        expect(r?.ok).toBe(false)
        if (r && !r.ok) expect(['bad_query', 'missing_starttime']).toContain(r.reason)
        expect(() => parsePlaybackUri(uri)).not.toThrow()
      })
    }
  }

  it('constructor / __proto__ ⇒ bad_query (no se confunden con una regla)', () => {
    for (const k of ['constructor', '__proto__']) {
      expect(validatePlaybackUriForChannel(`/Streaming/tracks/301?${START}&${k}=x`, 3)).toEqual({ ok: false, reason: 'bad_query' })
    }
  })

  it('no contamina el prototipo global al validar', () => {
    validatePlaybackUriForChannel(`/Streaming/tracks/301?${START}&__proto__=polluted`, 3)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
  })

  it('las claves legítimas siguen aceptándose en cualquier mayúscula', () => {
    expect(validatePlaybackUriForChannel(`/Streaming/tracks/301?StartTime=20260716T170000Z&ENDTIME=20260716T172206Z&Name=a&SIZE=1`, 3).ok).toBe(true)
  })
})
