// apps/api/src/services/media/source-lifecycle.lister.test.ts
//
// B3 — createMediaMtxPathLister: paginación de /v3/paths/list y tratamiento de
// listas potencialmente TRUNCADAS como NO-autoritativas (null ⇒ reconcile no
// retira). Usa un cliente axios falso (sin MediaMTX real).

import { vi, describe, it, expect, beforeEach } from 'vitest'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('axios', () => ({ default: { create: () => ({ get: getMock }) } }))

import { createMediaMtxPathLister } from './source-lifecycle'

const ITEMS_PER_PAGE = 1000
const readyItem = (name: string) => ({ name, ready: true })

beforeEach(() => getMock.mockReset())

describe('createMediaMtxPathLister (B3)', () => {
  it('una página con pageCount=1 ⇒ devuelve los ready y filtra los no-ready', async () => {
    getMock.mockResolvedValueOnce({ status: 200, data: { pageCount: 1, items: [readyItem('nvr_a_sub'), { name: 'nvr_b_sub', ready: false }] } })
    const out = await createMediaMtxPathLister('http://x').listReadyPaths()
    expect(out).toEqual(['nvr_a_sub'])
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock.mock.calls[0][1].params).toEqual({ page: 0, itemsPerPage: ITEMS_PER_PAGE })
  })

  it('varias páginas (pageCount=2) ⇒ concatena TODAS (no trunca fuentes vivas)', async () => {
    getMock
      .mockResolvedValueOnce({ status: 200, data: { pageCount: 2, items: [readyItem('nvr_a_sub'), { name: 'off', ready: false }] } })
      .mockResolvedValueOnce({ status: 200, data: { pageCount: 2, items: [readyItem('nvr_b_main')] } })
    const out = await createMediaMtxPathLister('http://x').listReadyPaths()
    expect(out).toEqual(['nvr_a_sub', 'nvr_b_main'])
    expect(getMock).toHaveBeenCalledTimes(2)
    expect(getMock.mock.calls[0][1].params.page).toBe(0)
    expect(getMock.mock.calls[1][1].params.page).toBe(1)
  })

  it('respuesta no-200 ⇒ null (API caída, NO-autoritativa)', async () => {
    getMock.mockResolvedValueOnce({ status: 500, data: {} })
    expect(await createMediaMtxPathLister('http://x').listReadyPaths()).toBeNull()
  })

  it('página LLENA sin pageCount fiable ⇒ null (podría estar TRUNCADA)', async () => {
    const full = Array.from({ length: ITEMS_PER_PAGE }, (_v, i) => readyItem(`nvr_${i}_sub`))
    getMock.mockResolvedValueOnce({ status: 200, data: { items: full } })  // sin pageCount
    expect(await createMediaMtxPathLister('http://x').listReadyPaths()).toBeNull()
  })

  it('página INCOMPLETA sin pageCount ⇒ se considera la lista completa', async () => {
    getMock.mockResolvedValueOnce({ status: 200, data: { items: [readyItem('nvr_a_sub')] } })  // < itemsPerPage
    expect(await createMediaMtxPathLister('http://x').listReadyPaths()).toEqual(['nvr_a_sub'])
  })

  it('error de red ⇒ null (NO-autoritativa)', async () => {
    getMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(await createMediaMtxPathLister('http://x').listReadyPaths()).toBeNull()
  })
})
