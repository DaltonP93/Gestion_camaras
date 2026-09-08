// Stub liviano de `@/components/cameras/VideoPlayer` para el harness de E2E.
//
// El E2E ejercita el CICLO DE VIDA de la página (arranque/cierre de sesión por
// identidad, pantalla completa, bfcache), no el reproductor HLS. Reemplazar el
// reproductor real evita la carga de hls.js contra streams inexistentes (que en
// headless produce ruido/timeouts) sin alterar el flujo: los controles que el
// test acciona (maximizar / minimizar / navegar) son botones de la PÁGINA, no del
// reproductor. La corrección del reproductor HTML5 real es NOT_VALIDATED acá (ver
// e2e/README.md) — requiere un stream real, fuera del alcance de este harness.
import type { ReactNode } from 'react'

export type CameraPlaybackErrorCode = string

export interface CameraPlaybackError {
  code: CameraPlaybackErrorCode
  message?: string
}

export interface VideoPlayerStubProps {
  hlsUrl?: string
  cameraName?: string
  cameraId?: string
  streamType?: string
  onFullscreen?: () => void
  onStreamError?: (cameraId: string, err: CameraPlaybackError) => void
  children?: ReactNode
  className?: string
}

export function VideoPlayer(props: VideoPlayerStubProps) {
  return (
    <div
      data-testid={`video-${props.cameraId ?? 'unknown'}`}
      data-hls={props.hlsUrl ?? ''}
      data-stream-type={props.streamType ?? ''}
      className={props.className}
      style={{ width: '100%', height: '100%', background: '#111' }}
      onDoubleClick={() => props.onFullscreen?.()}
    >
      <span style={{ color: '#666', fontSize: 10 }}>{props.cameraName ?? ''}</span>
    </div>
  )
}
