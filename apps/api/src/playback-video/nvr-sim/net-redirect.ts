// apps/api/src/playback-video/nvr-sim/net-redirect.ts
//
// Red de la suite de video, por ENCIMA del centinela del harness conjunto (que
// bloquea todo lo que no sea loopback):
//   - redirige SÓLO <IP ficticia del NVR>:80 → ISAPI simulado en 127.0.0.1;
//   - en loopback, sólo deja pasar una lista explícita de puertos (API, ISAPI,
//     PostgreSQL, Redis, web). El centinela solo dejaría pasar cualquier puerto
//     loopback, incluido un proxy de salida del entorno.
// Las conexiones por socket UNIX (IPC) no se tocan.

import net from 'node:net'

export interface NetRedirect {
  blocked: string[]
  redirected: number
  allow(port: number): void
  uninstall(): void
}

export function installNetRedirect(nvrHost: string, isapiPort: number, allowedPorts: number[]): NetRedirect {
  const proto = net.Socket.prototype as any
  const underlying = proto.connect
  const allowed = new Set<number>([isapiPort, ...allowedPorts])
  const state: NetRedirect = {
    blocked: [],
    redirected: 0,
    allow: (p) => { allowed.add(p) },
    uninstall: () => { proto.connect = underlying },
  }
  proto.connect = function videoConnect(this: net.Socket, ...args: any[]) {
    // net.createConnection llama connect([opciones normalizadas, cb]).
    const o = Array.isArray(args[0]) ? args[0][0] : (args[0] && typeof args[0] === 'object' ? args[0] : null)
    if (o && !o.path) {
      const port = Number(o.port)
      if (o.host === nvrHost && port === 80) {
        o.host = '127.0.0.1'
        o.port = isapiPort
        state.redirected++
      } else if (!allowed.has(port)) {
        state.blocked.push(`${String(o.host ?? 'localhost')}:${port}`)
        const err = new Error('suite de video: destino de red no permitido')
        process.nextTick(() => this.destroy(err))
        return this
      }
    }
    return underlying.apply(this, args)
  }
  return state
}
