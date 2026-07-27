import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooProductSource } = require('../../../src/adapters/outbound/odoo/OdooProductSource.js')

function makeApi({
  count = async () => 0,
  search = async () => []
} = {}) {
  return {
    countProductsWithDefaultCode: vi.fn(count),
    searchProductsWithDefaultCode: vi.fn(search)
  }
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
})
