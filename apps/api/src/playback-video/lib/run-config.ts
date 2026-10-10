// apps/api/src/playback-video/lib/run-config.ts
//
// Configuración compartida de UNA corrida de la suite de video: la arma
// global-setup.ts (medios generados, web compilada, directorios) y la reciben los
// archivos de escenarios con `inject('videoRun')`.

import path from 'node:path'
import type { SimManifest } from '../media/generate'

export interface VideoRun {
  /** Directorio temporal corto (socket UNIX ≤ 108 bytes) con medios, web y trabajo del simulador. */
  runDir: string
  /** Raíz de trabajo del shim de ffmpeg (identifica los procesos de ESTA corrida). */
  simWorkRoot: string
  reportDir: string
  manifest: SimManifest
  webMode: 'build' | 'dev'
  webDist: string | null
  viteCacheDir: string
  realFfmpeg: string
  realFfprobe: string
  startedAt: string
}

declare module 'vitest' {
  export interface ProvidedContext { videoRun: VideoRun }
}

export const API_ROOT = path.resolve(__dirname, '../../..')
export const WEB_ROOT = path.resolve(API_ROOT, '../web')
export const SIM_BIN = path.resolve(__dirname, '../nvr-sim/bin')
