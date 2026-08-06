import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotSourceGateway } = require('../../../src/adapters/outbound/hubspot/HubspotSourceGateway.js')

function makeApiClient({ get = async () => ({ id: 'D-1', properties: {} }), patch = async () => ({}), getDealLineItems = async () => [] } = {}) {
  return {
    getDeal: vi.fn(get),
    getDealAssociations: vi.fn(async () => ({ results: [{ toObjectId: 'C-1' }] })),
    getDealLineItems: vi.fn(getDealLineItems),
    updateDeal: vi.fn(patch)
  }
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

  it('resolveReferences populates lineItems from getDealLineItems', async () => {
    const api = makeApiClient({ getDealLineItems: async () => [{ id: 'L-1', hs_sku: 'SKU-1', quantity: 2, price: 9.99, name: 'Item 1' }] })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' })
    const refs = await gw.resolveReferences({ id: 'D-1', properties: {} })
    expect(api.getDealLineItems).toHaveBeenCalledWith('D-1')
    expect(refs.lineItems).toEqual([{ id: 'L-1', hs_sku: 'SKU-1', quantity: 2, price: 9.99, name: 'Item 1' }])
  })

  it('resolveReferences keeps associations populated when getDealLineItems fails', async () => {
    const api = makeApiClient({ getDealLineItems: async () => { throw new Error('hubspot-500') } })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' })
    const refs = await gw.resolveReferences({ id: 'D-1', properties: {} })
    expect(refs.associations).toEqual([{ toObjectId: 'C-1' }])
    expect(refs.lineItems).toEqual([])
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

  it('writeBack writes id_presupuesto_odoo to the configured quote property', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({
      apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', propertyOdooQuoteId: 'id_presupuesto_odoo'
    })
    await gw.writeBack('D-1', { id_presupuesto_odoo: 'S06613' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { id_presupuesto_odoo: 'S06613' })
  })

  it('fetchRecord requests the configured quote property', async () => {
    const api = makeApiClient()
    const gw = new HubspotSourceGateway({
      apiClient: api, propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b', propertyOdooQuoteId: 'c'
    })
    await gw.fetchRecord('D-1')
    expect(api.getDeal).toHaveBeenCalledWith('D-1', expect.arrayContaining(['c']))
  })

  it('defaults propertyOdooQuoteId to id_presupuesto_odoo when not provided', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order' })
    await gw.writeBack('D-1', { id_presupuesto_odoo: 'S06613' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { id_presupuesto_odoo: 'S06613' })
  })

  it('writeBack writes numero_orden_fabricacion to the configured MO property (Fase 4)', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({
      apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', propertyManufacturingOrder: 'numero_orden_fabricacion'
    })
    await gw.writeBack('D-1', { numero_orden_fabricacion: 'WH/MO/00042' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { numero_orden_fabricacion: 'WH/MO/00042' })
  })

  it('defaults propertyManufacturingOrder to numero_orden_fabricacion when not provided', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order' })
    await gw.writeBack('D-1', { numero_orden_fabricacion: 'WH/MO/00042' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { numero_orden_fabricacion: 'WH/MO/00042' })
  })

  it('writeBack writes estado_presupuesto_odoo and estado_facturacion_odoo to the configured properties (Fase 6)', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({
      apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order',
      propertyQuoteState: 'estado_presupuesto_odoo', propertyQuoteInvoiceStatus: 'estado_facturacion_odoo'
    })
    await gw.writeBack('D-1', { estado_presupuesto_odoo: 'cancel', estado_facturacion_odoo: 'no' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { estado_presupuesto_odoo: 'cancel', estado_facturacion_odoo: 'no' })
  })

  it('defaults propertyQuoteState/propertyQuoteInvoiceStatus when not provided (Fase 6)', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order' })
    await gw.writeBack('D-1', { estado_presupuesto_odoo: 'cancel', estado_facturacion_odoo: 'no' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { estado_presupuesto_odoo: 'cancel', estado_facturacion_odoo: 'no' })
  })
})
