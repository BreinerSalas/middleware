import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mustHaveLineItems, mustHaveOdooCustomerId, mustBeClosedWon } = require('../../src/composition/validators.js')
const { SkipSyncError } = require('../../src/core/domain/errors.js')

describe('composition/validators', () => {
  describe('mustHaveLineItems', () => {
    it('throws SkipSyncError when line items empty', () => {
      expect(() => mustHaveLineItems({ record: { id: 'D-1', properties: { line_items: [] } } })).toThrow(SkipSyncError)
    })
    it('passes when line items present', () => {
      expect(() => mustHaveLineItems({ record: { id: 'D-1', properties: { line_items: [{ id: 'L-1' }] } } })).not.toThrow()
    })
  })

  describe('mustBeClosedWon', () => {
    it('throws SkipSyncError when not closedwon', () => {
      expect(() => mustBeClosedWon({ record: { id: 'D-1', properties: { dealstage: 'open' } } })).toThrow(/closedwon/)
    })
    it('passes when closedwon', () => {
      expect(() => mustBeClosedWon({ record: { id: 'D-1', properties: { dealstage: 'closedwon' } } })).not.toThrow()
    })
    it('handles missing stage', () => {
      expect(() => mustBeClosedWon({ record: { id: 'D-1', properties: {} } })).toThrow(/closedwon/)
    })
  })

  describe('mustHaveOdooCustomerId', () => {
    it('passes when direct property present', () => {
      expect(() => mustHaveOdooCustomerId({ record: { properties: { id_cliente_odoo: '42' } }, references: {} })).not.toThrow()
    })
    it('passes when references.odooCustomerId present', () => {
      expect(() => mustHaveOdooCustomerId({ record: { properties: {} }, references: { odooCustomerId: '42' } })).not.toThrow()
    })
    it('throws transient error when neither', () => {
      try {
        mustHaveOdooCustomerId({ record: { properties: {} }, references: {} })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err.transient).toBe(true)
        expect(err.code).toBe('MISSING_ODOO_CUSTOMER_ID')
      }
    })
  })
})
