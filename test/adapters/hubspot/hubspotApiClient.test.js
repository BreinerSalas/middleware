import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock({ get = async () => ({ data: {} }), patch = async () => ({ data: {} }) } = {}) {
  return { get: vi.fn(get), patch: vi.fn(patch) }
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
})
