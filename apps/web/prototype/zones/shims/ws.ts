// Sustituto VisionCore de `@/api/ws` de Frigate para el editor de zonas portado.
// En Frigate el estado activado/desactivado de cada zona llega por su WebSocket;
// en VisionCore sale de la propia API (CameraAnalyticsConfig) y viaja en
// `polygon.enabled`. Sin suscripciones ni valores, `usePolygonStates` usa
// `polygon.enabled ?? true` (vendor/frigate/hooks/use-polygon-states.ts).
export function subscribeWsTopic(_topic: string, _listener: () => void): () => void {
  return () => {}
}

export function getWsTopicValue(_topic: string): unknown {
  return undefined
}
