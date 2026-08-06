import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createSaleOrderStatusSyncModule } = require('../../src/composition/saleOrderStatusSyncModule.js')

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeSource({ pages = [] } = {}) {
  return {
    listChangedSince: vi.fn(async function * (opts) {
      for (const page of pages) yield page
    })
  }
}

function makeMappingRepository({ bySourceRef = {} } = {}) {
  return {
    findByTargetId: vi.fn(async (targetId) => bySourceRef[targetId] || null)
  }
}

function makeHubspotGateway() {
  return { writeBack: vi.fn(async () => null), revertDealStage: vi.fn(async () => null) }
}

function makeCursorRepo({ watermark = null } = {}) {
  return {
    get: vi.fn(async () => watermark),
    set: vi.fn(async () => null)
  }
}

function so(id, state, invoiceStatus, writeDate) {
  return { id, name: `S${id}`, state, invoice_status: invoiceStatus, write_date: writeDate }
}

describe('saleOrderStatusSyncModule.runIncremental (Fase 6 — docs/plan-cambios-2026-08-05.md)', () => {
  it('requires cursorRepo', async () => {
    const odooSource = makeSource({ pages: [] })
    const m = createSaleOrderStatusSyncModule({
      odooSource, mappingRepository: makeMappingRepository(), hubspotGateway: makeHubspotGateway(), logger: makeLogger()
    })
    await expect(m.runIncremental({})).rejects.toThrow(/cursorRepo/)
  })

  it('writes estado_presupuesto_odoo/estado_facturacion_odoo when a mapping exists for the changed sale.order', async () => {
    const odooSource = makeSource({ pages: [[so(501, 'sale', 'invoiced', '2026-08-06 09:00:00')]] })
    const mappingRepository = makeMappingRepository({ bySourceRef: { 501: { sourceId: 'D-1:qQ-1', targetId: '501' } } })
    const hubspotGateway = makeHubspotGateway()
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(mappingRepository.findByTargetId).toHaveBeenCalledWith('501')
    expect(hubspotGateway.writeBack).toHaveBeenCalledWith('D-1:qQ-1', {
      estado_presupuesto_odoo: 'sale', estado_facturacion_odoo: 'invoiced'
    })
    expect(out.updated).toBe(1)
    expect(out.unmapped).toBe(0)
  })

  it('counts as unmapped and does not call writeBack when no mapping exists', async () => {
    const odooSource = makeSource({ pages: [[so(999, 'sale', 'invoiced', '2026-08-06 09:00:00')]] })
    const mappingRepository = makeMappingRepository({ bySourceRef: {} })
    const hubspotGateway = makeHubspotGateway()
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(hubspotGateway.writeBack).not.toHaveBeenCalled()
    expect(out.unmapped).toBe(1)
    expect(out.updated).toBe(0)
  })

  it('advances the cursor to (max write_date seen - overlapMs) when there are zero failures', async () => {
    const odooSource = makeSource({
      pages: [[so(1, 'sale', 'invoiced', '2026-08-06 09:00:00'), so(2, 'done', 'invoiced', '2026-08-06 09:05:00')]]
    })
    const mappingRepository = makeMappingRepository({ bySourceRef: { 1: { sourceId: 'D-1' }, 2: { sourceId: 'D-2' } } })
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway: makeHubspotGateway(), cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({ overlapMs: 60_000 })
    expect(out.cursorAdvanced).toBe(true)
    expect(cursorRepo.set).toHaveBeenCalledWith('sale-order-status-sync', '2026-08-06 09:04:00')
  })

  it('does NOT advance the cursor when any item failed transiently', async () => {
    const odooSource = makeSource({ pages: [[so(1, 'sale', 'invoiced', '2026-08-06 09:00:00')]] })
    const mappingRepository = makeMappingRepository({ bySourceRef: { 1: { sourceId: 'D-1' } } })
    const hubspotGateway = { writeBack: vi.fn(async () => { throw new Error('boom') }) }
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(out.failed).toBe(1)
    expect(out.cursorAdvanced).toBe(false)
    expect(cursorRepo.set).not.toHaveBeenCalled()
  })

  it('does NOT count a permanent failure (e.g. deleted HubSpot record) toward failed, and still advances the cursor', async () => {
    const odooSource = makeSource({ pages: [[so(1, 'sale', 'invoiced', '2026-08-06 09:00:00')]] })
    const mappingRepository = makeMappingRepository({ bySourceRef: { 1: { sourceId: 'D-1' } } })
    const notFound = new Error('resource not found')
    notFound.httpStatus = 404
    const hubspotGateway = { writeBack: vi.fn(async () => { throw notFound }) }
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({ overlapMs: 60_000 })
    expect(out.failed).toBe(0)
    expect(out.permanentlyFailed).toBe(1)
    expect(out.cursorAdvanced).toBe(true)
    expect(cursorRepo.set).toHaveBeenCalledWith('sale-order-status-sync', '2026-08-06 08:59:00')
  })

  it('calls revertDealStage when the sale.order was cancelled (Fase 6)', async () => {
    const odooSource = makeSource({ pages: [[so(501, 'cancel', 'no', '2026-08-06 09:00:00')]] })
    const mappingRepository = makeMappingRepository({ bySourceRef: { 501: { sourceId: 'D-1:qQ-1', targetId: '501' } } })
    const hubspotGateway = makeHubspotGateway()
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(hubspotGateway.revertDealStage).toHaveBeenCalledWith('D-1:qQ-1')
  })

  it('does NOT call revertDealStage for states other than cancel', async () => {
    const odooSource = makeSource({ pages: [[so(501, 'sale', 'invoiced', '2026-08-06 09:00:00')]] })
    const mappingRepository = makeMappingRepository({ bySourceRef: { 501: { sourceId: 'D-1' } } })
    const hubspotGateway = makeHubspotGateway()
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(hubspotGateway.revertDealStage).not.toHaveBeenCalled()
  })

  it('passes the existing cursor watermark through to listChangedSince', async () => {
    const odooSource = makeSource({ pages: [] })
    const cursorRepo = makeCursorRepo({ watermark: '2026-08-05 09:00:00' })
    const m = createSaleOrderStatusSyncModule({
      odooSource, mappingRepository: makeMappingRepository(), hubspotGateway: makeHubspotGateway(), cursorRepo, logger: makeLogger()
    })
    await m.runIncremental({})
    expect(odooSource.listChangedSince).toHaveBeenCalledWith({ writeDateGte: '2026-08-05 09:00:00' })
  })
})
