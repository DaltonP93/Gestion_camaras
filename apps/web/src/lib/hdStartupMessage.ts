// Mensaje honesto para el tramo que el operador percibe al abrir HD.
// La prueba C21 en producción midió liberación de cupo en el mismo segundo y
// preparación HLS transcodificada de ~5–7 s. No atribuir esa espera al cupo.

export function codecIsHevc(codec?: string | null): boolean {
  return /hevc|h\.?265|hvc1/i.test(codec ?? '')
}

export function hdStartupMessage(options: {
  mainCodec?: string | null
  transcodingAvailable: boolean
  requestedType?: 'main' | 'main_h264' | null
}): string {
  if (
    options.requestedType === 'main_h264' ||
    (codecIsHevc(options.mainCodec) && options.transcodingAvailable)
  ) {
    return 'Preparando HD H.264 en el servidor (normal: 5–7 s)…'
  }
  return 'Cambiando a video HD…'
}
