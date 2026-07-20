import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotSourceGateway } = require('../../../src/adapters/outbound/hubspot/HubspotSourceGateway.js')

function makeApiClient({ get = async () => ({ id: 'D-1', properties: {} }), patch = async () => ({}) } = {}) {
  return { getDeal: vi.fn(get), getDealAssociations: vi.fn(async () => ({ results: [{ toObjectId: 'C-1' }] })), updateDeal: vi.fn(patch) }
}

describe('HubspotSourceGateway', () => {
  it('fetchRecord returns id+properties', async () => {
    const api = makeApiClient({ get: async () => ({ id: 'D-1', properties: { dealname: 'X' } }) })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'id_cliente_odoo', propertyOdooOrderId: 'id_orden_odoo' })
    const rec = await gw.fetchRecord('D-1')
    expect(rec.id).toBe('D-1')
    expect(rec.properties.dealname).toBe('X')
    expect(api.getDeal).toHaveBeenCalledWith('D-1', expect.any(Array))
  })

  it('resolveReferences returns associations', async () => {
    const api = makeApiClient()
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' })
    const refs = await gw.resolveReferences({ id: 'D-1', properties: {} })
    expect(refs.associations).toEqual([{ toObjectId: 'C-1' }])
  })

  it('writeBack maps properties to HS property names', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order' })
    await gw.writeBack('D-1', { id_orden_odoo: 'PO-1' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { order: 'PO-1' })
  })

  it('writeBack does nothing when payload has no mappable properties', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order' })
    await gw.writeBack('D-1', {})
    expect(api.updateDeal).not.toHaveBeenCalled()
  })

  it('writeBack is suppressed by echo guard on identical second call', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const { createEchoGuard } = require('../../../src/core/shared/echoGuard.js')
    const echo = createEchoGuard({ ttlMs: 5000 })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', echoGuard: echo })
    await gw.writeBack('D-1', { id_orden_odoo: 'PO-1' })
    await gw.writeBack('D-1', { id_orden_odoo: 'PO-1' })
    expect(api.updateDeal).toHaveBeenCalledTimes(1)
  })
})
