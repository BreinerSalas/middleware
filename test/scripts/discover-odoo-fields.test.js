import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { normalize, rankCandidates, toTsv } = require('../../scripts/probes/discover-odoo-fields.js')

const fieldsByModel = {
  'sale.order': {
    commitment_date: { string: 'Fecha prevista', type: 'datetime', store: true, readonly: false },
    date_order: { string: 'Order Date', type: 'datetime', store: true, readonly: false },
    name: { string: 'Reference', type: 'char', store: true, readonly: true }
  },
  'mrp.production': {
    date_planned_start: { string: 'Planned date', type: 'datetime', store: true, readonly: false },
    date_deadline: { string: 'Deadline Date', type: 'datetime', store: true, readonly: false }
  }
}

describe('normalize', () => {
  it('lowercases and strips accents', () => {
    expect(normalize('Fecha Prevista')).toBe('fecha prevista')
    expect(normalize('Comisión ÁÉÍÓÚ ñ')).toBe('comision aeiou n')
  })

  it('tolerates non-string input', () => {
    expect(normalize(undefined)).toBe('')
    expect(normalize(false)).toBe('')
  })
})

describe('rankCandidates', () => {
  it('matches accent-insensitively over label', () => {
    const res = rankCandidates(fieldsByModel, ['prevista'], 8)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ model: 'sale.order', field: 'commitment_date', label: 'Fecha prevista', type: 'datetime', store: true })
  })

  it('matches keywords accent-insensitively too', () => {
    const res = rankCandidates(fieldsByModel, ['PREVISTÁ'], 8)
    expect(res.map((r) => r.field)).toEqual(['commitment_date'])
  })

  it('sorts by hits desc then model/field asc', () => {
    const res = rankCandidates(fieldsByModel, ['fecha', 'date', 'planned', 'deadline'], 8)
    expect(res.map((r) => `${r.model}.${r.field}:${r.hits}`)).toEqual([
      'mrp.production.date_deadline:2',
      'mrp.production.date_planned_start:2',
      'sale.order.commitment_date:2',
      'sale.order.date_order:1'
    ])
  })

  it('breaks ties by model then field', () => {
    const res = rankCandidates(fieldsByModel, ['date'], 8)
    const ties = res.filter((r) => r.hits === res[0].hits).map((r) => `${r.model}.${r.field}`)
    expect(ties).toEqual([...ties].sort())
  })

  it('respects the limit', () => {
    const res = rankCandidates(fieldsByModel, ['date'], 2)
    expect(res).toHaveLength(2)
  })

  it('excludes zero-hit fields', () => {
    const res = rankCandidates(fieldsByModel, ['date'], 8)
    expect(res.find((r) => r.field === 'name')).toBeUndefined()
  })
})

describe('toTsv', () => {
  it('emits a header row and one row per field', () => {
    const lines = toTsv({
      'sale.order': {
        partner_id: { string: 'Customer', type: 'many2one', relation: 'res.partner', store: true, readonly: false }
      },
      'operation.costs': {
        iva: { string: 'IVA', type: 'float', store: false, readonly: true }
      }
    }).split('\n')
    expect(lines[0]).toBe('model\tfield\tlabel\ttype\trelation\tstore\treadonly')
    expect(lines[1]).toBe('sale.order\tpartner_id\tCustomer\tmany2one\tres.partner\ttrue\tfalse')
    expect(lines[2]).toBe('operation.costs\tiva\tIVA\tfloat\t\tfalse\ttrue')
    expect(lines).toHaveLength(3)
  })

  it('strips tabs and newlines from labels', () => {
    const out = toTsv({ m: { f: { string: 'a\tb\nc', type: 'char', store: true, readonly: false } } })
    expect(out.split('\n')).toHaveLength(2)
    expect(out.split('\n')[1].split('\t')).toHaveLength(7)
  })
})
