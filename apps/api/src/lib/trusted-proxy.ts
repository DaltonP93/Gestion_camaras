// apps/api/src/lib/trusted-proxy.ts
//
// C03 — ¿En qué par TCP se confía para leer X-Forwarded-For? (Fastify `trustProxy`)
//
// Detrás de nginx el par del socket es SIEMPRE nginx: sin `trustProxy`, request.ip
// es la IP del proxy para todos y @fastify/rate-limit (keyGenerator = req.ip)
// aplicaba UN solo cupo a todos los clientes (login, 2FA, step-up y el global), y
// Session.ipAddress / AuditLog guardaban la IP del proxy.
//
// Regla: se confía SÓLO en el salto inmediato (hop 0 = par del socket) y SÓLO si
// ese par está en la lista de proxies confiables. Entonces request.ip es la ÚLTIMA
// entrada de X-Forwarded-For, que es la que agrega nginx ($proxy_add_x_forwarded_for
// = "<XFF del cliente>, $remote_addr"). NUNCA se confía en saltos más a la izquierda:
//   - un cliente que manda un X-Forwarded-For falso a nginx no elige su IP (nginx
//     agrega $remote_addr al final y es lo único que se lee);
//   - un cliente de la LAN cuya IP cae en un rango "confiable" tampoco puede
//     falsificarla al pasar por nginx (su IP es el salto 1, que nunca se confía).
// Ojo: `trustProxy: '<lista>'` de Fastify/proxy-addr NO sirve para esto: confía en
// CADA salto que esté en la lista, así que un cliente LAN detrás de nginx podría
// encadenar su propio X-Forwarded-For.
//
// Un par directo que NO está en la lista (acceso directo desde afuera) conserva el
// comportamiento previo: request.ip = IP del socket, sus cabeceras se ignoran.
//
// Las comprobaciones de "origen interno" NO usan request.ip (ver lib/internal-origin).
//
// Configuración: TRUSTED_PROXIES (ver .env.example). Vacío/ausente ⇒ default.
//   - lista separada por comas de IPs, CIDR o los nombres `loopback` y `uniquelocal`;
//   - `none` ⇒ no se confía en nadie (comportamiento previo a C03).
// Una lista inválida NO tumba el arranque: se ignora (se confía en nadie) y se
// registra el error — falla hacia el comportamiento previo, nunca hacia confiar de más.

import net from 'node:net'
import { isInternalIp } from './internal-origin'

/**
 * Default: loopback + los pools de direcciones que Docker usa por defecto para las
 * redes bridge (172.17–172.31/16 ⊂ 172.16.0.0/12 y 192.168.0.0/16 en /20). La red
 * `visioncore_net` del compose no fija subnet, así que nginx (y el gateway por el
 * que entra el 127.0.0.1:4000 publicado en el host) cae en alguno de esos rangos.
 * El API no publica el 4000 fuera del loopback del host: un cliente de la LAN sólo
 * llega por nginx, y su IP es el salto 1 (no confiable). 10.0.0.0/8 NO está por
 * defecto (no es pool por defecto de Docker y es habitual en LANs): si el daemon usa
 * pools propios, configurar TRUSTED_PROXIES.
 */
export const DEFAULT_TRUSTED_PROXIES = 'loopback,172.16.0.0/12,192.168.0.0/16'

const NAMED_RANGES: Record<string, readonly string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
}

export interface TrustedProxies {
  /** Para `Fastify({ trustProxy })`: true sólo en hop 0 y si el par es confiable. */
  trustProxy: (address: string, hop: number) => boolean
  /** ¿Este par del socket es un proxy confiable? */
  isTrustedPeer: (address: string | undefined) => boolean
  /** De dónde salió la configuración efectiva. */
  origin: 'default' | 'env' | 'none' | 'invalid'
  /** Cantidad de rangos efectivos (para el log de arranque; sin valores). */
  ranges: number
  /** Motivo, si TRUSTED_PROXIES fue inválido (sin el valor). */
  error?: string
}

/** Quita el prefijo IPv4-mapeado (`::ffff:a.b.c.d` → `a.b.c.d`). */
export function normalizePeerAddress(address: string | undefined): string | undefined {
  if (!address) return undefined
  const a = address.trim()
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a)
  return m ? m[1] : a
}

/** Agrega una entrada (IP o CIDR) a la lista; false si no es válida. */
function addEntry(list: net.BlockList, entry: string): boolean {
  const slash = entry.indexOf('/')
  const ip = normalizePeerAddress(slash === -1 ? entry : entry.slice(0, slash))!
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null
  if (!family) return false
  const max = family === 'ipv4' ? 32 : 128
  if (slash === -1) { list.addAddress(ip, family); return true }
  const prefixRaw = entry.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixRaw)) return false
  const prefix = Number(prefixRaw)
  if (prefix < 0 || prefix > max) return false
  list.addSubnet(ip, prefix, family)
  return true
}

const TRUST_NONE: Pick<TrustedProxies, 'trustProxy' | 'isTrustedPeer'> = {
  trustProxy: () => false,
  isTrustedPeer: () => false,
}

/**
 * Resuelve TRUSTED_PROXIES. `onUntrustedInternalForward` se invoca (una vez) si
 * llega X-Forwarded-* desde un par de red interna que NO está en la lista: casi
 * seguro un nginx en una subred no cubierta (los cupos volverían a ser compartidos).
 * Un par externo no puede dispararlo (no es interno).
 */
export function resolveTrustedProxies(
  raw: string | undefined,
  onUntrustedInternalForward?: () => void,
): TrustedProxies {
  const value = (raw ?? '').trim()
  if (value.toLowerCase() === 'none') return { ...TRUST_NONE, origin: 'none', ranges: 0 }

  const tokens = (value === '' ? DEFAULT_TRUSTED_PROXIES : value)
    .split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
  const list = new net.BlockList()
  let ranges = 0
  for (let i = 0; i < tokens.length; i++) {
    const named = NAMED_RANGES[tokens[i].toLowerCase()]
    const entries = named ?? [tokens[i]]
    for (const e of entries) {
      if (!addEntry(list, e)) {
        return { ...TRUST_NONE, origin: 'invalid', ranges: 0, error: `entrada #${i + 1} no es IP, CIDR, loopback, uniquelocal ni none` }
      }
      ranges++
    }
  }

  const isTrustedPeer = (address: string | undefined): boolean => {
    const a = normalizePeerAddress(address)
    if (!a) return false
    const family = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null
    return family !== null && list.check(a, family)
  }

  let warned = false
  const trustProxy = (address: string, hop: number): boolean => {
    // proxy-addr sólo llama con hop>=0 cuando HAY X-Forwarded-For; Fastify además
    // llama con hop 0 para X-Forwarded-Host/Proto. Sólo el salto 0, nunca más allá.
    if (hop !== 0) return false
    if (isTrustedPeer(address)) return true
    if (!warned && onUntrustedInternalForward && isInternalIp(address)) {
      warned = true
      try { onUntrustedInternalForward() } catch { /* el diagnóstico nunca rompe la petición */ }
    }
    return false
  }

  return { trustProxy, isTrustedPeer, origin: value === '' ? 'default' : 'env', ranges }
}

