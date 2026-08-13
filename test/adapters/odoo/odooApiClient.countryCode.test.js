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

    it('does NOT cross-poison results when concurrent calls request DIFFERENT codes', async () => {
      // Regression test: the fan-out enqueues one quote job per country and
      // WORKER_CONCURRENCY runs several in parallel, each resolving a single,
      // different ISO. A shared in-flight promise keyed on nothing (the
      // original bug) means the loser of the race gets the winner's country
      // map instead of its own. `post` answers from the actual request body
      // rather than call order, so this holds regardless of interleaving.
      const countryRows = {
        GT: { id: 90, code: 'GT', name: 'Guatemala' },
        HN: { id: 96, code: 'HN', name: 'Honduras' }
      }
      const post = vi.fn(async (_url, body) => {
        if (body.params.method === 'authenticate') return { data: { result: 4 }, status: 200 }
        const requestedCodes = body.params.args[5][0][0][2]
        const rows = requestedCodes.map((c) => countryRows[c]).filter(Boolean)
        return { data: { result: rows }, status: 200 }
      })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const [gt, hn] = await Promise.all([
        api.searchCountryIdsByCodes(['GT']),
        api.searchCountryIdsByCodes(['HN'])
      ])
      expect(gt).toEqual({ GT: { id: 90, name: 'Guatemala' } })
      expect(hn).toEqual({ HN: { id: 96, name: 'Honduras' } })
    })

    it('does not cache a failed RPC — a later call for the same code retries fresh', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce({ data: { result: [{ id: 90, code: 'GT', name: 'Guatemala' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      await expect(api.searchCountryIdsByCodes(['GT'])).rejects.toThrow('network blip')
      const result = await api.searchCountryIdsByCodes(['GT'])
      expect(result).toEqual({ GT: { id: 90, name: 'Guatemala' } })
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

describe('odooApiClient.readCountriesByIds', () => {
  describe('stub mode', () => {
    it('returns {} so stub runs do not blow up the country-derivation path', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.readCountriesByIds([50, 90])).toEqual({})
    })

    it('returns {} for empty input', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.readCountriesByIds([])).toEqual({})
    })
  })

  describe('http mode', () => {
    it('returns map keyed by numeric id with {code, name}', async () => {
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
      const result = await api.readCountriesByIds([50, 90])
      expect(result).toEqual({
        50: { code: 'CR', name: 'Costa Rica' },
        90: { code: 'GT', name: 'Guatemala' }
      })
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 4, 'k', 'res.country', 'search_read',
        [[['id', 'in', [50, 90]]]],
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
      const result = await api.readCountriesByIds([])
      expect(result).toEqual({})
      expect(post).not.toHaveBeenCalled()
    })

    it('deduplicates ids before issuing the RPC', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      await api.readCountriesByIds([50, 50, 90, null])
      const rpcArgs = post.mock.calls[1][1].params.args
      expect(rpcArgs[4]).toBe('search_read')
      expect(rpcArgs[5][0][0][2]).toEqual([50, 90])
    })

    it('memoizes the result so concurrent calls share one RPC', async () => {
      let pending
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockImplementationOnce(() => {
          pending = new Promise((resolve) => setTimeout(() => resolve({ data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }] }, status: 200 }), 5))
          return pending
        })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const [a, b] = await Promise.all([
        api.readCountriesByIds([50]),
        api.readCountriesByIds([50])
      ])
      expect(a).toEqual(b)
      expect(post).toHaveBeenCalledTimes(2) // authenticate + single search_read
    })

    it('does NOT cross-poison results when concurrent calls request DIFFERENT ids', async () => {
      // Mirrors the searchCountryIdsByCodes regression above, but keyed by id:
      // each id must resolve from its OWN derived promise, so the loser of a
      // race can never resolve with the winner's country row.
      const countryRows = {
        90: { id: 90, code: 'GT', name: 'Guatemala' },
        96: { id: 96, code: 'HN', name: 'Honduras' }
      }
      const post = vi.fn(async (_url, body) => {
        if (body.params.method === 'authenticate') return { data: { result: 4 }, status: 200 }
        const requestedIds = body.params.args[5][0][0][2]
        const rows = requestedIds.map((id) => countryRows[id]).filter(Boolean)
        return { data: { result: rows }, status: 200 }
      })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const [gt, hn] = await Promise.all([
        api.readCountriesByIds([90]),
        api.readCountriesByIds([96])
      ])
      expect(gt).toEqual({ 90: { code: 'GT', name: 'Guatemala' } })
      expect(hn).toEqual({ 96: { code: 'HN', name: 'Honduras' } })
    })

    it('does not cache a failed RPC — a later call for the same id retries fresh', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce({ data: { result: [{ id: 90, code: 'GT', name: 'Guatemala' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      await expect(api.readCountriesByIds([90])).rejects.toThrow('network blip')
      const result = await api.readCountriesByIds([90])
      expect(result).toEqual({ 90: { code: 'GT', name: 'Guatemala' } })
    })

    it('reuses cached result across calls (no second RPC repeated for the same ids)', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k',
        transport: { post }
      })
      const a = await api.readCountriesByIds([50])
      const b = await api.readCountriesByIds([50])
      expect(a).toEqual(b)
      expect(post).toHaveBeenCalledTimes(2) // auth + first RPC; second call hits cache
    })
  })
})
