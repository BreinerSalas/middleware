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
