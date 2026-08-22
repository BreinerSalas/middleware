import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  QUOTE_COUNTRY_UNSET,
  isUnsetQuoteCountry,
  classifyQuoteCountryValue
} = require('../../../src/core/domain/quoteCountryValue.js')

describe('quoteCountryValue (domain)', () => {
  it('exports the sentinel value used by the HubSpot dropdown', () => {
    expect(QUOTE_COUNTRY_UNSET).toBe('sin_definir')
  })

  describe('classifyQuoteCountryValue', () => {
    it('classifies null as absent', () => {
      expect(classifyQuoteCountryValue(null)).toEqual({
        kind: 'absent',
        value: '',
        operationCostId: null
      })
    })

    it('classifies undefined as absent', () => {
      expect(classifyQuoteCountryValue(undefined)).toEqual({
        kind: 'absent',
        value: '',
        operationCostId: null
      })
    })

    it('classifies an empty string as absent', () => {
      expect(classifyQuoteCountryValue('')).toEqual({
        kind: 'absent',
        value: '',
        operationCostId: null
      })
    })

    it('classifies a whitespace-only string as absent', () => {
      expect(classifyQuoteCountryValue('   ')).toEqual({
        kind: 'absent',
        value: '',
        operationCostId: null
      })
    })

    it('classifies the literal sentinel "sin_definir" as unset', () => {
      expect(classifyQuoteCountryValue('sin_definir')).toEqual({
        kind: 'unset',
        value: 'sin_definir',
        operationCostId: null
      })
    })

    it('classifies "sin_definir" case-insensitively and trims surrounding whitespace', () => {
      expect(classifyQuoteCountryValue('  SIN_DEFINIR  ')).toEqual({
        kind: 'unset',
        value: 'SIN_DEFINIR',
        operationCostId: null
      })
    })

    it('classifies a trimmed two-letter uppercase code as legacy_iso', () => {
      expect(classifyQuoteCountryValue(' CR ')).toEqual({
        kind: 'legacy_iso',
        value: 'CR',
        operationCostId: null
      })
    })

    it('classifies a lowercase two-letter code as legacy_iso (case-insensitive)', () => {
      expect(classifyQuoteCountryValue('cr')).toEqual({
        kind: 'legacy_iso',
        value: 'cr',
        operationCostId: null
      })
    })

    it('classifies a positive numeric string as operation_cost_id', () => {
      expect(classifyQuoteCountryValue('78')).toEqual({
        kind: 'operation_cost_id',
        value: '78',
        operationCostId: 78
      })
    })

    it('classifies "0" as unrecognized because it is not a positive integer', () => {
      expect(classifyQuoteCountryValue('0')).toEqual({
        kind: 'unrecognized',
        value: '0',
        operationCostId: null
      })
    })

    it('classifies "78abc" as unrecognized because it is not purely numeric', () => {
      expect(classifyQuoteCountryValue('78abc')).toEqual({
        kind: 'unrecognized',
        value: '78abc',
        operationCostId: null
      })
    })

    it('classifies an arbitrary three-letter string as unrecognized', () => {
      expect(classifyQuoteCountryValue('USA')).toEqual({
        kind: 'unrecognized',
        value: 'USA',
        operationCostId: null
      })
    })

    it('never throws for any input', () => {
      expect(() => classifyQuoteCountryValue({})).not.toThrow()
      expect(() => classifyQuoteCountryValue(42)).not.toThrow()
      expect(() => classifyQuoteCountryValue([])).not.toThrow()
    })
  })

  describe('isUnsetQuoteCountry', () => {
    it('returns true for null', () => {
      expect(isUnsetQuoteCountry(null)).toBe(true)
    })

    it('returns true for undefined', () => {
      expect(isUnsetQuoteCountry(undefined)).toBe(true)
    })

    it('returns true for an empty string', () => {
      expect(isUnsetQuoteCountry('')).toBe(true)
    })

    it('returns true for a whitespace-only string', () => {
      expect(isUnsetQuoteCountry('   ')).toBe(true)
    })

    it('returns true for the literal sentinel "sin_definir"', () => {
      expect(isUnsetQuoteCountry('sin_definir')).toBe(true)
    })

    it('returns true for "sin_definir" regardless of case and surrounding whitespace', () => {
      expect(isUnsetQuoteCountry('  SIN_DEFINIR  ')).toBe(true)
    })

    it('returns false for a legacy ISO code', () => {
      expect(isUnsetQuoteCountry('CR')).toBe(false)
    })

    it('returns false for a numeric operation.costs id', () => {
      expect(isUnsetQuoteCountry('78')).toBe(false)
    })

    it('returns false for an unrecognized value', () => {
      expect(isUnsetQuoteCountry('78abc')).toBe(false)
    })
  })
})
