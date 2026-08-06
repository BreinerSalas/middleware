import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  createHubspotApiClient,
  QUOTE_PROPERTIES
} = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock({ get = async () => ({ data: {} }), patch = async () => ({ data: {} }), post = async () => ({ data: { results: [] } }) } = {}) {
  return { get: vi.fn(get), patch: vi.fn(patch), post: vi.fn(post) }
}

describe('hubspotApiClient.quote', () => {
  describe('QUOTE_PROPERTIES', () => {
    it('includes the canonical hs_* identifiers', () => {
      expect(QUOTE_PROPERTIES).toContain('hs_status')
      expect(QUOTE_PROPERTIES).toContain('hs_title')
      expect(QUOTE_PROPERTIES).toContain('hs_currency')
      expect(QUOTE_PROPERTIES).toContain('hs_quote_amount')
    })

    it('includes the two configurable project properties by default', () => {
      expect(QUOTE_PROPERTIES).toContain('pais_de_destino')
      expect(QUOTE_PROPERTIES).toContain('id_presupuesto_odoo')
    })

    it('includes the MO number property (Fase 4 write-back)', () => {
      expect(QUOTE_PROPERTIES).toContain('numero_orden_fabricacion')
    })

    it('includes the sale.order state / invoice status properties (Fase 6 write-back)', () => {
      expect(QUOTE_PROPERTIES).toContain('estado_presupuesto_odoo')
      expect(QUOTE_PROPERTIES).toContain('estado_facturacion_odoo')
    })
  })

  describe('getQuote', () => {
    it('GETs /crm/v3/objects/quotes/:id with properties param', async () => {
      const get = vi.fn(async () => ({ data: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } } }))
      const http = makeHttpMock({ get })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const data = await api.getQuote('Q-1', ['hs_status'])
      expect(data.id).toBe('Q-1')
      expect(get).toHaveBeenCalledWith('/crm/v3/objects/quotes/Q-1', { params: { properties: 'hs_status' } })
    })

    it('omits the params arg when properties is empty', async () => {
      const get = vi.fn(async () => ({ data: { id: 'Q-1' } }))
      const http = makeHttpMock({ get })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      await api.getQuote('Q-1', [])
      expect(get).toHaveBeenCalledWith('/crm/v3/objects/quotes/Q-1', { params: undefined })
    })
  })

  describe('updateQuote', () => {
    it('PATCHes /crm/v3/objects/quotes/:id with the properties body', async () => {
      const patch = vi.fn(async () => ({ data: { id: 'Q-1', properties: { id_presupuesto_odoo: 'S06613' } } }))
      const http = makeHttpMock({ patch })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      await api.updateQuote('Q-1', { id_presupuesto_odoo: 'S06613' })
      expect(patch).toHaveBeenCalledWith('/crm/v3/objects/quotes/Q-1', { properties: { id_presupuesto_odoo: 'S06613' } })
    })
  })

  describe('getDealQuotes', () => {
    it('returns [] when the deal has no quote associations', async () => {
      const get = vi.fn(async () => ({ data: { results: [] } }))
      const http = makeHttpMock({ get })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const quotes = await api.getDealQuotes('D-1')
      expect(quotes).toEqual([])
      expect(http.post).not.toHaveBeenCalled()
    })

    it('fetches associations + batches reads in that order', async () => {
      const get = vi.fn(async (url) => {
        if (url.includes('/associations/quotes')) {
          return { data: { results: [{ id: 'Q-1' }, { id: 'Q-2' }] } }
        }
        throw new Error(`unexpected GET ${url}`)
      })
      const post = vi.fn(async () => ({
        data: {
          results: [
            { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', hs_title: 'GT' } },
            { id: 'Q-2', properties: { hs_status: 'APPROVAL_NOT_NEEDED', hs_title: 'HN' } }
          ]
        }
      }))
      const http = makeHttpMock({ get, post })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const quotes = await api.getDealQuotes('D-1', ['hs_status', 'hs_title'])
      expect(quotes).toHaveLength(2)
      expect(quotes[0].id).toBe('Q-1')
      expect(quotes[0].properties.hs_title).toBe('GT')
      const [postUrl, postBody] = post.mock.calls[0]
      expect(postUrl).toBe('/crm/v3/objects/quotes/batch/read')
      expect(postBody.inputs).toEqual([{ id: 'Q-1' }, { id: 'Q-2' }])
      expect(postBody.properties).toEqual(['hs_status', 'hs_title'])
    })

    it('passes QUOTE_PROPERTIES when none provided', async () => {
      const get = vi.fn(async () => ({ data: { results: [{ id: 'Q-1' }] } }))
      const post = vi.fn(async () => ({ data: { results: [{ id: 'Q-1', properties: { hs_status: 'DRAFT' } }] } }))
      const http = makeHttpMock({ get, post })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      await api.getDealQuotes('D-1')
      expect(post.mock.calls[0][1].properties).toEqual(QUOTE_PROPERTIES)
    })

    it('propagates errors from the associations call', async () => {
      const http = makeHttpMock({ get: vi.fn(async () => { throw new Error('boom') }) })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      await expect(api.getDealQuotes('D-1')).rejects.toThrow('boom')
    })
  })

  describe('getQuoteLineItems', () => {
    it('returns [] when quoteId is missing', async () => {
      const http = makeHttpMock()
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const items = await api.getQuoteLineItems(null)
      expect(items).toEqual([])
      expect(http.get).not.toHaveBeenCalled()
    })

    it('fetches quote line_item associations then batch reads', async () => {
      const get = vi.fn(async (url) => {
        if (url.includes('/objects/quotes/Q-1/associations/line_items')) {
          return { data: { results: [{ id: 'L-1' }, { id: 'L-2' }] } }
        }
        throw new Error(`unexpected GET ${url}`)
      })
      const post = vi.fn(async () => ({
        data: {
          results: [
            { id: 'L-1', properties: { hs_sku: 'SKU-1', quantity: '3', price: '7.50', name: 'Item A' } },
            { id: 'L-2', properties: { hs_sku: 'SKU-2', quantity: '1', price: '0', name: 'Item B' } }
          ]
        }
      }))
      const http = makeHttpMock({ get, post })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const items = await api.getQuoteLineItems('Q-1')
      expect(items).toEqual([
        { id: 'L-1', hs_sku: 'SKU-1', quantity: 3, price: 7.5, name: 'Item A' },
        { id: 'L-2', hs_sku: 'SKU-2', quantity: 1, price: 0, name: 'Item B' }
      ])
      expect(get.mock.calls[0][0]).toBe('/crm/v3/objects/quotes/Q-1/associations/line_items')
      expect(post.mock.calls[0][0]).toBe('/crm/v3/objects/line_items/batch/read')
    })

    it('returns [] when no line items are associated', async () => {
      const http = makeHttpMock({ get: vi.fn(async () => ({ data: { results: [] } })) })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const items = await api.getQuoteLineItems('Q-1')
      expect(items).toEqual([])
      expect(http.post).not.toHaveBeenCalled()
    })
  })

  describe('getDealLineItems regression (post-extraction)', () => {
    it('still hits /crm/v3/objects/deals/:id/associations/line_items', async () => {
      const get = vi.fn(async (url) => {
        if (url.includes('/objects/deals/D-1/associations/line_items')) {
          return { data: { results: [{ id: 'L-1' }] } }
        }
        throw new Error(`unexpected GET ${url}`)
      })
      const post = vi.fn(async () => ({ data: { results: [{ id: 'L-1', properties: { hs_sku: 'SKU-1', quantity: '1', price: '0', name: 'X' } }] } }))
      const http = makeHttpMock({ get, post })
      const api = createHubspotApiClient({ baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http })
      const items = await api.getDealLineItems('D-1')
      expect(items).toHaveLength(1)
      expect(get.mock.calls[0][0]).toBe('/crm/v3/objects/deals/D-1/associations/line_items')
    })
  })
})
