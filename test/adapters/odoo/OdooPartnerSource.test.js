import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooPartnerSource } = require('../../../src/adapters/outbound/odoo/OdooPartnerSource.js')

function makeApi({
  count = async () => 0,
  search = async () => [],
  searchChangedSince = async () => []
} = {}) {
  return {
    countPartners: vi.fn(count),
    searchPartnersAll: vi.fn(search),
    searchPartnersChangedSince: vi.fn(searchChangedSince)
  }
}

async function drain(generator) {
  const pages = []
  for await (const page of generator) pages.push(page)
  return pages
}

describe('OdooPartnerSource', () => {
  it('throws when constructed without apiClient', () => {
    expect(() => new OdooPartnerSource({})).toThrow(/apiClient/)
  })

  it('count returns api countPartners result', async () => {
    const api = makeApi({ count: async () => 17 })
    const src = new OdooPartnerSource({ apiClient: api, pageSize: 10 })
    expect(await src.count()).toBe(17)
    expect(api.countPartners).toHaveBeenCalledTimes(1)
  })

  it('listAll paginates with offset and accumulates pages', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }, { id: 3 }]
        if (offset === 3) return [{ id: 4 }]
        return []
      })
    })
    const src = new OdooPartnerSource({ apiClient: api, pageSize: 3 })
    const all = await src.listAll({})
    expect(all).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    expect(api.searchPartnersAll.mock.calls[0][0]).toEqual({ offset: 0, limit: 3 })
    expect(api.searchPartnersAll.mock.calls[1][0]).toEqual({ offset: 3, limit: 3 })
  })

  it('listAll({limit:N}) caps the total partners returned', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
        return []
      })
    })
    const src = new OdooPartnerSource({ apiClient: api, pageSize: 5 })
    const all = await src.listAll({ limit: 3 })
    expect(all.map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('listAll returns empty when api returns empty first page', async () => {
    const api = makeApi({ search: async () => [] })
    const src = new OdooPartnerSource({ apiClient: api, pageSize: 100 })
    expect(await src.listAll({})).toEqual([])
  })

  it('listAll stops when page is smaller than pageSize (short-page stop)', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }]
        throw new Error('should not be called for offset>0')
      })
    })
    const src = new OdooPartnerSource({ apiClient: api, pageSize: 10 })
    const all = await src.listAll({})
    expect(all).toHaveLength(2)
  })

  it('listAll({limit:N}) still caps the result when the terminal page is shorter than pageSize', async () => {
    const api = makeApi({
      search: vi.fn(async ({ offset }) => {
        if (offset === 0) return [{ id: 1 }, { id: 2 }, { id: 3 }]
        return []
      })
    })
    const src = new OdooPartnerSource({ apiClient: api, pageSize: 10 })
    const all = await src.listAll({ limit: 2 })
    expect(all.map((p) => p.id)).toEqual([1, 2])
  })

  describe('listChangedSince', () => {
    it('requires writeDateGte', async () => {
      const api = makeApi()
      const src = new OdooPartnerSource({ apiClient: api, pageSize: 10 })
      await expect(drain(src.listChangedSince({}))).rejects.toThrow(/writeDateGte/)
    })

    it('yields pages from searchPartnersChangedSince, passing writeDateGte through, until a short page (generator termination)', async () => {
      const calls = []
      const api = makeApi({
        searchChangedSince: vi.fn(async (args) => {
          calls.push(args)
          if (args.offset === 0) return [{ id: 1 }, { id: 2 }]
          if (args.offset === 2) return [{ id: 3 }]
          throw new Error('should not be called again after a short page')
        })
      })
      const src = new OdooPartnerSource({ apiClient: api, pageSize: 2 })
      const pages = await drain(src.listChangedSince({ writeDateGte: '2026-08-01 00:00:00' }))
      expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]])
      expect(calls).toEqual([
        { writeDateGte: '2026-08-01 00:00:00', offset: 0, limit: 2 },
        { writeDateGte: '2026-08-01 00:00:00', offset: 2, limit: 2 }
      ])
    })

    it('stops without yielding when the first page is empty', async () => {
      const api = makeApi({ searchChangedSince: async () => [] })
      const src = new OdooPartnerSource({ apiClient: api, pageSize: 10 })
      const pages = await drain(src.listChangedSince({ writeDateGte: '2026-08-01 00:00:00' }))
      expect(pages).toEqual([])
    })
  })
})
