import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooSaleOrderSource } = require('../../../src/adapters/outbound/odoo/OdooSaleOrderSource.js')

function makeApi({ searchSalesOrdersChangedSince = async () => [] } = {}) {
  return {
    searchSalesOrdersChangedSince: vi.fn(searchSalesOrdersChangedSince)
  }
}

async function drain(generator) {
  const pages = []
  for await (const page of generator) pages.push(page)
  return pages
}

describe('OdooSaleOrderSource', () => {
  it('requires apiClient', () => {
    expect(() => new OdooSaleOrderSource({})).toThrow(/apiClient/)
  })

  describe('listChangedSince (Fase 6 — docs/plan-cambios-2026-08-05.md bidireccionalidad)', () => {
    it('requires writeDateGte', async () => {
      const api = makeApi()
      const src = new OdooSaleOrderSource({ apiClient: api, pageSize: 10 })
      await expect(drain(src.listChangedSince({}))).rejects.toThrow(/writeDateGte/)
    })

    it('yields pages from searchSalesOrdersChangedSince, passing writeDateGte through, until a short page', async () => {
      const calls = []
      const api = makeApi({
        searchSalesOrdersChangedSince: vi.fn(async (args) => {
          calls.push(args)
          if (args.offset === 0) return [{ id: 1 }, { id: 2 }]
          if (args.offset === 2) return [{ id: 3 }]
          throw new Error('should not be called again after a short page')
        })
      })
      const src = new OdooSaleOrderSource({ apiClient: api, pageSize: 2 })
      const pages = await drain(src.listChangedSince({ writeDateGte: '2026-08-01 00:00:00' }))
      expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]])
      expect(calls).toEqual([
        { writeDateGte: '2026-08-01 00:00:00', offset: 0, limit: 2 },
        { writeDateGte: '2026-08-01 00:00:00', offset: 2, limit: 2 }
      ])
    })

    it('stops without yielding when the first page is empty', async () => {
      const api = makeApi({ searchSalesOrdersChangedSince: async () => [] })
      const src = new OdooSaleOrderSource({ apiClient: api, pageSize: 10 })
      const pages = await drain(src.listChangedSince({ writeDateGte: '2026-08-01 00:00:00' }))
      expect(pages).toEqual([])
    })
  })
})
