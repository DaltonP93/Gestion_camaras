// apps/api/src/services/providers/hik-connect/http-spec.ts
//
// NÚCLEO PURO — tipo compartido de "especificación de request" que producen los
// builders (token/hls/isapi). Es sólo una descripción de datos: método, path
// RELATIVO (nunca un host absoluto — el host lo fija el cliente a partir del
// areaDomain/base validado), headers y body. No contiene I/O.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface HttpRequestSpec {
  method: HttpMethod
  /** Path RELATIVO a la base (empieza con '/'); jamás un host/scheme absoluto. */
  path: string
  headers: Record<string, string>
  /** Cuerpo ya serializado (form-urlencoded o JSON). Ausente en GET. */
  body?: string
}
