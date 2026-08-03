import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createOdooApiClient } = require('../../../src/adapters/outbound/odoo/odooApiClient.js')

describe('odooApiClient.searchCountryIdsByCodes', () => {
  describe('stub mode', () => {
    it('returns {} so stub runs do not blow up the resolveCountryExpense path', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.searchCountryIdsByCodes(['CR', 'GT'])).toEqual({})
    })

    it('returns {} for empty input', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.searchCountryIdsByCodes([])).toEqual({})
    })
  })

  describe('http mode', () => {
    it('returns map keyed by ISO code with {id, name}', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockResolvedValueOnce({
          data: {
            result: [
              { id: 50, code: 'CR', name: 'Costa Rica' },
              { id: 90, code: 'GT', name: 'Guatemala' }
            ]
          },
          status: 200
        })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const result = await api.searchCountryIdsByCodes(['CR', 'GT'])
      expect(result).toEqual({
        CR: { id: 50, name: 'Costa Rica' },
        GT: { id: 90, name: 'Guatemala' }
      })
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 4, 'k', 'res.country', 'search_read',
        [[['code', 'in', ['CR', 'GT']]]],
        { fields: ['id', 'code', 'name'] }
      ])
    })

    it('returns {} when input is empty (no RPC fired)', async () => {
      const post = vi.fn()
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const result = await api.searchCountryIdsByCodes([])
      expect(result).toEqual({})
      expect(post).not.toHaveBeenCalled()
    })

    it('deduplicates and trims codes before issuing the RPC', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      await api.searchCountryIdsByCodes(['CR', 'CR', ' GT ', '', null])
      const rpcArgs = post.mock.calls[1][1].params.args
      expect(rpcArgs[4]).toBe('search_read')
      expect(rpcArgs[5][0][0][2]).toEqual(['CR', 'GT'])
    })

    it('memoizes the result so concurrent calls share one RPC', async () => {
      let pending
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockImplementationOnce(() => {
          // gate the promise so the second call lands while the first is in flight
          pending = new Promise((resolve) => setTimeout(() => resolve({ data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }] }, status: 200 }), 5))
          return pending
        })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const [a, b] = await Promise.all([
        api.searchCountryIdsByCodes(['CR']),
        api.searchCountryIdsByCodes(['CR'])
      ])
      expect(a).toEqual(b)
      expect(post).toHaveBeenCalledTimes(2) // authenticate + single search_read
    })

    it('reuses cached result across calls (no second RPC repeated for the same codes)', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const a = await api.searchCountryIdsByCodes(['CR'])
      const b = await api.searchCountryIdsByCodes(['CR'])
      expect(a).toEqual(b)
      expect(post).toHaveBeenCalledTimes(2) // auth + first RPC; second call hits cache
    })
  })
})
