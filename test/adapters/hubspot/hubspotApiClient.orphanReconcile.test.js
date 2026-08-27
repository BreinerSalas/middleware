import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock({ post = async () => ({ data: {} }) } = {}) {
  return { get: vi.fn(), patch: vi.fn(), post: vi.fn(post) }
}

// (sdd/hubspot-product-reverse-discovery, design D2) Track B archives a duplicate HubSpot
// product via the batch/archive endpoint, which is a soft-delete (restorable in HubSpot's
// recycle bin) and returns an empty 204 body on success — treat that as success, not a
// missing-data error.
describe('hubspotApiClient - batchArchiveProducts (Track B soft-delete)', () => {
  it('posts to /crm/v3/objects/products/batch/archive with the given inputs', async () => {
    const post = vi.fn(async () => ({ data: '' }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await api.batchArchiveProducts({ inputs: [{ id: 'P-1' }] })
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/crm/v3/objects/products/batch/archive')
    expect(body).toEqual({ inputs: [{ id: 'P-1' }] })
  })

  it('treats an empty 204 response body as success and reports the archived count', async () => {
    const post = vi.fn(async () => ({ data: '' }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    const r = await api.batchArchiveProducts({ inputs: [{ id: 'P-1' }, { id: 'P-2' }] })
    expect(r).toEqual({ archived: 2, errors: [] })
  })

  it('reports zero archived and no errors for an empty inputs array without issuing a call', async () => {
    const post = vi.fn(async () => ({ data: '' }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    const r = await api.batchArchiveProducts({ inputs: [] })
    expect(r).toEqual({ archived: 0, errors: [] })
    expect(post).not.toHaveBeenCalled()
  })

  it('parses a response-carried errors array when HubSpot reports partial failures', async () => {
    const post = vi.fn(async () => ({
      data: { errors: [{ id: 'P-2', message: 'not found', category: 'OBJECT_NOT_FOUND' }] }
    }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    const r = await api.batchArchiveProducts({ inputs: [{ id: 'P-1' }, { id: 'P-2' }] })
    expect(r.archived).toBe(1)
    expect(r.errors).toEqual([{ id: 'P-2', message: 'not found', category: 'OBJECT_NOT_FOUND' }])
  })

  it('throws on top-level error (e.g. validation failure across the whole batch)', async () => {
    const post = vi.fn(async () => {
      const err = new Error('Bad Request')
      err.response = { status: 400, data: { message: 'invalid id' } }
      throw err
    })
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await expect(api.batchArchiveProducts({ inputs: [{ id: 'P-1' }] })).rejects.toThrow()
  })
})

// (sdd/hubspot-product-reverse-discovery, design D3) Track B's referenced-orphan exception:
// an orphan already used on a deal/quote line item must never be archived, only quarantined.
// `total` from a bounded (limit:1) search is enough to decide referenced vs unreferenced.
describe('hubspotApiClient - searchLineItemsByProductId (Track B referenced-orphan check)', () => {
  it('posts a filter on hs_product_id EQ with limit:1', async () => {
    const post = vi.fn(async () => ({ data: { total: 0, results: [] } }))
    const http = makeHttpMock({ post })
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
    await api.searchLineItemsByProductId('P-1')
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/crm/v3/objects/line_items/search')
    expect(body).toEqual({
      filterGroups: [{ filters: [{ propertyName: 'hs_product_id', operator: 'EQ', value: 'P-1' }] }],
      limit: 1
    })
  })

  it('returns total and results when the product is referenced', async () => {
    const post = vi.fn(async () => ({
      data: { total: 3, results: [{ id: 'L-1', properties: { hs_product_id: 'P-1' } }] }
    }))
    const http = makeHttpMock({ post })
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
    const r = await api.searchLineItemsByProductId('P-1')
    expect(r).toEqual({ total: 3, results: [{ id: 'L-1', properties: { hs_product_id: 'P-1' } }] })
  })

  it('returns total 0 and empty results when the product is unreferenced', async () => {
    const post = vi.fn(async () => ({ data: { total: 0, results: [] } }))
    const http = makeHttpMock({ post })
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
    const r = await api.searchLineItemsByProductId('P-999')
    expect(r).toEqual({ total: 0, results: [] })
  })

  it('propagates errors', async () => {
    const http = makeHttpMock({ post: vi.fn(async () => { throw new Error('search-down') }) })
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
    await expect(api.searchLineItemsByProductId('P-1')).rejects.toThrow('search-down')
  })
})
