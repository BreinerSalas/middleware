import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttp() {
  return { get: vi.fn(), patch: vi.fn(), post: vi.fn() }
}

describe('hubspotApiClient - custom properties + generic search', () => {
  it('ensureCustomProperty creates a property when GET returns 404', async () => {
    const http = makeHttp()
    let getCalls = 0
    http.get = vi.fn(async () => {
      getCalls += 1
      if (getCalls === 1) {
        const err = new Error('Not Found')
        err.response = { status: 404, data: { message: 'not found' } }
        throw err
      }
      return { data: { name: 'odoo_product_id' } }
    })
    http.post = vi.fn(async () => ({ data: { name: 'odoo_product_id' } }))
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 't', httpClient: http, rateLimiter: rl })
    const result = await api.ensureCustomProperty('products', 'odoo_product_id', { name: 'odoo_product_id', label: 'Odoo Product ID', type: 'number', fieldType: 'number', groupName: 'product_information' })
    expect(result.created).toBe(true)
    expect(http.post).toHaveBeenCalledWith('/crm/v3/properties/products', expect.objectContaining({ name: 'odoo_product_id' }))
  })

  it('ensureCustomProperty skips creation when property exists', async () => {
    const http = makeHttp()
    http.get = vi.fn(async () => ({ data: { name: 'odoo_product_id' } }))
    http.post = vi.fn(async () => { throw new Error('should not be called') })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 't', httpClient: http, rateLimiter: rl })
    const result = await api.ensureCustomProperty('products', 'odoo_product_id', { name: 'odoo_product_id' })
    expect(result.created).toBe(false)
    expect(http.post).not.toHaveBeenCalled()
  })

  it('searchProducts POSTs filterGroups to /crm/v3/objects/products/search', async () => {
    const post = vi.fn(async () => ({ data: { results: [], total: 0 } }))
    const http = makeHttp()
    http.post = post
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 't', httpClient: http, rateLimiter: rl })
    await api.searchProducts({ filterGroups: [{ filters: [{ propertyName: 'hs_sku', operator: 'NOT_HAS_PROPERTY' }] }], limit: 50 })
    expect(post).toHaveBeenCalledWith('/crm/v3/objects/products/search', expect.objectContaining({
      filterGroups: expect.any(Array),
      limit: 50
    }))
  })
})
