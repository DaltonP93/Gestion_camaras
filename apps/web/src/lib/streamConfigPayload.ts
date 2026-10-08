// Payload de PUT /nvrs/:id/video-audio/:channel desde la edición de "Video y audio"
// (NVRDetailPage).
//
// La pantalla NO lee el estado real del audio (GET /nvrs/:id/video-audio no lo
// trae), así que el audio sólo viaja si el usuario lo eligió explícitamente. El
// codec y el bitrate de audio no se editan en esta pantalla y nunca se envían.
// Antes cada guardado mandaba audioEnabled:false, audioCodecType:'' y
// audioBitrate:64 aunque sólo se cambiara el FPS: con el servicio anterior eso
// apagaba el CANAL (primer <enabled> del XML) y vaciaba el codec de audio.

export type AudioChoice = 'keep' | 'on' | 'off'

export interface StreamEditForm {
  videoCodecType: string
  width:          number
  height:         number
  fps:            number
  bitrateMax:     number
  bitrateType:    string
  /** 'keep' (o ausente) ⇒ no se envía nada de audio. */
  audio?:         AudioChoice
}

export function buildStreamPayload(streamType: 'main' | 'sub', form: Partial<StreamEditForm>): Record<string, unknown> {
  const { audio, ...video } = form
  const payload: Record<string, unknown> = { streamType, ...video }
  if (audio === 'on')  payload.audioEnabled = true
  if (audio === 'off') payload.audioEnabled = false
  return payload
}
