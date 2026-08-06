import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooProductSource } = require('../../../src/adapters/outbound/odoo/OdooProductSource.js')

function makeApi({
  count = async () => 0,
  search = async () => [],
  countProductsAll = async () => 0,
  searchProductsAll = async () => [],
  searchProductsChangedSince = async () => []
} = {}) {
  return {
    countProductsWithDefaultCode: vi.fn(count),
    searchProductsWithDefaultCode: vi.fn(search),
    countProductsAll: vi.fn(countProductsAll),
    searchProductsAll: vi.fn(searchProductsAll),
    searchProductsChangedSince: vi.fn(searchProductsChangedSince)
  }
}

async function drain(generator) {
  const pages = []
  for await (const page of generator) pages.push(page)
  return pages
}

describe('OdooProductSource', () => {
  it('count returns api countProductsWithDefaultCode result', async () => {
    const api = makeApi({ count: async () => 42 })
    const src = new OdooProductSource({ apiClient: api, pageSize: 10 })
    expect(await src.count()).toBe(42)
    expect(api.countProductsWithDefaultCode).toHaveBeenCalledTimes(1)
  })

  it('listAll paginates with offset and accumulates pages', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }]
        if (offset === 3) return [{ id: 4, name: 'D' }]
        return []
      })
    })
    const src = new OdooProductSource({ apiClient: api, pageSize: 3 })
    const all = await src.listAll({})
    expect(all).toEqual([
      { id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' },
      { id: 4, name: 'D' }
    ])
    expect(api.searchProductsWithDefaultCode.mock.calls[0][0]).toEqual({ offset: 0, limit: 3 })
    expect(api.searchProductsWithDefaultCode.mock.calls[1][0]).toEqual({ offset: 3, limit: 3 })
  })

  it('listAll({limit:N}) caps total products returned', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
        return []
      })
    })
    const src = new OdooProductSource({ apiClient: api, pageSize: 5 })
    const all = await src.listAll({ limit: 3 })
    expect(all).toHaveLength(3)
    expect(all.map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('listAll returns empty when api returns empty first page', async () => {
    const api = makeApi({ search: async () => [] })
    const src = new OdooProductSource({ apiClient: api, pageSize: 100 })
    expect(await src.listAll({})).toEqual([])
  })

  it('listAll stops when page is smaller than pageSize', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }]
        throw new Error('should not be called for offset>0')
      })
    })
    const src = new OdooProductSource({ apiClient: api, pageSize: 10 })
    const all = await src.listAll({})
    expect(all).toHaveLength(2)
  })

  it('with includeNoSku=true uses searchProductsAll/countProductsAll and returns all products', async () => {
    const api = makeApi({
      countProductsAll: async () => 3,
      searchProductsAll: async ({ offset }) => {
        if (offset === 0) return [{ id: 1, default_code: false, name: 'A' }, { id: 2, default_code: 'B', name: 'B' }, { id: 3, default_code: false, name: 'C' }]
        return []
      }
    })
    const src = new OdooProductSource({ apiClient: api, pageSize: 10 })
    expect(await src.count({ includeNoSku: true })).toBe(3)
    const all = await src.listAll({ includeNoSku: true })
    expect(all).toHaveLength(3)
    expect(api.searchProductsAll).toHaveBeenCalled()
    expect(api.searchProductsWithDefaultCode).not.toHaveBeenCalled()
  })

  it('includeNoSku=true paginates with searchProductsAll (no domain filter)', async () => {
    const api = makeApi({
      searchProductsAll: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }, { id: 3 }]
        return []
      })
    })
    const src = new OdooProductSource({ apiClient: api, pageSize: 3 })
    const all = await src.listAll({ includeNoSku: true })
    expect(all).toHaveLength(3)
    expect(api.searchProductsAll).toHaveBeenCalled()
    expect(api.searchProductsWithDefaultCode).not.toHaveBeenCalled()
  })

  it('listAll({limit:N}) still caps the result when the terminal page is shorter than pageSize (limit-after-break bug)', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }, { id: 3 }]
        return []
      })
    })
    // pageSize=10 so the single page (3 items) is already "short" -> triggers the break
    // path, which historically returned all 3 instead of respecting limit=2.
    const src = new OdooProductSource({ apiClient: api, pageSize: 10 })
    const all = await src.listAll({ limit: 2 })
    expect(all.map((p) => p.id)).toEqual([1, 2])
  })

  describe('listChangedSince (Fase 3 — docs/plan-cambios-2026-08-05.md incremental sync)', () => {
    it('requires writeDateGte', async () => {
      const api = makeApi()
      const src = new OdooProductSource({ apiClient: api, pageSize: 10 })
      await expect(drain(src.listChangedSince({}))).rejects.toThrow(/writeDateGte/)
    })

    it('yields pages from searchProductsChangedSince, passing writeDateGte/includeNoSku through, until a short page', async () => {
      const calls = []
      const api = makeApi({
        searchProductsChangedSince: vi.fn(async (args) => {
          calls.push(args)
          if (args.offset === 0) return [{ id: 1 }, { id: 2 }]
          if (args.offset === 2) return [{ id: 3 }]
          throw new Error('should not be called again after a short page')
        })
      })
      const src = new OdooProductSource({ apiClient: api, pageSize: 2 })
      const pages = await drain(src.listChangedSince({ writeDateGte: '2026-08-01 00:00:00', includeNoSku: true }))
      expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]])
      expect(calls).toEqual([
        { writeDateGte: '2026-08-01 00:00:00', offset: 0, limit: 2, includeNoSku: true },
        { writeDateGte: '2026-08-01 00:00:00', offset: 2, limit: 2, includeNoSku: true }
      ])
    })

    it('stops without yielding when the first page is empty', async () => {
      const api = makeApi({ searchProductsChangedSince: async () => [] })
      const src = new OdooProductSource({ apiClient: api, pageSize: 10 })
      const pages = await drain(src.listChangedSince({ writeDateGte: '2026-08-01 00:00:00' }))
      expect(pages).toEqual([])
    })
  })
})
