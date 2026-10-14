import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { QUOTE_PROPERTIES, STATUSES, findUnmatched } = require('../../scripts/probes/quote-odoo-crosscheck.js')

describe('quote-odoo-crosscheck mapping table', () => {
  it('declares exactly 35 HubSpot quote properties', () => {
    expect(QUOTE_PROPERTIES).toHaveLength(35)
  })

  it('has unique property names', () => {
    const names = QUOTE_PROPERTIES.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('uses only known statuses and a label for every entry', () => {
    for (const p of QUOTE_PROPERTIES) {
      expect(STATUSES).toContain(p.status)
      expect(p.label).toBeTruthy()
    }
  })

  it('gives every odoo_* status a model.field', () => {
    const odoo = QUOTE_PROPERTIES.filter((p) => p.status.startsWith('odoo_'))
    expect(odoo.length).toBeGreaterThan(0)
    for (const p of odoo) {
      expect(p.odoo).toMatch(/^[a-z_.]+\.[a-z_]+$/)
    }
  })

  it('maps operation.costs statuses to the operation.costs model and sale order ones to sale.order', () => {
    for (const p of QUOTE_PROPERTIES) {
      if (p.status === 'odoo_operation_costs') expect(p.odoo.startsWith('operation.costs.')).toBe(true)
      if (p.status === 'odoo_sale_order') expect(p.odoo.startsWith('sale.order.')).toBe(true)
    }
  })

  const byName = (n) => QUOTE_PROPERTIES.find((p) => p.name === n)

  it('maps the seven discovered candidates', () => {
    expect(byName('prod_monto')).toMatchObject({ status: 'odoo_sale_order', odoo: 'sale.order.amount_untaxed' })
    expect(byName('comercial')).toMatchObject({ status: 'odoo_sale_order', odoo: 'sale.order.user_id' })
    expect(byName('forma_pago')).toMatchObject({ status: 'odoo_sale_order', odoo: 'sale.order.payment_term_id' })
    expect(byName('flete_monto')).toMatchObject({ status: 'odoo_sale_order', odoo: 'sale.order.freight' })
    expect(byName('fecha_entrega_estimada')).toMatchObject({
      status: 'odoo_sale_order',
      odoo: 'sale.order.commitment_date',
      alternate: 'mrp.production.date_planned_start'
    })
    expect(byName('unidad_medida')).toMatchObject({
      status: 'odoo_sale_order_line',
      odoo: 'sale.order.line.product_uom',
      alternate: 'mrp.production.product_uom_id'
    })
    expect(byName('otros_cargos')).toMatchObject({ status: 'manual_input', odoo: null })
  })

  it('accepts manual_input and odoo_sale_order_line as statuses and leaves no no_known_match', () => {
    expect(STATUSES).toContain('manual_input')
    expect(STATUSES).toContain('odoo_sale_order_line')
    expect(QUOTE_PROPERTIES.filter((p) => p.status === 'no_known_match')).toHaveLength(0)
  })

  it('keeps alternates well-formed and only on odoo_* rows', () => {
    const withAlt = QUOTE_PROPERTIES.filter((p) => p.alternate)
    expect(withAlt.map((p) => p.name).sort()).toEqual(['fecha_entrega_estimada', 'unidad_medida'])
    for (const p of withAlt) {
      expect(p.alternate).toMatch(/^[a-z_.]+\.[a-z_]+$/)
      expect(p.status.startsWith('odoo_')).toBe(true)
    }
  })

  it('maps sale order line statuses to the sale.order.line model', () => {
    for (const p of QUOTE_PROPERTIES.filter((q) => q.status === 'odoo_sale_order_line')) {
      expect(p.odoo.startsWith('sale.order.line.')).toBe(true)
    }
  })

  it('findUnmatched excludes manual_input and ignores alternates', () => {
    const rows = [
      { name: 'a', status: 'manual_input', exists: null },
      { name: 'b', status: 'odoo_sale_order_line', exists: false },
      { name: 'c', status: 'odoo_sale_order', exists: true, alternateExists: false }
    ]
    expect(findUnmatched(rows).map((r) => r.name)).toEqual(['b'])
  })

  it('findUnmatched lists no_known_match properties and mapped fields missing in Odoo', () => {
    const rows = [
      { name: 'a', status: 'no_known_match', exists: null },
      { name: 'b', status: 'odoo_operation_costs', exists: false },
      { name: 'c', status: 'odoo_operation_costs', exists: true },
      { name: 'd', status: 'calculated_in_hubspot', exists: null }
    ]
    expect(findUnmatched(rows).map((r) => r.name)).toEqual(['a', 'b'])
  })
})
