import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildDealPropertyDefinitions } = require('../../src/composition/dealPropertyDefinitions.js')

describe('buildDealPropertyDefinitions', () => {
  it('returns six entries with names sourced from config', () => {
    const defs = buildDealPropertyDefinitions({
      propertyOdooOrderId: 'id_orden_odoo',
      propertyOdooCustomerId: 'id_cliente_odoo',
      propertyOdooQuoteId: 'id_presupuesto_odoo',
      propertyQuoteState: 'estado_presupuesto_odoo',
      propertyQuoteInvoiceStatus: 'estado_facturacion_odoo',
      propertyManufacturingOrder: 'numero_orden_fabricacion'
    })
    expect(defs).toHaveLength(6)
    expect(defs.map((d) => d.name)).toEqual([
      'id_orden_odoo', 'id_cliente_odoo', 'id_presupuesto_odoo',
      'estado_presupuesto_odoo', 'estado_facturacion_odoo', 'numero_orden_fabricacion'
    ])
  })

  it('defaults the fallback-mode properties (Fase 6 — deals sin cotización elegible)', () => {
    const defs = buildDealPropertyDefinitions({})
    expect(defs[3].name).toBe('estado_presupuesto_odoo')
    expect(defs[4].name).toBe('estado_facturacion_odoo')
    expect(defs[5].name).toBe('numero_orden_fabricacion')
  })

  it('every entry uses string + text + dealinformation group', () => {
    const defs = buildDealPropertyDefinitions({
      propertyOdooOrderId: 'a', propertyOdooCustomerId: 'b', propertyOdooQuoteId: 'c'
    })
    for (const d of defs) {
      expect(d.type).toBe('string')
      expect(d.fieldType).toBe('text')
      expect(d.groupName).toBe('dealinformation')
    }
  })

  it('id_presupuesto_odoo description mentions quote + MO generation flow', () => {
    const defs = buildDealPropertyDefinitions({
      propertyOdooOrderId: 'a', propertyOdooCustomerId: 'b', propertyOdooQuoteId: 'c'
    })
    const quote = defs.find((d) => d.name === 'c')
    expect(quote.label).toBe('ID Presupuesto Odoo')
    expect(quote.description).toMatch(/presupuesto|orden de fabricacion/i)
  })
})
