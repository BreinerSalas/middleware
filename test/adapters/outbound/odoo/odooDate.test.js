import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { parseOdooDateUtc, formatOdooDateUtc } = require('../../../../src/adapters/outbound/odoo/odooDate.js')

describe('odooDate (Fase 3 — docs/plan-cambios-2026-08-05.md)', () => {
  it('parseOdooDateUtc interprets the naive string as UTC', () => {
    expect(parseOdooDateUtc('2026-08-05 09:00:00')).toBe(Date.UTC(2026, 7, 5, 9, 0, 0))
  })

  it('parseOdooDateUtc returns null for falsy input', () => {
    expect(parseOdooDateUtc(null)).toBeNull()
    expect(parseOdooDateUtc(false)).toBeNull()
    expect(parseOdooDateUtc('')).toBeNull()
  })

  it('formatOdooDateUtc pads single-digit month/day/hour/minute/second', () => {
    expect(formatOdooDateUtc(Date.UTC(2026, 0, 5, 1, 2, 3))).toBe('2026-01-05 01:02:03')
  })

  it('round-trips through parse then format', () => {
    const str = '2026-08-05 09:30:45'
    expect(formatOdooDateUtc(parseOdooDateUtc(str))).toBe(str)
  })
})
