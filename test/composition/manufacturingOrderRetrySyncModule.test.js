import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createManufacturingOrderRetrySyncModule } = require('../../src/composition/manufacturingOrderRetrySyncModule.js')

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function mapping(overrides = {}) {
  return { sourceId: 'D-1:qQ-1', targetId: '501', targetRef: 'S00501', payloadHash: 'h', metadata: {}, ...overrides }
}

function makeMappingRepository({ pending = [] } = {}) {
  return {
    findPendingManufacturingOrder: vi.fn(async () => pending),
    upsert: vi.fn(async () => null)
  }
}

function makeOdooApiClient({ mo = null } = {}) {
  return { findManufacturingOrderBySaleOrderName: vi.fn(async () => mo) }
}

function makeHubspotGateway() {
  return { writeBack: vi.fn(async () => null) }
}

describe('manufacturingOrderRetrySyncModule.runOnce (Fase 6 — brecha de MO tardía)', () => {
  it('requires mappingRepository, odooApiClient and hubspotGateway', () => {
    expect(() => createManufacturingOrderRetrySyncModule({})).toThrow(/mappingRepository/)
    expect(() => createManufacturingOrderRetrySyncModule({ mappingRepository: makeMappingRepository() })).toThrow(/odooApiClient/)
    expect(() => createManufacturingOrderRetrySyncModule({
      mappingRepository: makeMappingRepository(), odooApiClient: makeOdooApiClient()
    })).toThrow(/hubspotGateway/)
  })

  it('writes the MO number back and persists it on the mapping when the MO now exists', async () => {
    const mappingRepository = makeMappingRepository({ pending: [mapping()] })
    const odooApiClient = makeOdooApiClient({ mo: { id: 9471, name: 'BPT/MO/09471' } })
    const hubspotGateway = makeHubspotGateway()
    const m = createManufacturingOrderRetrySyncModule({ mappingRepository, odooApiClient, hubspotGateway, logger: makeLogger() })
    const out = await m.runOnce({})
    expect(odooApiClient.findManufacturingOrderBySaleOrderName).toHaveBeenCalledWith('S00501')
    expect(hubspotGateway.writeBack).toHaveBeenCalledWith('D-1:qQ-1', { numero_orden_fabricacion: 'BPT/MO/09471' })
    expect(mappingRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'D-1:qQ-1', metadata: { manufacturingOrder: { id: 9471, name: 'BPT/MO/09471' } }
    }))
    expect(out).toEqual({ found: 1, stillPending: 0, failed: 0 })
  })

  it('counts as stillPending and does not write back when the MO does not exist yet', async () => {
    const mappingRepository = makeMappingRepository({ pending: [mapping()] })
    const odooApiClient = makeOdooApiClient({ mo: null })
    const hubspotGateway = makeHubspotGateway()
    const m = createManufacturingOrderRetrySyncModule({ mappingRepository, odooApiClient, hubspotGateway, logger: makeLogger() })
    const out = await m.runOnce({})
    expect(hubspotGateway.writeBack).not.toHaveBeenCalled()
    expect(mappingRepository.upsert).not.toHaveBeenCalled()
    expect(out).toEqual({ found: 0, stillPending: 1, failed: 0 })
  })

  it('counts as failed and continues with the next mapping when one lookup throws', async () => {
    const mappingRepository = makeMappingRepository({
      pending: [mapping({ sourceId: 'D-1:qQ-1', targetRef: 'S00501' }), mapping({ sourceId: 'D-2:qQ-2', targetRef: 'S00502' })]
    })
    const odooApiClient = {
      findManufacturingOrderBySaleOrderName: vi.fn(async (name) => {
        if (name === 'S00501') throw new Error('odoo unreachable')
        return { id: 2, name: 'WH/MO/00002' }
      })
    }
    const hubspotGateway = makeHubspotGateway()
    const m = createManufacturingOrderRetrySyncModule({ mappingRepository, odooApiClient, hubspotGateway, logger: makeLogger() })
    const out = await m.runOnce({})
    expect(out).toEqual({ found: 1, stillPending: 0, failed: 1 })
    expect(hubspotGateway.writeBack).toHaveBeenCalledWith('D-2:qQ-2', { numero_orden_fabricacion: 'WH/MO/00002' })
  })

  it('passes the limit option through to findPendingManufacturingOrder', async () => {
    const mappingRepository = makeMappingRepository({ pending: [] })
    const m = createManufacturingOrderRetrySyncModule({
      mappingRepository, odooApiClient: makeOdooApiClient(), hubspotGateway: makeHubspotGateway(), logger: makeLogger()
    })
    await m.runOnce({ limit: 25 })
    expect(mappingRepository.findPendingManufacturingOrder).toHaveBeenCalledWith({ limit: 25 })
  })
})
