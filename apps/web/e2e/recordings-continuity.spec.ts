import { test, expect, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { installRecordingsMock, RECORDING_START } from './fixtures/recordings-mock'

// Keep time-zone conversion out of this suite: its subject is media continuity.
test.use({ timezoneId: 'UTC' })

async function openRecordings(page: Page) {
  await page.goto(`/recordings?cameraId=camA&t=${encodeURIComponent(RECORDING_START)}`)
  await expect(page.locator('video')).toHaveCount(1)
}

async function assertDecodedFrame(page: Page, sessionId: string) {
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement, id) =>
    v.currentSrc.includes(id) && v.currentTime > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 0,
  sessionId)).toBe(true)
}

// Browser-side measurement, using frame presentation callbacks rather than
// HTTP 200 / loadedmetadata / play() resolution as a proxy for the first frame.
async function observeFrames(page: Page) {
  await page.addInitScript(() => {
    const samples: Array<{ source: string; firstFrameMs: number; lastFrameMs: number; lastMediaTime: number; frames: number }> = []
    Object.assign(window, { recordingFrameSamples: samples })
    document.addEventListener('loadedmetadata', event => {
      const v = event.target
      if (!(v instanceof HTMLVideoElement)) return
      const source = v.currentSrc
      const sample = { source: new URL(source).pathname, firstFrameMs: 0, lastFrameMs: 0, lastMediaTime: 0, frames: 0 }
      const frame: VideoFrameRequestCallback = (now, metadata) => {
        if (v.currentSrc !== source) return
        if (sample.frames === 0) { sample.firstFrameMs = now; samples.push(sample) }
        sample.lastFrameMs = now
        sample.lastMediaTime = metadata.mediaTime
        sample.frames++
        v.requestVideoFrameCallback(frame)
      }
      v.requestVideoFrameCallback(frame)
    }, true)
  })
}

test.describe('RecordingsPage · API simulada + video fMP4 real', () => {
  test('registra el sucesor antes de cerrar al predecesor y reproduce tres bloques', async ({ page }, testInfo) => {
    const mock = await installRecordingsMock(page, { holdSuccessor: true })
    await observeFrames(page)
    await openRecordings(page)
    await assertDecodedFrame(page, '0000000000000001')
    await expect.poll(() => mock.starts.length).toBe(2)
    const [first, second] = mock.starts
    expect(second.predecessor).toBe(first.id)
    expect(second.predecessorActive).toBe(true)
    expect(mock.events).not.toContain(`delete:${first.id}`)

    mock.releaseSuccessor()
    await assertDecodedFrame(page, second.id)
    expect(mock.events.indexOf(`accepted:${second.id}`)).toBeLessThan(mock.events.indexOf(`delete:${first.id}`))
    await expect.poll(() => mock.starts.length).toBe(3)
    await assertDecodedFrame(page, mock.starts[2].id)
    await expect.poll(() => mock.active.size).toBe(0) // last block ended
    expect(mock.starts).toHaveLength(3)
    for (const s of mock.starts) expect(mock.events.filter(e => e === `delete:${s.id}`)).toHaveLength(1)
    expect(mock.unexpected).toEqual([])

    const frames = await page.evaluate(() => (window as any).recordingFrameSamples)
    expect(frames).toHaveLength(3)
    for (const sample of frames) {
      expect(sample.frames).toBeGreaterThan(1)
      expect(sample.lastMediaTime).toBeGreaterThan(3.5)
    }
    const evidence = testInfo.outputPath('synthetic-frame-timings.json')
    await writeFile(evidence, JSON.stringify({
        environment: 'Chromium, local synthetic VP9, mocked API; not NVR latency',
        frames,
        transitionMs: frames.slice(1).map((s: any, i: number) => s.firstFrameMs - frames[i].lastFrameMs),
      }, null, 2))
    await testInfo.attach('synthetic-frame-timings.json', { contentType: 'application/json', path: evidence })
  })

  test('una espera de datos mayor que el bloque no salta video sin reproducir', async ({ page }) => {
    const mock = await installRecordingsMock(page, { holdFirstMedia: true })
    await openRecordings(page)
    await expect.poll(() => mock.events.some(e => e.startsWith('media:'))).toBe(true)
    // Deliberately exceed the old 4s clip + 1s timer. This waits on the real
    // browser clock; media playback itself is never faked or fast-forwarded.
    await page.waitForTimeout(6000)
    expect(mock.starts).toHaveLength(1)
    expect(mock.events.some(e => e.startsWith('delete:'))).toBe(false)
    mock.releaseFirstMedia()
    await assertDecodedFrame(page, mock.starts[0].id)
    await expect.poll(() => mock.starts.length).toBe(2)
    await assertDecodedFrame(page, mock.starts[1].id)
    await page.getByRole('link', { name: 'Salir del banco de reproducción' }).click()
    await expect.poll(() => mock.active.size).toBe(0)
    expect(mock.unexpected).toEqual([])
  })

  test('cerrar mientras llega un sucesor cancela la respuesta tardía', async ({ page }) => {
    const mock = await installRecordingsMock(page, { holdSuccessor: true })
    await openRecordings(page)
    await assertDecodedFrame(page, '0000000000000001')
    await expect.poll(() => mock.starts.length).toBe(2)
    await page.getByRole('button', { name: 'Cerrar cámara de este canal' }).click()
    mock.releaseSuccessor()
    await expect.poll(() => mock.active.size).toBe(0)
    expect(mock.events).not.toContain(`media:${mock.starts[1].id}`)
    expect(mock.unexpected).toEqual([])
  })

  test('rechazo del sucesor libera el anterior y conserva el error de permisos', async ({ page }) => {
    const mock = await installRecordingsMock(page, { rejectSuccessor: true })
    await openRecordings(page)
    await assertDecodedFrame(page, '0000000000000001')
    await expect.poll(() => mock.starts.length).toBe(2)
    await expect(page.getByText('Sin permiso de reproducción (prueba)', { exact: true })).toBeVisible()
    await expect.poll(() => mock.active.size).toBe(0)
    expect(mock.events).not.toContain(`media:${mock.starts[1].id}`)
    expect(mock.unexpected).toEqual([])
  })

  test('pausa y cambio de velocidad no adelantan un bloque por tiempo de pared', async ({ page }) => {
    const mock = await installRecordingsMock(page)
    await openRecordings(page)
    await assertDecodedFrame(page, '0000000000000001')
    await page.getByRole('button', { name: 'Pausar', exact: true }).click()
    await page.waitForTimeout(5500)
    expect(mock.starts).toHaveLength(1)
    await page.getByRole('button', { name: '2×', exact: true }).click()
    await page.getByRole('button', { name: 'Reproducir', exact: true }).click()
    await expect.poll(() => mock.starts.length).toBe(2)
    await assertDecodedFrame(page, mock.starts[1].id)
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2)
    await page.getByRole('link', { name: 'Salir del banco de reproducción' }).click()
    await expect.poll(() => mock.active.size).toBe(0)
    expect(mock.unexpected).toEqual([])
  })

  test('un hueco de seis segundos continúa en 1×1 sin pedir otro clic', async ({ page }) => {
    const mock = await installRecordingsMock(page, { gapSeconds: 6 })
    await openRecordings(page)
    await assertDecodedFrame(page, '0000000000000001')
    await expect.poll(() => mock.starts.length).toBe(2)
    expect(mock.starts[1].body.startTime).toBe('2026-01-01T12:00:10.000Z')
    expect(mock.starts[1].predecessorActive).toBe(true)
    await assertDecodedFrame(page, mock.starts[1].id)
    await page.getByRole('link', { name: 'Salir del banco de reproducción' }).click()
    await expect.poll(() => mock.active.size).toBe(0)
    expect(mock.unexpected).toEqual([])
  })
})
