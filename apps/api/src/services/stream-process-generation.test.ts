import { describe, it, expect, vi } from 'vitest'

process.env.ENABLE_HEVC_TRANSCODING = 'true'

type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void
const fakeProcesses: Array<{
  pid: number
  exitCode: number | null
  killed: boolean
  kill: () => boolean
  emitExit: () => void
}> = []

vi.mock('axios', () => ({
  default: { create: () => ({ get: async () => ({ data: {} }), post: async () => ({ status: 200 }), patch: async () => ({ status: 200 }), delete: async () => ({ status: 200 }) }) },
}))
vi.mock('./stream-consumer-registry', () => ({
  getStreamConsumerRegistry: () => ({ count: async () => 0 }),
}))
vi.mock('./hikvision', () => ({
  buildRtspUrl: () => 'rtsp://user:pass@host/Streaming/Channels/101',
}))
vi.mock('./transcode-profile', () => ({
  resolveGridProfile: () => ({ name: 'test', width: 1280, fps: 15, bitrate: '1500k', encoder: 'libx264' }),
  buildTranscodeArgs: () => ['-i', 'rtsp://x'],
}))
vi.mock('child_process', () => ({
  execSync: () => Buffer.from('  -timeout duration'),
  spawn: () => {
    const handlers = new Map<string, Function[]>()
    const p: any = {
      pid: 7000 + fakeProcesses.length,
      exitCode: null,
      killed: false,
      stderr: { on: (event: string, cb: Function) => {
        const list = handlers.get(`stderr:${event}`) ?? []; list.push(cb); handlers.set(`stderr:${event}`, list)
      } },
      on: (event: string, cb: Function) => {
        const list = handlers.get(event) ?? []; list.push(cb); handlers.set(event, list)
      },
      once: (event: string, cb: Function) => {
        const list = handlers.get(event) ?? []; list.push(cb); handlers.set(event, list)
      },
      kill: () => { p.killed = true; return true },
      emitExit: () => {
        p.exitCode = 0
        for (const cb of handlers.get('exit') ?? []) (cb as ExitHandler)(0, null)
      },
    }
    fakeProcesses.push(p)
    return p
  },
}))

const { spawnTranscodeProcess, isTranscodeProcessAlive } = await import('./stream')

describe('registro de proceso por instancia', () => {
  it('el callback exit de A no borra la instancia B posterior del mismo path', () => {
    const nvr: any = { id: 'n1', username: 'u', password: 'p', ipAddress: '127.0.0.1', rtspPort: 554 }
    const camera: any = { id: 'c1', channel: 1 }
    const path = 'same_path'

    const a = spawnTranscodeProcess(nvr, camera, path) as any
    const b = spawnTranscodeProcess(nvr, camera, path) as any
    expect(b).toBeTruthy()
    expect(isTranscodeProcessAlive(path)).toBe(true)

    a.emitExit()

    expect(isTranscodeProcessAlive(path)).toBe(true)
  })
})
