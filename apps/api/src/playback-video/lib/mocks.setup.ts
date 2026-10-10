// apps/api/src/playback-video/lib/mocks.setup.ts
//
// setupFile de la suite de video (vitest.video.config.ts): reemplaza SÓLO lo que no
// participa de la reproducción de grabaciones y tocaría infraestructura real:
//   - jobs en segundo plano (healthWorker, syncWorker) y re-registro de streams;
//   - `services/stream` (MediaMTX y transcodificación EN VIVO) con el doble del
//     harness conjunto, PERO conservando `getRtspTimeoutOption` REAL: el doble
//     devuelve 'timeout' sin guion y FFmpeg fallaría con ese argumento suelto
//     (la API respondía 504 NVR_OFFLINE_OR_TIMEOUT en la primera corrida).
// Quedan REALES: services/hikvision (contra el ISAPI simulado), rtsp-probe y
// child_process (FFmpeg/ffprobe reales detrás del shim del NVR simulado).
import { vi } from 'vitest'

vi.mock('../../jobs/healthWorker', async () => (await import('../../security-joint/infra-doubles')).healthWorkerDouble())
vi.mock('../../jobs/syncWorker', async () => (await import('../../security-joint/infra-doubles')).syncWorkerDouble())
vi.mock('../../services/stream-reregister', async () => (await import('../../security-joint/infra-doubles')).reregisterDouble())
vi.mock('../../services/stream', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const doubles = await import('../../security-joint/infra-doubles')
  return { ...doubles.streamModuleDouble(real), getRtspTimeoutOption: real.getRtspTimeoutOption }
})
