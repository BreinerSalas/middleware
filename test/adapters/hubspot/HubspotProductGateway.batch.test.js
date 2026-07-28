import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotProductGateway } = require('../../../src/adapters/outbound/hubspot/HubspotProductGateway.js')

function makeApi({ batchUpsertProducts = async () => ({ results: [], errors: [], numErrors: 0 }) } = {}) {
  return {
    searchProductByHsSku: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    batchUpsertProducts: vi.fn(batchUpsertProducts)
  }
}

function product(id, sku, name = `P-${id}`, price = 10) {
  return { id, name, default_code: sku, list_price: price }
}

describe('HubspotProductGateway - batchUpsertBySkus', () => {
  it('splits input into 100-item chunks and calls apiClient.batchUpsertProducts per chunk', async () => {
    const calls = []
    const api = makeApi({
      batchUpsertProducts: vi.fn(async (args) => {
        calls.push(args.inputs.length)
        return { results: args.inputs.map((_, i) => ({ id: `P-${i}`, properties: { hs_sku: args.inputs[i].id } })), errors: [], numErrors: 0 }
      })
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const products = Array.from({ length: 250 }, (_, i) => product(i + 1, `SKU-${i + 1}`))
    const r = await gw.batchUpsertBySkus(products, { chunkSize: 100 })
    expect(calls).toEqual([100, 100, 50])
    expect(r.results).toHaveLength(250)
  })

  it('uses hs_sku as the idProperty by default', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => ({ results: [], errors: [], numErrors: 0 }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    await gw.batchUpsertBySkus([product(1, 'AC-1170', 'Aceite')])
    const [arg] = api.batchUpsertProducts.mock.calls[0]
    expect(arg.idProperty).toBe('hs_sku')
    expect(arg.inputs[0]).toEqual({
      id: 'AC-1170',
      properties: { name: 'Aceite', price: '10' }
    })
  })

  it('skips products without valid sku (default_code false / null / empty)', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([
      product(1, 'AC-1'),
      product(2, false),
      product(3, null),
      product(4, ''),
      product(5, 'AC-5')
    ])
    expect(api.batchUpsertProducts).toHaveBeenCalledTimes(1)
    const inputs = api.batchUpsertProducts.mock.calls[0][0].inputs
    expect(inputs).toHaveLength(2)
    expect(r.skipped).toEqual([2, 3, 4])
  })

  it('collects per-item errors from apiClient response into the result.errors array', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => ({
        results: [{ id: 'P-1', properties: { hs_sku: 'AC-1' } }],
        errors: [{ id: 'AC-2', message: 'invalid value', category: 'VALIDATION_ERROR' }],
        numErrors: 1
      }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([
      product(1, 'AC-1'),
      product(2, 'AC-2', 'BadProduct')
    ])
    expect(r.results).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ id: 'AC-2' })
  })

  it('returns empty results and no apiClient call when input is empty', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([])
    expect(api.batchUpsertProducts).not.toHaveBeenCalled()
    expect(r.results).toEqual([])
  })

  it('propagates errors from apiClient', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => { throw new Error('batch-boom') })
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    await expect(gw.batchUpsertBySkus([product(1, 'AC-1')])).rejects.toThrow('batch-boom')
  })
})
