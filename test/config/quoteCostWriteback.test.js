import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { load, OPTIONAL_KEYS } = require('../../src/config/index.js')

const baseEnv = {
  HS_ALLOWED_STAGE_IDS: '1409249445',
  HS_ALLOWED_PIPELINE_IDS: 'pipe-1',
  HS_CLOSED_WON_STAGE_ID: '1409249445',
  MONGODB_URI: 'mongodb://localhost:27017/x',
  HUBSPOT_ACCESS_TOKEN: 'tok',
  HUBSPOT_CLIENT_SECRET: 'my-secret'
}

describe('quoteCostWriteback config', () => {
  it('is disabled by default', () => {
    expect(load({ env: baseEnv }).quoteCostWriteback.enabled).toBe(false)
  })

  it('enables only on QUOTE_COST_WRITEBACK_ENABLED=true', () => {
    expect(load({ env: { ...baseEnv, QUOTE_COST_WRITEBACK_ENABLED: 'true' } }).quoteCostWriteback.enabled).toBe(true)
    expect(load({ env: { ...baseEnv, QUOTE_COST_WRITEBACK_ENABLED: 'yes' } }).quoteCostWriteback.enabled).toBe(false)
  })

  it('whitelists the flag in OPTIONAL_KEYS', () => {
    expect(OPTIONAL_KEYS).toContain('QUOTE_COST_WRITEBACK_ENABLED')
  })

  it('defaults the 10 HubSpot quote cost property names', () => {
    expect(load({ env: baseEnv }).hubspot.propertyQuoteCosts).toEqual({
      extraCharges: 'cargos_extra_aduana',
      scannerCharge: 'gastos_duca_escaner',
      destinationProcess: 'honorarios_agencia',
      documentsShipping: 'costo_envio_doctos',
      transferCost: 'costo_trsf_enviada',
      receivedTransfer: 'costo_trsf_recibida',
      financing: 'porcentaje_financiamiento',
      ivaRate: 'porcentaje_iva',
      insuranceRate: 'porcentaje_seguro',
      daiRate: 'porcentaje_dai'
    })
  })

  it('allows overriding a property name by env', () => {
    const cfg = load({ env: { ...baseEnv, HS_PROPERTY_QUOTE_COST_DAI_RATE: 'dai_custom', HS_PROPERTY_QUOTE_COST_EXTRA_CHARGES: 'extra_custom' } })
    expect(cfg.hubspot.propertyQuoteCosts.daiRate).toBe('dai_custom')
    expect(cfg.hubspot.propertyQuoteCosts.extraCharges).toBe('extra_custom')
    expect(cfg.hubspot.propertyQuoteCosts.ivaRate).toBe('porcentaje_iva')
  })
})
