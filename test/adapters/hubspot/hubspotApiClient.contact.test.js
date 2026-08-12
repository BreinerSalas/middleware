import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock({
  get = async () => ({ data: {} }),
  post = async () => ({ data: {} }),
  patch = async () => ({ data: {} })
} = {}) {
  return { get: vi.fn(get), patch: vi.fn(patch), post: vi.fn(post) }
}

function makeRateLimiter() {
  return { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
}

describe('hubspotApiClient - contact CRUD + batch upsert (partner-sync)', () => {
  describe('searchContactByProperty', () => {
    it('POSTs to /crm/v3/objects/contacts/search with a single EQ filter and limit 1', async () => {
      const post = vi.fn(async () => ({ data: { results: [], total: 0 } }))
      const http = makeHttpMock({ post })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      await api.searchContactByProperty('id_contacto_odoo', '42')
      const [url, body] = post.mock.calls[0]
      expect(url).toBe('/crm/v3/objects/contacts/search')
      expect(body).toEqual({
        filterGroups: [{ filters: [{ propertyName: 'id_contacto_odoo', operator: 'EQ', value: '42' }] }],
        properties: ['id_contacto_odoo', 'firstname', 'lastname', 'email'],
        limit: 1
      })
    })

    it('includes the given propertyName (not a hardcoded default) in the requested properties list', async () => {
      const post = vi.fn(async () => ({ data: { results: [], total: 0 } }))
      const http = makeHttpMock({ post })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      await api.searchContactByProperty('id_contacto_odoo_v2', '42')
      const [, body] = post.mock.calls[0]
      expect(body.properties).toContain('id_contacto_odoo_v2')
      expect(body.filterGroups[0].filters[0].propertyName).toBe('id_contacto_odoo_v2')
    })

    it('returns the first result when present', async () => {
      const found = { id: 'C-1', properties: { id_contacto_odoo: '42' } }
      const http = makeHttpMock({ post: async () => ({ data: { results: [found], total: 1 } }) })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      const r = await api.searchContactByProperty('id_contacto_odoo', '42')
      expect(r).toEqual(found)
    })

    it('returns null when the search returns no results', async () => {
      const http = makeHttpMock({ post: async () => ({ data: { results: [] } }) })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      expect(await api.searchContactByProperty('id_contacto_odoo', '999')).toBeNull()
    })

    it('returns null for an empty/missing value without hitting the wire', async () => {
      const http = makeHttpMock()
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      expect(await api.searchContactByProperty('id_contacto_odoo', '')).toBeNull()
      expect(await api.searchContactByProperty('id_contacto_odoo', null)).toBeNull()
      expect(http.post).not.toHaveBeenCalled()
    })

    it('takes a token from the rate limiter before the call', async () => {
      const takeSpy = vi.fn().mockResolvedValue(undefined)
      const http = makeHttpMock({ post: async () => ({ data: { results: [] } }) })
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http,
        rateLimiter: { take: takeSpy, pause: vi.fn() }
      })
      await api.searchContactByProperty('id_contacto_odoo', '1')
      expect(takeSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('createContact', () => {
    it('POSTs properties to /crm/v3/objects/contacts', async () => {
      const post = vi.fn(async () => ({ data: { id: 'C-1', properties: { email: 'a@b.com' } } }))
      const http = makeHttpMock({ post })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      const props = { id_contacto_odoo: '42', firstname: 'Ana', lastname: 'Pérez', email: 'a@b.com' }
      const r = await api.createContact(props)
      expect(http.post).toHaveBeenCalledWith('/crm/v3/objects/contacts', { properties: props })
      expect(r.id).toBe('C-1')
    })

    it('normalizes HubSpot error response (400) with httpStatus attached', async () => {
      const http = makeHttpMock({
        post: async () => {
          const err = new Error('Request failed with status code 400')
          err.response = { status: 400, data: { message: 'Property values were not valid' } }
          throw err
        }
      })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      try {
        await api.createContact({ id_contacto_odoo: '42' })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err.httpStatus).toBe(400)
        expect(err.message).toMatch(/Property values were not valid/)
      }
    })
  })

  describe('updateContact', () => {
    it('PATCHes properties to /crm/v3/objects/contacts/{id}', async () => {
      const patch = vi.fn(async () => ({ data: { id: 'C-1', properties: {} } }))
      const http = makeHttpMock({ patch })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      const props = { id_contacto_odoo: '42', firstname: 'Ana' }
      const r = await api.updateContact('C-1', props)
      expect(patch).toHaveBeenCalledWith('/crm/v3/objects/contacts/C-1', { properties: props })
      expect(r.id).toBe('C-1')
    })
  })

  describe('batchUpsertContacts', () => {
    it('POSTs inputs tagged with the default idProperty id_contacto_odoo', async () => {
      const post = vi.fn(async () => ({ data: { results: [], numErrors: 0 } }))
      const http = makeHttpMock({ post })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      await api.batchUpsertContacts({
        inputs: [
          { id: '42', properties: { firstname: 'Ana', lastname: 'Pérez' } },
          { id: '43', properties: { firstname: 'Beto', lastname: 'López' } }
        ]
      })
      const [url, body] = post.mock.calls[0]
      expect(url).toBe('/crm/v3/objects/contacts/batch/upsert')
      expect(body.inputs).toEqual([
        { id: '42', idProperty: 'id_contacto_odoo', properties: { firstname: 'Ana', lastname: 'Pérez' } },
        { id: '43', idProperty: 'id_contacto_odoo', properties: { firstname: 'Beto', lastname: 'López' } }
      ])
    })

    it('accepts a custom idProperty override propagated to each input', async () => {
      const post = vi.fn(async () => ({ data: { results: [] } }))
      const http = makeHttpMock({ post })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      await api.batchUpsertContacts({
        inputs: [{ id: 'P-1', properties: { firstname: 'X' } }],
        idProperty: 'external_id'
      })
      const [, body] = post.mock.calls[0]
      expect(body.inputs[0].idProperty).toBe('external_id')
    })

    it('returns the results array on success (mirrors batchUpsertProducts shape)', async () => {
      const data = {
        results: [
          { id: 'C-1', properties: { id_contacto_odoo: '42' } },
          { id: 'C-2', properties: { id_contacto_odoo: '43' } }
        ],
        numErrors: 0
      }
      const http = makeHttpMock({ post: async () => ({ data }) })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      const r = await api.batchUpsertContacts({
        inputs: data.results.map((x) => ({ id: x.properties.id_contacto_odoo, properties: {} }))
      })
      expect(r.results).toHaveLength(2)
      expect(r.results[0].id).toBe('C-1')
      expect(r.errors).toEqual([])
    })

    it('parses per-item errors when numErrors > 0', async () => {
      const http = makeHttpMock({
        post: async () => ({
          data: {
            results: [
              { id: 'C-1', properties: { id_contacto_odoo: '42' } },
              { status: 'error', message: 'invalid value', context: { id: ['43'] } }
            ],
            numErrors: 1
          }
        })
      })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      const r = await api.batchUpsertContacts({
        inputs: [
          { id: '42', properties: {} },
          { id: '43', properties: {} }
        ]
      })
      expect(r.results).toHaveLength(1)
      expect(r.results[0].id).toBe('C-1')
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toMatchObject({ id: '43', message: 'invalid value' })
    })

    it('throws on top-level error (no results)', async () => {
      const http = makeHttpMock({
        post: async () => {
          const err = new Error('Bad Request')
          err.response = { status: 400, data: { message: 'invalid idProperty' } }
          throw err
        }
      })
      const rl = makeRateLimiter()
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http, rateLimiter: rl
      })
      await expect(api.batchUpsertContacts({ inputs: [] })).rejects.toThrow()
    })

    it('takes a token from the rate limiter before the call', async () => {
      const takeSpy = vi.fn().mockResolvedValue(undefined)
      const http = makeHttpMock({ post: async () => ({ data: { results: [], numErrors: 0 } }) })
      const api = createHubspotApiClient({
        baseUrl: 'https://api.hubapi.com', accessToken: 'tok-1', httpClient: http,
        rateLimiter: { take: takeSpy, pause: vi.fn() }
      })
      await api.batchUpsertContacts({ inputs: [{ id: 'P-1', properties: {} }] })
      expect(takeSpy).toHaveBeenCalledTimes(1)
    })
  })
})
