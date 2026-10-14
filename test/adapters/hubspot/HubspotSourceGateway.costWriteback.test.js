import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotSourceGateway } = require('../../../src/adapters/outbound/hubspot/HubspotSourceGateway.js')

const CHARGES = {
  extraCharges: 33, scannerCharge: 46.5, destinationProcess: 200, documentsShipping: 40,
  transferCost: 35, receivedTransfer: 0, financing: 0.085, ivaRate: 0.13, insuranceRate: 0.01, daiRate: 0.05
}
const EXPECTED = {
  cargos_extra_aduana: '33',
  gastos_duca_escaner: '46.5',
  honorarios_agencia: '200',
  costo_envio_doctos: '40',
  costo_trsf_enviada: '35',
  costo_trsf_recibida: '0',
  porcentaje_financiamiento: '0.085',
  porcentaje_iva: '0.13',
  porcentaje_seguro: '0.01',
  porcentaje_dai: '0.05'
}
const COST_PROPS = {
  extraCharges: 'cargos_extra_aduana', scannerCharge: 'gastos_duca_escaner', destinationProcess: 'honorarios_agencia',
  documentsShipping: 'costo_envio_doctos', transferCost: 'costo_trsf_enviada', receivedTransfer: 'costo_trsf_recibida',
  financing: 'porcentaje_financiamiento', ivaRate: 'porcentaje_iva', insuranceRate: 'porcentaje_seguro', daiRate: 'porcentaje_dai'
}

function build({ enabled = true, updateQuote = async () => ({}), propertyQuoteCosts = COST_PROPS } = {}) {
  const api = { updateQuote: vi.fn(updateQuote), updateDeal: vi.fn(async () => ({})) }
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const gw = new HubspotSourceGateway({
    apiClient: api, logger, quoteCostWritebackEnabled: enabled, propertyQuoteCosts
  })
  return { gw, api, logger }
}

describe('HubspotSourceGateway quote cost write-back', () => {
  it('flag off: no second updateQuote call', async () => {
    const { gw, api } = build({ enabled: false })
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: CHARGES })
    expect(api.updateQuote).toHaveBeenCalledTimes(1)
    expect(api.updateQuote).toHaveBeenCalledWith('Q-1', { id_presupuesto_odoo: 'S1' })
  })

  it('flag on + charges: second call carries exactly the 10 string properties', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: CHARGES })
    expect(api.updateQuote).toHaveBeenCalledTimes(2)
    expect(api.updateQuote.mock.calls[0]).toEqual(['Q-1', { id_presupuesto_odoo: 'S1' }])
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', EXPECTED])
  })

  it('does not put quote_costs into the main write-back properties', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: CHARGES })
    expect(Object.keys(api.updateQuote.mock.calls[0][1])).toEqual(['id_presupuesto_odoo'])
  })

  it('skips silently when there are no charges', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1' })
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S2', quote_costs: null })
    expect(api.updateQuote).toHaveBeenCalledTimes(2)
  })

  it('skips charges that are null or non numeric, sending only the rest', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: { extraCharges: 5, ivaRate: null, daiRate: undefined } })
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', { cargos_extra_aduana: '5' }])
  })

  it('skips the second call for a deal-only source id (no quote)', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1', { id_orden_odoo: 'PO-1', quote_costs: CHARGES })
    expect(api.updateQuote).not.toHaveBeenCalled()
  })

  it('swallows a failing cost call: first write-back completed, warn logged, no throw', async () => {
    let n = 0
    const { gw, api, logger } = build({ updateQuote: async () => { n += 1; if (n === 2) throw new Error('PROPERTY_DOESNT_EXIST') } })
    await expect(gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: CHARGES })).resolves.toBeUndefined()
    expect(api.updateQuote).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('hubspot.writeBack', expect.objectContaining({ quoteId: 'Q-1' }))
    expect(logger.warn).toHaveBeenCalledWith('hubspot.quoteCostWriteback.failed', expect.objectContaining({ sourceId: 'D-1:qQ-1', error: 'PROPERTY_DOESNT_EXIST' }))
  })

  it('a failing first write-back still propagates and no cost call is made', async () => {
    const { gw, api } = build({ updateQuote: async () => { throw new Error('boom') } })
    await expect(gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: CHARGES })).rejects.toThrow('boom')
    expect(api.updateQuote).toHaveBeenCalledTimes(1)
  })

  it('uses configured property names', async () => {
    const { gw, api } = build({ propertyQuoteCosts: { ...COST_PROPS, daiRate: 'dai_custom' } })
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: { daiRate: 0.05 } })
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', { dai_custom: '0.05' }])
  })

  it('defaults to the standard property names when none are configured', async () => {
    const api = { updateQuote: vi.fn(async () => ({})) }
    const gw = new HubspotSourceGateway({ apiClient: api, quoteCostWritebackEnabled: true })
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1', quote_costs: { ivaRate: 0.13 } })
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', { porcentaje_iva: '0.13' }])
  })
})
