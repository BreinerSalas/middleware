import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock({ get = async () => ({ data: {} }), patch = async () => ({ data: {} }), post = async () => ({ data: { results: [] } }) } = {}) {
  return { get: vi.fn(get), patch: vi.fn(patch), post: vi.fn(post) }
}

describe('hubspotApiClient', () => {
  it('getDeal issues GET with properties param', async () => {
    const http = makeHttpMock({ get: vi.fn(async () => ({ data: { id: 'D-1', properties: { dealname: 'X' } } })) })
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
    const data = await api.getDeal('D-1', ['dealname'])
    expect(data.id).toBe('D-1')
    expect(http.get).toHaveBeenCalledWith('/crm/v3/objects/deals/D-1', { params: { properties: 'dealname' } })
  })

  it('updateDeal issues PATCH with body', async () => {
    const http = makeHttpMock({ patch: vi.fn(async () => ({ data: { id: 'D-1', properties: { id_orden_odoo: 'PO-1' } } })) })
    const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
    await api.updateDeal('D-1', { id_orden_odoo: 'PO-1' })
    expect(http.patch).toHaveBeenCalledWith('/crm/v3/objects/deals/D-1', { properties: { id_orden_odoo: 'PO-1' } })
  })

  describe('getDealLineItems', () => {
    it('returns [] when deal has no line_item associations', async () => {
      const http = makeHttpMock({ get: vi.fn(async () => ({ data: { results: [] } })) })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const items = await api.getDealLineItems('D-1')
      expect(items).toEqual([])
      expect(http.post).not.toHaveBeenCalled()
    })

    it('returns [] when dealId is missing', async () => {
      const http = makeHttpMock()
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const items = await api.getDealLineItems(null)
      expect(items).toEqual([])
      expect(http.get).not.toHaveBeenCalled()
    })

    it('fetches association IDs then performs a single batch read', async () => {
      const http = makeHttpMock({
        get: vi.fn(async (url) => {
          if (url.includes('/associations/line_items')) {
            return { data: { results: [{ id: 'L-1' }, { id: 'L-2' }, { toObjectId: 'L-3' }] } }
          }
          throw new Error(`unexpected GET ${url}`)
        }),
        post: vi.fn(async () => ({
          data: {
            results: [
              { id: 'L-1', properties: { hs_sku: 'SKU-1', quantity: '2', price: '9.99', name: 'Item 1' } },
              { id: 'L-2', properties: { hs_sku: 'SKU-2', quantity: '5', price: '4.50', name: 'Item 2' } },
              { id: 'L-3', properties: { hs_sku: 'SKU-3', quantity: '1', price: '0', name: 'Item 3' } }
            ]
          }
        }))
      })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const items = await api.getDealLineItems('D-1')
      expect(items).toHaveLength(3)
      expect(items[0]).toEqual({ id: 'L-1', hs_sku: 'SKU-1', quantity: 2, price: 9.99, name: 'Item 1' })
      expect(items[2]).toEqual({ id: 'L-3', hs_sku: 'SKU-3', quantity: 1, price: 0, name: 'Item 3' })
      expect(http.post).toHaveBeenCalledTimes(1)
      const [postUrl, postBody] = http.post.mock.calls[0]
      expect(postUrl).toBe('/crm/v3/objects/line_items/batch/read')
      expect(postBody.inputs).toEqual([{ id: 'L-1' }, { id: 'L-2' }, { id: 'L-3' }])
      expect(postBody.properties).toContain('hs_sku')
      expect(postBody.properties).toContain('quantity')
    })

    it('propagates errors from associations call', async () => {
      const http = makeHttpMock({ get: vi.fn(async () => { throw new Error('boom') }) })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      await expect(api.getDealLineItems('D-1')).rejects.toThrow('boom')
    })

    it('propagates errors from batch call', async () => {
      const http = makeHttpMock({
        get: vi.fn(async () => ({ data: { results: [{ id: 'L-1' }] } })),
        post: vi.fn(async () => { throw new Error('batch-boom') })
      })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      await expect(api.getDealLineItems('D-1')).rejects.toThrow('batch-boom')
    })
  })
})
