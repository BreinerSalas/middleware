import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createOdooApiClient } = require('../../../src/adapters/outbound/odoo/odooApiClient.js')

// (sdd/hubspot-product-reverse-discovery, design D5) `readProductPrices` mirrors
// `readProductUoms` — a batched `product.product` read used by Track A to compare an
// orphan's HubSpot `price` against each name-matched Odoo candidate's `list_price`.
describe('odooApiClient - readProductPrices (Track A price disambiguation, D5)', () => {
  it('http mode readProductPrices returns map of productId->list_price', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 17, list_price: 93.04 },
            { id: 18, list_price: 45.5 }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.readProductPrices([17, 18])
    expect(r).toEqual({ 17: 93.04, 18: 45.5 })
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'product.product', 'read',
      [[17, 18]],
      { fields: ['id', 'list_price'] }
    ])
  })

  it('http mode readProductPrices skips rows with no id', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: { result: [{ id: null, list_price: 10 }, { id: 18, list_price: 45.5 }] },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.readProductPrices([17, 18])
    expect(r).toEqual({ 18: 45.5 })
  })

  it('http mode readProductPrices returns empty map for empty or non-numeric input', async () => {
    const post = vi.fn()
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    expect(await api.readProductPrices([])).toEqual({})
    expect(await api.readProductPrices(['not-a-number'])).toEqual({})
    expect(post).not.toHaveBeenCalled()
  })

  it('stub mode readProductPrices returns empty map', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    const r = await api.readProductPrices([1])
    expect(r).toEqual({})
  })
})
