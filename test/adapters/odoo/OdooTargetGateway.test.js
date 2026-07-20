import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooTargetGateway } = require('../../../src/adapters/outbound/odoo/OdooTargetGateway.js')
const { hashPayload } = require('../../../src/core/shared/hash.js')

describe('OdooTargetGateway', () => {
  it('upsert creates when existingTargetId is null', async () => {
    const api = {
      createManufacturingOrder: vi.fn(async () => ({ id: 'NEW-1', ref: 'R1', state: 'draft', raw: {} })),
      updateManufacturingOrder: vi.fn(async () => ({ id: 'X', state: 'confirmed', raw: {} }))
    }
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: {} },
      references: { odooCustomerId: '42', lineItems: [] }
    })
    expect(api.createManufacturingOrder).toHaveBeenCalledTimes(1)
    expect(api.updateManufacturingOrder).not.toHaveBeenCalled()
    expect(result.targetId).toBe('NEW-1')
  })

  it('upsert updates when existingTargetId provided', async () => {
    const api = {
      createManufacturingOrder: vi.fn(async () => ({ id: 'NEW-1', state: 'draft', raw: {} })),
      updateManufacturingOrder: vi.fn(async () => ({ id: 'PO-1', state: 'confirmed', raw: {} }))
    }
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: 'PO-1',
      record: { id: 'D-1', properties: {} },
      references: { odooCustomerId: '42', lineItems: [] }
    })
    expect(api.updateManufacturingOrder).toHaveBeenCalledWith('PO-1', expect.any(Object))
    expect(result.targetId).toBe('PO-1')
  })

  it('throws transient error when odooCustomerId missing', async () => {
    const api = { createManufacturingOrder: vi.fn(), updateManufacturingOrder: vi.fn() }
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({ existingTargetId: null, record: { id: 'D-1', properties: {} }, references: {} })).rejects.toMatchObject({ transient: true, code: 'MISSING_ODOO_CUSTOMER_ID' })
  })

  it('propagates non-transient errors from api', async () => {
    const api = {
      createManufacturingOrder: vi.fn(async () => { const e = new Error('boom'); e.httpStatus = 500; throw e })
    }
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({ existingTargetId: null, record: { id: 'D-1', properties: {} }, references: { odooCustomerId: '42' } })).rejects.toThrow(/boom/)
  })
})
