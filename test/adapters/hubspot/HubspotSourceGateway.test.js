import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotSourceGateway, resolvePreviousDealStage } = require('../../../src/adapters/outbound/hubspot/HubspotSourceGateway.js')

function makeApiClient({ get = async () => ({ id: 'D-1', properties: {} }), patch = async () => ({}), getDealLineItems = async () => [], getDealStageHistory = async () => [] } = {}) {
  return {
    getDeal: vi.fn(get),
    getDealAssociations: vi.fn(async () => ({ results: [{ toObjectId: 'C-1' }] })),
    getDealLineItems: vi.fn(getDealLineItems),
    updateDeal: vi.fn(patch),
    getDealStageHistory: vi.fn(getDealStageHistory)
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

  it('writeBack clears numero_orden_fabricacion (writes empty string) when the payload explicitly sends null (Fase 6 — cancelación)', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({
      apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', propertyManufacturingOrder: 'numero_orden_fabricacion'
    })
    await gw.writeBack('D-1', { numero_orden_fabricacion: null })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { numero_orden_fabricacion: '' })
  })

  it('writeBack omits numero_orden_fabricacion entirely when the key is absent (unchanged shape)', async () => {
    const api = makeApiClient({ patch: vi.fn(async () => ({})) })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order' })
    await gw.writeBack('D-1', { estado_presupuesto_odoo: 'sale' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { estado_presupuesto_odoo: 'sale' })
  })
})

describe('resolvePreviousDealStage (Fase 6 — retroceso de etapa por cancelación)', () => {
  it('returns the first history value different from the current stage', () => {
    const history = [{ value: 'closedwon' }, { value: 'negotiation' }, { value: 'presented' }]
    expect(resolvePreviousDealStage(history, 'closedwon')).toBe('negotiation')
  })

  it('returns null when there is no distinct previous value', () => {
    expect(resolvePreviousDealStage([{ value: 'closedwon' }], 'closedwon')).toBeNull()
    expect(resolvePreviousDealStage([], 'closedwon')).toBeNull()
  })
})

describe('HubspotSourceGateway.revertDealStage (Fase 6 — retroceso de etapa por cancelación)', () => {
  it('resolves dealId from sourceId, finds the previous distinct stage, and updates dealstage', async () => {
    const api = makeApiClient({
      getDealStageHistory: async () => [{ value: 'closedwon' }, { value: 'negotiation' }]
    })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', closedWonStageId: 'closedwon' })
    await gw.revertDealStage('D-1:qQ-1')
    expect(api.getDealStageHistory).toHaveBeenCalledWith('D-1')
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { dealstage: 'negotiation' })
  })

  it('does nothing (soft-fail) when there is no distinct previous stage', async () => {
    const api = makeApiClient({ getDealStageHistory: async () => [{ value: 'closedwon' }] })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', closedWonStageId: 'closedwon' })
    await gw.revertDealStage('D-1')
    expect(api.updateDeal).not.toHaveBeenCalled()
  })

  it('is guarded by echoGuard so a repeated call for the same target stage does not write again', async () => {
    const api = makeApiClient({ getDealStageHistory: async () => [{ value: 'closedwon' }, { value: 'negotiation' }] })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', closedWonStageId: 'closedwon' })
    await gw.revertDealStage('D-1')
    await gw.revertDealStage('D-1')
    expect(api.updateDeal).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: does nothing once the deal already moved away from closed-won (evita el ping-pong entre etapas en ticks repetidos)', async () => {
    const api = makeApiClient({ getDealStageHistory: async () => [{ value: 'negotiation' }, { value: 'closedwon' }] })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order', closedWonStageId: 'closedwon' })
    await gw.revertDealStage('D-1')
    expect(api.updateDeal).not.toHaveBeenCalled()
  })

  it('defaults closedWonStageId to the real Cierre Ganado stage id when not provided', async () => {
    const api = makeApiClient({ getDealStageHistory: async () => [{ value: '1409249445' }, { value: 'negotiation' }] })
    const gw = new HubspotSourceGateway({ apiClient: api, propertyOdooCustomerId: 'cust', propertyOdooOrderId: 'order' })
    await gw.revertDealStage('D-1')
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { dealstage: 'negotiation' })
  })
})
