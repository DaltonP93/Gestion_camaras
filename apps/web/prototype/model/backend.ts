// Estado de backend de cada configuración o control del prototipo. Mientras el
// prototipo no esté conectado, NADA de lo que se guarde o ejecute en él se aplica:
//   - 'simulado': todavía no existe en el backend (hay que diseñarlo e implementarlo);
//   - 'existente': la API ya lo tiene (se indica el endpoint), pero el prototipo no
//     lo llama.
// La marca se muestra siempre (no sólo al guardar) hasta que el control tenga
// aplicación real en el backend y quede conectado.

export type BackendStatus =
  | { kind: 'simulado'; note?: string }
  | { kind: 'existente'; endpoint: string; note?: string }

export const SIMULATED: BackendStatus = { kind: 'simulado' }

export function backendText(s: BackendStatus): string {
  const base = s.kind === 'simulado'
    ? 'Simulado — no se aplica en el backend'
    : `Existe en backend (${s.endpoint}) — no conectado en el prototipo`
  return s.note ? `${base} · ${s.note}` : base
}

/** Texto de "guardar": dice explícitamente que no se aplicó. */
export function notAppliedText(s: BackendStatus): string {
  return s.kind === 'simulado'
    ? 'No se aplicó: es una configuración simulada, sin backend.'
    : `No se aplicó en el backend: el prototipo no llama a ${s.endpoint}.`
}

export interface NotAppliedGroup {
  kind: BackendStatus['kind']
  /** Controles cambiados que comparten este estado (en el orden del formulario). */
  labels: string[]
  text: string
}

/**
 * Aviso de "guardar" a partir de los controles CAMBIADOS (no de la marca de su
 * sección): agrupa los simulados por un lado y los existentes por endpoint por el
 * otro. Así, cambiar un control que existe dentro de una sección simulada (o al
 * revés) no dice lo contrario de lo que pasaría con ese control.
 */
export function notAppliedGroups(changed: Array<{ label: string; status: BackendStatus }>): NotAppliedGroup[] {
  const groups = new Map<string, NotAppliedGroup>()
  for (const { label, status } of changed) {
    const key = status.kind === 'simulado' ? 'simulado' : `existente ${status.endpoint}`
    const g = groups.get(key)
    if (g) g.labels.push(label)
    else groups.set(key, { kind: status.kind, labels: [label], text: notAppliedText(status) })
  }
  return Array.from(groups.values())
}

/** Texto de una acción (botón): dice explícitamente que no se ejecutó. */
export function notExecutedText(s: BackendStatus): string {
  return s.kind === 'simulado'
    ? 'No se ejecutó: es una acción simulada, sin backend.'
    : `No se ejecutó en el backend: el prototipo no llama a ${s.endpoint}.`
}

// Controles fuera de Configuración. Los endpoints son los de apps/api (rutas
// registradas en server.ts); verificados contra el código, no contra un servidor.

export const LIVE_BACKEND = {
  viewers: { kind: 'existente', endpoint: 'GET/POST /api/views · PUT/DELETE /api/views/:id', note: 'los visores se guardan sólo en este navegador' },
  ptz: { kind: 'existente', endpoint: 'POST /api/cameras/:id/ptz' },
  video: { kind: 'existente', endpoint: 'POST /api/cameras/:id/start-stream (streamType sub/main)', note: 'celdas sin video: el prototipo no abre streams' },
} satisfies Record<string, BackendStatus>

export const PLAYBACK_BACKEND = {
  search: { kind: 'existente', endpoint: 'GET /api/recordings/search · POST /api/recordings/batch-search', note: 'tramos y huecos simulados' },
  admission: { kind: 'existente', endpoint: 'NVR.maxConcurrentPlaybackSessions · POST /api/recordings/playback' },
  sync: { kind: 'simulado', note: 'reloj común, desfase y resincronización sin video real' },
  stallSim: { kind: 'simulado', note: 'control sólo del prototipo para provocar un bloqueo' },
} satisfies Record<string, BackendStatus>

export const EVENTS_BACKEND = {
  list: { kind: 'existente', endpoint: 'GET /api/analytics/events', note: 'retención de clips simulada' },
} satisfies Record<string, BackendStatus>
