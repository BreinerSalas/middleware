import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock({ post = async () => ({ data: {} }) } = {}) {
  return { get: vi.fn(), patch: vi.fn(), post: vi.fn(post) }
}

describe('hubspotApiClient - batchUpsertProducts', () => {
  it('defaults idProperty to id_producto_odoo (openspec/hubspot-product-odoo-id-key)', async () => {
    const post = vi.fn(async () => ({ data: { results: [], numErrors: 0 } }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await api.batchUpsertProducts({
      inputs: [
        { id: '42', properties: { name: 'Aceite', id_producto_odoo: '42' } },
        { id: '43', properties: { name: 'Filtro', id_producto_odoo: '43' } }
      ]
    })
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/crm/v3/objects/products/batch/upsert')
    expect(body.inputs).toEqual([
      { id: '42', idProperty: 'id_producto_odoo', properties: { name: 'Aceite', id_producto_odoo: '42' } },
      { id: '43', idProperty: 'id_producto_odoo', properties: { name: 'Filtro', id_producto_odoo: '43' } }
    ])
  })

  it('accepts a custom idProperty override propagated to each input', async () => {
    const post = vi.fn(async () => ({ data: { results: [] } }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await api.batchUpsertProducts({
      inputs: [{ id: 'P-1', properties: { name: 'X' } }],
      idProperty: 'external_id'
    })
    const [, body] = post.mock.calls[0]
    expect(body.inputs[0].idProperty).toBe('external_id')
  })

  it('returns the results array on success', async () => {
    const data = {
      results: [
        { id: 'P-1', properties: { hs_sku: 'AC-1170' }, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
        { id: 'P-2', properties: { hs_sku: 'AC-1171' }, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }
      ],
      numErrors: 0
    }
    const post = vi.fn(async () => ({ data }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    const r = await api.batchUpsertProducts({ inputs: data.results.map((x) => ({ id: x.properties.hs_sku, properties: {} })) })
    expect(r.results).toHaveLength(2)
    expect(r.results[0].id).toBe('P-1')
    expect(r.errors).toEqual([])
  })

  it('parses per-item errors when numErrors > 0', async () => {
    const post = vi.fn(async () => ({
      data: {
        results: [
          { id: 'P-1', properties: { hs_sku: 'AC-1170' } },
          { status: 'error', message: 'invalid value', context: { id: ['AC-1171'] } }
        ],
        numErrors: 1
      }
    }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    const r = await api.batchUpsertProducts({
      inputs: [
        { id: 'AC-1170', properties: {} },
        { id: 'AC-1171', properties: {} }
      ]
    })
    expect(r.results).toHaveLength(1)
    expect(r.results[0].id).toBe('P-1')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ id: 'AC-1171', message: 'invalid value' })
  })

  it('throws on top-level error (no results)', async () => {
    const post = vi.fn(async () => {
      const err = new Error('Bad Request')
      err.response = { status: 400, data: { message: 'invalid idProperty' } }
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
    await expect(api.batchUpsertProducts({ inputs: [] })).rejects.toThrow()
  })

  it('takes a token from the rate limiter before the call', async () => {
    const post = vi.fn(async () => ({ data: { results: [], numErrors: 0 } }))
    const http = makeHttpMock({ post })
    const takeSpy = vi.fn().mockResolvedValue(undefined)
    const rl = { take: takeSpy, pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await api.batchUpsertProducts({ inputs: [{ id: 'P-1', properties: {} }] })
    expect(takeSpy).toHaveBeenCalledTimes(1)
  })
})

// (openspec/hubspot-product-odoo-id-key, post-verify fix) HubSpot's real batch/upsert
// endpoint rejects any input missing idProperty ("Upserts in a single batch must specify
// its unique property using idProperty") — there is no idProperty:null variant. Writing
// onto a product by its already-known native HubSpot object id (the backfill's use case)
// requires the separate batch/update endpoint instead, which always matches by native id
// and never takes an idProperty.
describe('hubspotApiClient - batchUpdateProducts (native id, no idProperty)', () => {
  it('posts to /crm/v3/objects/products/batch/update with plain {id, properties} inputs', async () => {
    const post = vi.fn(async () => ({ data: { results: [], numErrors: 0 } }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await api.batchUpdateProducts({
      inputs: [{ id: '46671077999', properties: { id_producto_odoo: '42' } }]
    })
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/crm/v3/objects/products/batch/update')
    expect(body.inputs).toEqual([{ id: '46671077999', properties: { id_producto_odoo: '42' } }])
    expect('idProperty' in body.inputs[0]).toBe(false)
  })

  it('parses per-item errors the same way as batchUpsertProducts', async () => {
    const post = vi.fn(async () => ({
      data: {
        results: [{ id: 'P-1', properties: {} }],
        errors: [{ id: 'P-2', message: 'not found' }],
        numErrors: 1
      }
    }))
    const http = makeHttpMock({ post })
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    const r = await api.batchUpdateProducts({
      inputs: [{ id: 'P-1', properties: {} }, { id: 'P-2', properties: {} }]
    })
    expect(r.results).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ id: 'P-2', message: 'not found' })
  })

  it('throws on top-level error', async () => {
    const post = vi.fn(async () => {
      const err = new Error('Bad Request')
      err.response = { status: 400, data: { message: 'bad input' } }
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
    await expect(api.batchUpdateProducts({ inputs: [] })).rejects.toThrow()
  })
})
