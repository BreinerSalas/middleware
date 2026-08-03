import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { normalizeProductName } = require('../../../src/adapters/outbound/odoo/productNameKey.js')

describe('normalizeProductName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeProductName('  CLIPSTRIPS P&G  ')).toBe('clipstrips p&g')
  })

  it('collapses interior whitespace runs into a single space', () => {
    expect(normalizeProductName('FOO   BAR\tBAZ')).toBe('foo bar baz')
  })

  it('lowercases', () => {
    expect(normalizeProductName('Display DE Piso')).toBe('display de piso')
  })

  it('returns empty string for null and undefined', () => {
    expect(normalizeProductName(null)).toBe('')
    expect(normalizeProductName(undefined)).toBe('')
  })

  it('stringifies non-string values', () => {
    expect(normalizeProductName(42)).toBe('42')
  })

  it('returns empty string for a blank-only value', () => {
    expect(normalizeProductName('   ')).toBe('')
  })

  it('matches a padded mixed-case HubSpot name against an upper-case Odoo name', () => {
    expect(normalizeProductName('  Wow Cabecera   de Gondola ')).toBe(
      normalizeProductName('WOW CABECERA DE GONDOLA')
    )
  })
})
