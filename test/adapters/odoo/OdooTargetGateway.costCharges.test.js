import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooTargetGateway } = require('../../../src/adapters/outbound/odoo/OdooTargetGateway.js')
const { hashPayload } = require('../../../src/core/shared/hash.js')

const CHARGES = {
  extraCharges: 33, scannerCharge: 46, destinationProcess: 200, documentsShipping: 40,
  transferCost: 35, receivedTransfer: 55, financing: 0.085, ivaRate: 0.13, insuranceRate: 0.01, daiRate: 0.05
}

function makeApi({ partnerCountry = { 42: { countryId: 49, countryName: 'Colombia', parentId: null } }, extraRecords = [] } = {}) {
  return {
    searchSalesOrderByOrigin: vi.fn(async () => []),
    createSalesOrder: vi.fn(async () => ({ id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} })),
    updateSalesOrder: vi.fn(),
    readPartnerCountries: vi.fn(async (ids) => {
      const map = {}
      for (const id of ids) if (partnerCountry[id]) map[id] = partnerCountry[id]
      return map
    }),
    listOperationCosts: vi.fn(async () => [
      { id: 78, name: 'DDP Colombia', countryId: 49, countryName: 'Colombia', productId: null, charges: CHARGES },
      ...extraRecords
    ]),
    searchProductIdsByDefaultCodes: vi.fn(async () => ({ 'SKU-1': 17 }))
  }
}

const input = {
  existingTargetId: null,
  record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
  references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
}

describe('OdooTargetGateway cost charges in metadata', () => {
  it('carries the resolved charges in metadata.costCharges without touching countryExpense', async () => {
    const gw = new OdooTargetGateway({ apiClient: makeApi(), hashPayload })
    const result = await gw.upsert(input)
    expect(result.metadata.costCharges).toEqual(CHARGES)
    expect(result.metadata.countryExpense).not.toHaveProperty('charges')
  })

  it('sets metadata.costCharges to null when the country expense is unresolved', async () => {
    const api = makeApi({ partnerCountry: { 42: { countryId: null, countryName: null, parentId: null } } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert(input)
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.costCharges).toBeNull()
  })

  it('does not change the sale-order payload or the payloadHash', async () => {
    const api = makeApi()
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert(input)
    const sentPayload = api.createSalesOrder.mock.calls[0][0]
    expect(JSON.stringify(sentPayload)).not.toContain('costCharges')
    expect(JSON.stringify(sentPayload)).not.toContain('cargos_extra')
    // payloadHash only covers { saleOrder }, never metadata
    const again = await new OdooTargetGateway({ apiClient: makeApi(), hashPayload }).upsert(input)
    expect(result.payloadHash).toBe(again.payloadHash)
    expect(typeof result.payloadHash).toBe('string')
  })
})
