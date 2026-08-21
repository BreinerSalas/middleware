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
    findByTargetId: vi.fn(async (targetId) => bySourceRef[targetId] || null),
    upsert: vi.fn(async (mapping) => {
      const existing = bySourceRef[mapping.targetId] || {}
      bySourceRef[mapping.targetId] = {
        ...existing,
        ...mapping,
        metadata: { ...(existing.metadata || {}), ...(mapping.metadata || {}) }
      }
      return bySourceRef[mapping.targetId]
    })
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

  it('clears numero_orden_fabricacion in the same writeBack when the sale.order was cancelled (evita dejar el número de la MO vieja/inválida)', async () => {
    const odooSource = makeSource({ pages: [[so(501, 'cancel', 'no', '2026-08-06 09:00:00')]] })
    const mappingRepository = makeMappingRepository({ bySourceRef: { 501: { sourceId: 'D-1:qQ-1', targetId: '501' } } })
    const hubspotGateway = makeHubspotGateway()
    const cursorRepo = makeCursorRepo()
    const m = createSaleOrderStatusSyncModule({ odooSource, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(hubspotGateway.writeBack).toHaveBeenCalledWith('D-1:qQ-1', {
      estado_presupuesto_odoo: 'cancel', estado_facturacion_odoo: 'no', numero_orden_fabricacion: null
    })
  })

  it('does NOT call revertDealStage again for the same cancelled sale.order on a later run (evita deshacer una corrección manual hecha dentro de la ventana de overlap)', async () => {
    const bySourceRef = { 501: { sourceId: 'D-1:qQ-1', targetId: '501' } }
    const mappingRepository = makeMappingRepository({ bySourceRef })
    const hubspotGateway = makeHubspotGateway()
    const cursorRepo = makeCursorRepo()

    const odooSourceRun1 = makeSource({ pages: [[so(501, 'cancel', 'no', '2026-08-06 09:00:00')]] })
    const m1 = createSaleOrderStatusSyncModule({ odooSource: odooSourceRun1, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    await m1.runIncremental({})
    expect(hubspotGateway.revertDealStage).toHaveBeenCalledTimes(1)

    // Segundo tick: el overlap vuelve a traer la misma fila (write_date sin cambios)
    // porque el pedido sigue cancelado en Odoo — el usuario ya corrigió y volvió a
    // pasar el deal a Ganado en el medio, y esto no debe revertirlo de nuevo.
    const odooSourceRun2 = makeSource({ pages: [[so(501, 'cancel', 'no', '2026-08-06 09:00:00')]] })
    const m2 = createSaleOrderStatusSyncModule({ odooSource: odooSourceRun2, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    await m2.runIncremental({})
    expect(hubspotGateway.revertDealStage).toHaveBeenCalledTimes(1)
  })

  it('calls revertDealStage again if the sale.order is cancelled a second time with a new write_date (nueva cancelación legítima)', async () => {
    const bySourceRef = { 501: { sourceId: 'D-1:qQ-1', targetId: '501' } }
    const mappingRepository = makeMappingRepository({ bySourceRef })
    const hubspotGateway = makeHubspotGateway()
    const cursorRepo = makeCursorRepo()

    const odooSourceRun1 = makeSource({ pages: [[so(501, 'cancel', 'no', '2026-08-06 09:00:00')]] })
    const m1 = createSaleOrderStatusSyncModule({ odooSource: odooSourceRun1, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    await m1.runIncremental({})

    const odooSourceRun2 = makeSource({ pages: [[so(501, 'cancel', 'no', '2026-08-07 10:00:00')]] })
    const m2 = createSaleOrderStatusSyncModule({ odooSource: odooSourceRun2, mappingRepository, hubspotGateway, cursorRepo, logger: makeLogger() })
    await m2.runIncremental({})

    expect(hubspotGateway.revertDealStage).toHaveBeenCalledTimes(2)
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
