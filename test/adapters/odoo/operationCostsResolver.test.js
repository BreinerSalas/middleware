import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { pickOperationCostForCountry } = require('../../../src/adapters/outbound/odoo/operationCostsResolver.js')

function rec(id, name, countryId = 156) {
  return { id, name, countryId, countryName: 'Mexico', productId: false }
}

describe('pickOperationCostForCountry', () => {
  it('returns null for an empty array', () => {
    expect(pickOperationCostForCountry([], 'Mexico')).toBeNull()
  })

  it('returns null for non-array input', () => {
    expect(pickOperationCostForCountry(null, 'Mexico')).toBeNull()
    expect(pickOperationCostForCountry(undefined, 'Mexico')).toBeNull()
  })

  it('returns the single record without ambiguity when only one matches', () => {
    const records = [rec(71, 'DDP Mexico')]
    const result = pickOperationCostForCountry(records, 'Mexico')
    expect(result).toEqual({
      id: 71,
      name: 'DDP Mexico',
      matches: 1,
      ids: [71],
      ambiguous: false
    })
  })

  it('prefers the exact DDP match when one exists among multiple records', () => {
    const records = [
      rec(113, 'EXW Mexico (con DUCA)'),
      rec(71, 'DDP Mexico'),
      rec(116, 'CIP Mexico')
    ]
    const result = pickOperationCostForCountry(records, 'Mexico')
    expect(result).toEqual({
      id: 71,
      name: 'DDP Mexico',
      matches: 3,
      ids: [113, 71, 116],
      ambiguous: false,
      reason: 'ddp_exact_match'
    })
  })

  it('ignores DDP variant suffixes (0, Aereo, con Duca, sin Duca, Seguro + Impuestos)', () => {
    const records = [
      rec(71, 'DDP Mexico'),
      rec(150, 'DDP Mexico 0'),
      rec(160, 'DDP Mexico Aereo'),
      rec(161, 'DDP Mexico con Duca'),
      rec(162, 'DDP Mexico sin Duca'),
      rec(163, 'DDP Mexico Seguro + Impuestos')
    ]
    const result = pickOperationCostForCountry(records, 'Mexico')
    expect(result.id).toBe(71)
    expect(result.name).toBe('DDP Mexico')
    expect(result.ambiguous).toBe(false)
    expect(result.reason).toBe('ddp_exact_match')
  })

  it('falls back to the lowest id when no DDP-prefixed record matches the country', () => {
    const records = [
      rec(116, 'CIP Mexico'),
      rec(124, 'EXW Mexico con DUCA')
    ]
    const result = pickOperationCostForCountry(records, 'Mexico')
    expect(result).toEqual({
      id: 116,
      name: 'CIP Mexico',
      matches: 2,
      ids: [116, 124],
      ambiguous: true,
      reason: 'no_ddp_exact_match'
    })
  })

  it('matches country name case-insensitively and ignoring diacritics', () => {
    const records = [
      rec(71, 'DDP MEXICO'),
      rec(116, 'CIP mexico')
    ]
    const result = pickOperationCostForCountry(records, 'México')
    expect(result.id).toBe(71)
    expect(result.name).toBe('DDP MEXICO')
    expect(result.ambiguous).toBe(false)
    expect(result.reason).toBe('ddp_exact_match')
  })

  it('falls back when countryName is null and multiple records exist', () => {
    const records = [
      rec(71, 'DDP Mexico'),
      rec(116, 'CIP Mexico')
    ]
    const result = pickOperationCostForCountry(records, null)
    expect(result.id).toBe(71)
    expect(result.ambiguous).toBe(true)
    expect(result.reason).toBe('country_name_required')
    expect(result.matches).toBe(2)
  })

  it('falls back when countryName is an empty string and multiple records exist', () => {
    const records = [
      rec(71, 'DDP Mexico'),
      rec(116, 'CIP Mexico')
    ]
    const result = pickOperationCostForCountry(records, '')
    expect(result.ambiguous).toBe(true)
    expect(result.reason).toBe('country_name_required')
  })

  it('carries the charges of the resolved record through when only one matches', () => {
    const withCharges = { ...rec(71, 'DDP Mexico'), charges: { extraCharges: 33, financing: 0.085 } }
    const result = pickOperationCostForCountry([withCharges], 'Mexico')
    expect(result.charges).toEqual({ extraCharges: 33, financing: 0.085 })
  })

  it('carries the charges of the exact DDP match through among multiple records', () => {
    const records = [
      { ...rec(116, 'CIP Mexico'), charges: { extraCharges: 999 } },
      { ...rec(71, 'DDP Mexico'), charges: { extraCharges: 33, financing: 0.085 } }
    ]
    const result = pickOperationCostForCountry(records, 'Mexico')
    expect(result.id).toBe(71)
    expect(result.charges).toEqual({ extraCharges: 33, financing: 0.085 })
  })

  it('carries the charges of the fallback lowest-id record through when ambiguous', () => {
    const records = [
      { ...rec(116, 'CIP Mexico'), charges: { extraCharges: 12 } },
      { ...rec(124, 'EXW Mexico con DUCA'), charges: { extraCharges: 99 } }
    ]
    const result = pickOperationCostForCountry(records, 'Mexico')
    expect(result.id).toBe(116)
    expect(result.charges).toEqual({ extraCharges: 12 })
  })
})
