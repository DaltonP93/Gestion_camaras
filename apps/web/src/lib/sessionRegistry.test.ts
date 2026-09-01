// A1 (post #160) · el registro de sesiones efectivas.
//
// Perdió dos cosas en dos rondas distintas: primero el TIPO real (era
// `Set<cameraId>`), y después la IDENTIDAD de la solicitud que creó cada sesión
// (era `cameraId → Set<StreamKind>`). Sin la segunda, el descarte tardío de A
// borraba del registro la entrada vigente de B, y a partir de ahí la vista ya
// no sabía que tenía esa sesión abierta.
import { describe, it, expect, beforeEach } from 'vitest'
import { createSessionRegistry, type SessionRegistry } from './sessionRegistry'

let r: SessionRegistry
beforeEach(() => { r = createSessionRegistry() })

const e = (cameraId: string, streamType: any, startAttemptId: string) =>
  ({ cameraId, streamType, startAttemptId })

describe('la entrada identifica cámara, tipo Y solicitud', () => {
  it('guarda el intento que creó cada sesión', () => {
    r.add(e('c1', 'main_h264', 'A'))

    expect(r.attemptsOf('c1', 'main_h264')).toEqual(['A'])
    expect(r.hasAttempt('c1', 'main_h264', 'A')).toBe(true)
    expect(r.hasAttempt('c1', 'main_h264', 'B')).toBe(false)
  })

  it('un intento nuevo sobre la MISMA ranura CONVIVE con el anterior', () => {
    // El servidor sostiene la sesión con los dos arrendamientos. Reemplazar
    // —lo que se hacía— borraba la anotación de una solicitud viva, y su
    // descarte no encontraba después nada que soltar.
    r.add(e('c1', 'main_h264', 'A'))
    r.add(e('c1', 'main_h264', 'B'))

    expect(r.size()).toBe(2)
    expect(r.attemptsOf('c1', 'main_h264').sort()).toEqual(['A', 'B'])
    expect(r.typesOf('c1')).toEqual(['main_h264'])
  })

  it('registrar dos veces el MISMO intento no duplica', () => {
    r.add(e('c1', 'main_h264', 'A'))
    r.add(e('c1', 'main_h264', 'A'))

    expect(r.size()).toBe(1)
  })
})

describe('removeAttempt: sólo la entrada del propio intento', () => {
  it('el descarte de A no puede borrar la entrada vigente de B', () => {
    // La carrera exacta: A pidió `main`, el backend creó `main_h264`; B pidió
    // `main_h264` y quedó vigente. A responde tarde y quiere limpiar.
    r.add(e('c1', 'main_h264', 'B'))

    expect(r.removeAttempt('c1', 'main_h264', 'A')).toBe(false)
    expect(r.attemptsOf('c1', 'main_h264')).toEqual(['B'])
    expect(r.size()).toBe(1)
  })

  it('con A y B coexistiendo, soltar A deja B en pie', () => {
    r.add(e('c1', 'main_h264', 'A'))
    r.add(e('c1', 'main_h264', 'B'))

    expect(r.removeAttempt('c1', 'main_h264', 'A')).toBe(true)
    expect(r.attemptsOf('c1', 'main_h264')).toEqual(['B'])
    expect(r.hasType('c1', 'main_h264')).toBe(true)
  })

  it('la ranura desaparece sólo cuando se suelta el último', () => {
    r.add(e('c1', 'main_h264', 'A'))
    r.add(e('c1', 'main_h264', 'B'))
    r.removeAttempt('c1', 'main_h264', 'A')
    r.removeAttempt('c1', 'main_h264', 'B')

    expect(r.hasType('c1', 'main_h264')).toBe(false)
    expect(r.has('c1')).toBe(false)
  })

  it('el descarte de A sí borra la suya cuando sigue siendo la vigente', () => {
    r.add(e('c1', 'main_h264', 'A'))

    expect(r.removeAttempt('c1', 'main_h264', 'A')).toBe(true)
    expect(r.has('c1')).toBe(false)
  })

  it('quitar un tipo que no está es inocuo', () => {
    r.add(e('c1', 'sub', 'A'))

    expect(r.removeAttempt('c1', 'main_h264', 'A')).toBe(false)
    expect(r.typesOf('c1')).toEqual(['sub'])
  })
})

describe('removeType: cierre deliberado, sin importar el intento', () => {
  it('quita TODOS los arrendamientos de esa ranura y los devuelve', () => {
    r.add(e('c1', 'main', 'A'))
    r.add(e('c1', 'main', 'B'))

    expect(r.removeType('c1', 'main').map(x => x.startAttemptId).sort()).toEqual(['A', 'B'])
    expect(r.has('c1')).toBe(false)
    expect(r.removeType('c1', 'main')).toEqual([])
  })

  it('no toca los otros tipos de la misma cámara', () => {
    r.add(e('c1', 'sub', 'A'))
    r.add(e('c1', 'main_h264', 'B'))

    r.removeType('c1', 'main_h264')

    expect(r.typesOf('c1')).toEqual(['sub'])
    expect(r.attemptsOf('c1', 'sub')).toEqual(['A'])
  })
})

describe('una cámara puede tener varias sesiones a la vez', () => {
  it('el `sub` de la grilla y el `main_h264` del foco conviven, con intentos distintos', () => {
    r.add(e('c1', 'sub', 'A'))
    r.add(e('c1', 'main_h264', 'B'))

    expect(r.typesOf('c1')).toEqual(['main_h264', 'sub'])
    expect(r.entriesOf('c1').map(x => x.startAttemptId)).toEqual(['B', 'A'])
    expect(r.size()).toBe(2)
    expect(r.attemptsOf('c1', 'sub')).toEqual(['A'])
    expect(r.cameras()).toEqual(['c1'])
  })

  it('el orden es estable y pone primero lo que tiene proceso propio', () => {
    r.add(e('c1', 'sub', 'A')); r.add(e('c1', 'main', 'B')); r.add(e('c1', 'main_h264', 'C'))
    expect(r.typesOf('c1')).toEqual(['main_h264', 'main', 'sub'])

    const otro = createSessionRegistry()
    otro.add(e('c1', 'main_h264', 'C')); otro.add(e('c1', 'main', 'B')); otro.add(e('c1', 'sub', 'A'))
    expect(otro.typesOf('c1')).toEqual(['main_h264', 'main', 'sub'])
  })
})

describe('operaciones de conjunto', () => {
  it('`forget` devuelve lo que había y lo borra todo', () => {
    r.add(e('c1', 'sub', 'A')); r.add(e('c1', 'main', 'B'))

    expect(r.forget('c1').map(x => x.streamType)).toEqual(['main', 'sub'])
    expect(r.has('c1')).toBe(false)
    expect(r.forget('c1')).toEqual([])
  })

  it('`clear` vacía y devuelve el inventario completo', () => {
    r.add(e('c1', 'sub', 'A')); r.add(e('c2', 'main_h264', 'B'))

    expect(r.clear()).toEqual([e('c1', 'sub', 'A'), e('c2', 'main_h264', 'B')])
    expect(r.size()).toBe(0)
  })

  it('`snapshot` no permite mutar el registro por la puerta de atrás', () => {
    r.add(e('c1', 'sub', 'A'))
    const foto = r.snapshot()
    foto[0].startAttemptId = 'MANIPULADO'

    expect(r.attemptsOf('c1', 'sub')).toEqual(['A'])
  })

  it('quitar el último tipo saca la cámara del registro', () => {
    r.add(e('c1', 'sub', 'A'))
    r.removeAttempt('c1', 'sub', 'A')

    expect(r.cameras()).toEqual([])
    expect(r.typesOf('c1')).toEqual([])
  })
})
