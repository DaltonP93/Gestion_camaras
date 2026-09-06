// Unit de closeUserSockets: cierra las conexiones WS vivas del userId indicado,
// devuelve el conteo, no toca a otros usuarios y es seguro (0) si no hay ninguna.
import { describe, it, expect, beforeEach } from 'vitest'
import { wsClients, closeUserSockets } from './websocket'

// Fake mínimo de WebSocket ('ws'): registra los close() recibidos. Simula además
// que onClose limpia el mapa (como hace el handler real) para probar que
// closeUserSockets no rompe al mutar el Set durante la iteración.
function makeFakeSocket(userId: string, autoCleanup = false) {
  const calls: Array<{ code?: number; reason?: string }> = []
  const ws: any = {
    readyState: 1,
    close(code?: number, reason?: string) {
      calls.push({ code, reason })
      if (autoCleanup) {
        // Emula el ws.on('close') del handler real (limpieza síncrona del mapa).
        wsClients.get(userId)?.delete(ws)
        if (wsClients.get(userId)?.size === 0) wsClients.delete(userId)
      }
    },
    _calls: calls,
  }
  return ws
}

function register(userId: string, ws: any) {
  if (!wsClients.has(userId)) wsClients.set(userId, new Set())
  wsClients.get(userId)!.add(ws)
}

beforeEach(() => {
  wsClients.clear()
})

describe('closeUserSockets', () => {
  it('cierra todas las conexiones del userId y devuelve el conteo', () => {
    const a = makeFakeSocket('u1')
    const b = makeFakeSocket('u1')
    register('u1', a)
    register('u1', b)

    const n = closeUserSockets('u1')

    expect(n).toBe(2)
    expect(a._calls).toEqual([{ code: 4003, reason: 'permissions_changed' }])
    expect(b._calls).toEqual([{ code: 4003, reason: 'permissions_changed' }])
  })

  it('respeta code/reason personalizados', () => {
    const a = makeFakeSocket('u1')
    register('u1', a)

    expect(closeUserSockets('u1', 4009, 'forced')).toBe(1)
    expect(a._calls).toEqual([{ code: 4009, reason: 'forced' }])
  })

  it('no toca las conexiones de otros usuarios', () => {
    const victim = makeFakeSocket('victim')
    const bystander = makeFakeSocket('other')
    register('victim', victim)
    register('other', bystander)

    const n = closeUserSockets('victim')

    expect(n).toBe(1)
    expect(victim._calls).toHaveLength(1)
    expect(bystander._calls).toHaveLength(0)
    // La entrada del bystander sigue viva.
    expect(wsClients.get('other')?.has(bystander)).toBe(true)
  })

  it('devuelve 0 si el usuario no tiene conexiones', () => {
    expect(closeUserSockets('nadie')).toBe(0)
  })

  it('es robusto si onClose limpia el mapa de forma síncrona durante la iteración', () => {
    const a = makeFakeSocket('u1', true)
    const b = makeFakeSocket('u1', true)
    register('u1', a)
    register('u1', b)

    const n = closeUserSockets('u1')

    expect(n).toBe(2)
    expect(a._calls).toHaveLength(1)
    expect(b._calls).toHaveLength(1)
    // El auto-cleanup dejó el mapa sin la entrada del usuario.
    expect(wsClients.has('u1')).toBe(false)
  })
})
